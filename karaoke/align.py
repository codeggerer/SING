"""
Alignment & timing stage for AI Karaoke Pipeline (PLAN.md Phase 4).

Includes:
- MMS CTC Forced Aligner (wav2vec2 multilingual) with line-windowed priors (±1.5s margin)
- Character-level and vowel-nucleus weighted syllable timing distribution (Task 2)
- Audio-based syllable start snapping via vocal onset strength & f0 transitions (Task 3)
- Note end pruning via voiced frame tracking & silent gap protection (Task 5)
- Automatic phrase grouping & line-break tagging (Task 6)
"""

from __future__ import annotations
import os
import re
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import numpy as np

try:
    import torch
    import torchaudio
except ImportError:
    torch = None
    torchaudio = None

try:
    import librosa
except ImportError:
    librosa = None

try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import scipy.signal
    import scipy.ndimage
except ImportError:
    pass

from karaoke.config import (
    ONSET_SNAP_WINDOW_SEC,
    SILENT_GAP_NOTE_END_SEC,
    VOICED_TAIL_MARGIN_SEC,
    PAUSE_BREAK_THRESHOLD_SEC,
    LINE_MAX_WORDS,
    MIN_NOTE_DUR_BEATS,
    BEAT_DUR_SEC,
)
from karaoke.lyrics_io import split_syllables, count_phonetic_syllables
from karaoke.hardware import HardwareProfile, detect_hardware


from karaoke.align_mms import (
    MMS_VALID_CHARS,
    spell_number,
    clean_word_for_mms,
    clean_raw_lyrics_lines,
    MMSForcedAligner,
    load_mms_pipeline,
    forced_align_words,
    align_plain_lyrics_mms,
    align_lyrics_doc_mms,
    align_whisper_words_mms,
    find_vowel_nucleus_from_char_spans,
    compute_vowel_nucleus_onset,
)


# ==============================================================================
# 3. Audio Loading Helper
# ==============================================================================

def load_audio_mono(audio_path: Path | str, target_sr: int = 16000) -> Tuple[np.ndarray, int]:
    """Loads audio as float32 mono at target_sr."""
    path_str = str(audio_path)
    if sf is not None:
        try:
            data, sr = sf.read(path_str, dtype="float32")
            if data.ndim > 1:
                data = np.mean(data, axis=1)
            if sr != target_sr:
                if librosa is not None:
                    data = librosa.resample(data, orig_sr=sr, target_sr=target_sr)
                else:
                    raise RuntimeError("librosa is required for resampling.")
            return data, target_sr
        except Exception:
            pass

    if librosa is not None:
        data, sr = librosa.load(path_str, sr=target_sr, mono=True)
        return data, sr

    raise RuntimeError(f"Could not load audio file: {path_str}")


# ==============================================================================
# 4. Syllable Timing Distribution (Task 2)
# ==============================================================================

VOWELS_REGEX = re.compile(r'[aeiouyäöüAEIOUYÄÖÜ]')


def segment_word_syllables_acoustically(
    syllables: List[str],
    start: float,
    end: float,
    vocal_audio: Optional[np.ndarray],
    sr: int = 16000,
    lang: str = "de",
) -> Optional[List[Dict[str, Any]]]:
    """
    Phase 4: Formant & Energy-Based Syllable Boundary Detection.
    - Extracts RMS energy and spectral flux across the word window at 10ms resolution.
    - Finds N dominant energy peaks corresponding to the N phonetic vowel nuclei.
    - Places syllable boundaries at local energy valleys (minima) between consecutive peaks.
    Guarantees:
    - Held syllables naturally capture wide energy plateaus.
    - Fast unstressed syllables narrow to their actual acoustic bursts.
    - Returns None on missing audio / silence to fall back to vowel nucleus weighting.
    """
    N = len(syllables)
    if N <= 1:
        return None

    if vocal_audio is None or len(vocal_audio) == 0 or librosa is None:
        return None

    total_dur = max(0.030, end - start)
    # Check if vocal_audio is full track or chunk
    if len(vocal_audio) > int((total_dur + 0.5) * sr) and start >= 0:
        start_samp = max(0, int(round(start * sr)))
        end_samp = min(len(vocal_audio), int(round(end * sr)))
        vocal_chunk = vocal_audio[start_samp:end_samp]
    else:
        vocal_chunk = vocal_audio

    if len(vocal_chunk) < 320:
        return None

    hop_length = int(round(0.010 * sr))
    frame_length = 2 * hop_length
    try:
        rms = librosa.feature.rms(y=vocal_chunk, frame_length=frame_length, hop_length=hop_length)[0]
    except Exception:
        return None

    try:
        flux = librosa.onset.onset_strength(y=vocal_chunk, sr=sr, hop_length=hop_length)
    except Exception:
        flux = np.zeros_like(rms)

    min_len = min(len(rms), len(flux))
    if min_len < 3 * N:  # Need at least 30ms per syllable
        return None

    rms = rms[:min_len]
    flux = flux[:min_len]
    max_rms = float(np.max(rms))
    if max_rms < 1e-4:
        return None

    import scipy.signal
    import scipy.ndimage

    smoothed_rms = scipy.ndimage.gaussian_filter1d(rms, sigma=1.5)
    rms_max = float(np.max(smoothed_rms)) + 1e-8
    flux_max = float(np.max(flux)) + 1e-8
    flux_norm = flux / flux_max

    cost = (rms_max - smoothed_rms) + 0.25 * rms_max * flux_norm
    min_dist = max(3, int(min_len / (N * 2.0)))
    valleys, props = scipy.signal.find_peaks(cost, distance=min_dist, prominence=max_rms * 0.04)

    K = len(valleys)
    needed = N - 1
    if K == needed:
        selected_valleys = list(valleys)
    elif K > needed:
        proms = props["prominences"]
        top_idx = sorted(range(K), key=lambda i: proms[i], reverse=True)[:needed]
        selected_valleys = sorted([valleys[i] for i in top_idx])
    else:
        # Fewer than needed valleys found: find peaks per sector and place boundary at local minimum
        weights = []
        for syl in syllables:
            s_clean = syl.lower()
            has_vowel = bool(VOWELS_REGEX.search(s_clean))
            base_w = 1.0 if has_vowel else 0.5
            onset_m = re.match(r'^[^aeiouyäöü]+', s_clean)
            onset_c = len(onset_m.group(0)) if onset_m else 0
            weights.append(base_w + 0.15 * onset_c)
        tot_w = sum(weights) or 1.0
        norm_w = [w / tot_w for w in weights]

        seg_bounds = [0]
        cur_f = 0.0
        for nw in norm_w:
            cur_f += nw * min_len
            seg_bounds.append(int(round(cur_f)))
        seg_bounds[-1] = min_len

        peaks = []
        for k in range(N):
            fs, fe = seg_bounds[k], seg_bounds[k+1]
            if fe > fs:
                p_rel = np.argmax(smoothed_rms[fs:fe])
                peaks.append(fs + p_rel)
            else:
                peaks.append(fs)
        for k in range(1, len(peaks)):
            if peaks[k] <= peaks[k-1]:
                peaks[k] = min(min_len - 1, peaks[k-1] + 2)

        selected_valleys = []
        prev_v = 0
        for k in range(N - 1):
            p1, p2 = peaks[k], peaks[k+1]
            if p2 > p1:
                v_rel = np.argmin(smoothed_rms[p1:p2+1])
                v = p1 + v_rel
            else:
                v = p1 + 1
            min_f = prev_v + 3
            max_f = min_len - 3 * (N - 1 - k)
            v = max(min_f, min(max_f, v))
            selected_valleys.append(v)
            prev_v = v

    result = []
    curr_start = start
    for s_idx, syl in enumerate(syllables):
        if s_idx == N - 1:
            s_end = end
        else:
            s_end = round(start + selected_valleys[s_idx] * 0.010, 3)

        s_dur = max(0.030, s_end - curr_start)
        actual_end = round(curr_start + s_dur, 3)
        is_last = (s_idx == N - 1)
        text = f"{syl} " if is_last else f"{syl}-"
        result.append({
            "word": text,
            "start": round(curr_start, 3),
            "end": actual_end,
            "is_syllable": True,
        })
        curr_start = actual_end

    return result


def distribute_word_syllables(
    word: str,
    start: float,
    end: float,
    lang: str = "de",
    char_spans: Optional[List[Tuple[str, float, float]]] = None,
    is_last_in_phrase: bool = False,
    has_pause_after: bool = False,
    vocal_audio: Optional[np.ndarray] = None,
    sr: int = 16000,
) -> List[Dict[str, Any]]:
    """
    Distributes a word's duration across its phonetic syllables.
    - If char_spans (character-level CTC boundaries) are provided and match, uses them.
    - If vocal_audio is provided: extracts RMS energy & spectral flux and segments
      syllable boundaries at energy valleys (Phase 4 acoustic boundary detection).
    - Otherwise (or on fallback), distributes via vowel-nucleus weighted formula.
    """
    total_dur = max(0.030, end - start)
    clean_w = word.strip()
    syllables = split_syllables(clean_w, lang=lang, word_duration=total_dur)
    num_sylls = len(syllables)

    if num_sylls <= 1:
        text = f"{clean_w} " if not clean_w.endswith(" ") else clean_w
        note_start = compute_vowel_nucleus_onset(clean_w, start, end, char_spans=char_spans)
        return [{
            "word": text,
            "start": round(start, 3),
            "note_start": note_start,
            "end": round(end, 3),
            "char_spans": char_spans,
            "is_syllable": True,
        }]

    # Case A: Try character-level CTC spans if available
    if char_spans and len(char_spans) > 0:
        # Check if characters in char_spans can be partitioned among syllables
        syll_char_lens = [len(clean_word_for_mms(s)) for s in syllables]
        if sum(syll_char_lens) == len(char_spans) and all(l > 0 for l in syll_char_lens):
            result = []
            curr_idx = 0
            for s_idx, syl in enumerate(syllables):
                n_chars = syll_char_lens[s_idx]
                s_spans = char_spans[curr_idx:curr_idx + n_chars]
                curr_idx += n_chars
                s_start = s_spans[0][1]
                s_end = s_spans[-1][2]
                is_last = (s_idx == num_sylls - 1)
                text = f"{syl} " if is_last else f"{syl}-"
                note_start = compute_vowel_nucleus_onset(syl, s_start, s_end, char_spans=s_spans)
                result.append({
                    "word": text,
                    "start": round(max(start, s_start), 3),
                    "note_start": round(max(start, note_start), 3),
                    "end": round(min(end + 0.1, max(s_start + 0.030, s_end)), 3),
                    "char_spans": s_spans,
                    "is_syllable": True,
                })
            # Ensure monotonicity
            for i in range(1, len(result)):
                if result[i]["start"] < result[i-1]["end"]:
                    mid = (result[i-1]["start"] + result[i]["end"]) / 2.0
                    result[i-1]["end"] = round(mid, 3)
                    result[i]["start"] = round(mid, 3)
                    if "note_start" in result[i-1]:
                        result[i-1]["note_start"] = min(result[i-1]["note_start"], result[i-1]["end"] - 0.030)
                    if "note_start" in result[i]:
                        result[i]["note_start"] = max(result[i]["start"], result[i]["note_start"])
            return result

    # Case B: Acoustic-driven syllable segmentation (Phase 3)
    if vocal_audio is not None and len(vocal_audio) > 0:
        try:
            from karaoke.syllables_acoustic import slice_word_syllables_acoustically
            acoustic_sylls = slice_word_syllables_acoustically(
                word_item={
                    "word": clean_w,
                    "start": start,
                    "end": end,
                    "line_break_after": is_last_in_phrase,
                },
                vocal_audio_segment=vocal_audio,
                sr=sr,
                lang=lang,
                detect_melisma=False,
            )
            if acoustic_sylls is not None and len(acoustic_sylls) == num_sylls:
                for s in acoustic_sylls:
                    if "note_start" not in s:
                        s["note_start"] = compute_vowel_nucleus_onset(
                            s.get("word", clean_w), s["start"], s["end"], char_spans=s.get("char_spans")
                        )
                return acoustic_sylls
        except Exception:
            pass

    # Case C: Vowel-nucleus weighted split fallback (Task 2 specification)
    weights = []
    for s_idx, syl in enumerate(syllables):
        s_clean = syl.lower()
        has_vowel = bool(VOWELS_REGEX.search(s_clean))
        base_weight = 1.0 if has_vowel else 0.5

        # Count leading onset consonants before first vowel
        onset_match = re.match(r'^[^aeiouyäöü]+', s_clean)
        onset_consonants = len(onset_match.group(0)) if onset_match else 0
        w = base_weight + (0.15 * onset_consonants)

        # Last syllable of word lengthening (+20%)
        if s_idx == num_sylls - 1:
            w *= 1.20

        # Word before pause / phrase end lengthening (+20%)
        if (s_idx == num_sylls - 1) and (is_last_in_phrase or has_pause_after):
            w *= 1.20

        weights.append(w)

    total_weight = sum(weights) or 1.0
    norm_weights = [w / total_weight for w in weights]

    result = []
    curr_start = start
    for s_idx, syl in enumerate(syllables):
        s_dur = total_dur * norm_weights[s_idx]
        s_end = curr_start + s_dur
        is_last = (s_idx == num_sylls - 1)
        text = f"{syl} " if is_last else f"{syl}-"
        note_start = compute_vowel_nucleus_onset(syl, curr_start, s_end, char_spans=None)
        result.append({
            "word": text,
            "start": round(curr_start, 3),
            "note_start": round(max(curr_start, note_start), 3),
            "end": round(s_end, 3),
            "char_spans": None,
            "is_syllable": True,
        })
        curr_start = s_end

    return result


# ==============================================================================
# 5. Audio-Based Snapping of Syllable Starts (Task 3)
# ==============================================================================

def snap_syllables_to_audio(
    syllables: List[Dict[str, Any]],
    vocal_audio: np.ndarray,
    sr: int = 16000,
    pitch_data: Optional[Dict[str, Any]] = None,
    window_sec: float = ONSET_SNAP_WINDOW_SEC,
) -> List[Dict[str, Any]]:
    """
    Snaps syllable start times to the strongest audio evidence within ±window_sec (120ms):
    - (a) Local peak in librosa onset_strength on vocal stem
    - (b) Unvoiced -> voiced transitions in f0 contour
    Never reorders syllables, and guarantees at least 30ms between syllable starts.
    """
    if librosa is None or len(vocal_audio) == 0 or len(syllables) == 0:
        return syllables

    hop_sec = 0.010  # 10ms hop
    hop_length = int(round(hop_sec * sr))

    try:
        onset_env = librosa.onset.onset_strength(y=vocal_audio, sr=sr, hop_length=hop_length)
    except Exception:
        return syllables

    if len(onset_env) == 0:
        return syllables

    # Baseline threshold: 30th percentile of positive onset energy
    pos_env = onset_env[onset_env > 0]
    thresh = float(np.percentile(pos_env, 30)) if len(pos_env) > 0 else 0.1

    # Detect unvoiced -> voiced transition frames if f0 is available
    f0_transition_frames = set()
    if pitch_data:
        pitches = pitch_data.get("midi") if "midi" in pitch_data else pitch_data.get("pitches")
        if pitches is not None:
            for t in range(1, len(pitches)):
                p_prev = pitches[t-1]
                p_curr = pitches[t]
                prev_voiced = (not np.isnan(p_prev)) and (p_prev > 0)
                curr_voiced = (not np.isnan(p_curr)) and (p_curr > 0)
                if not prev_voiced and curr_voiced:
                    f0_transition_frames.add(t)

    window_frames = int(round(window_sec / hop_sec))  # ±12 frames for 120ms
    snapped = []
    prev_start = -1.0

    for i, s in enumerate(syllables):
        orig_s = float(s["start"])
        orig_e = float(s["end"])
        target_frame = int(round(orig_s / hop_sec))

        w_min = max(0, target_frame - window_frames)
        w_max = min(len(onset_env), target_frame + window_frames + 1)

        best_frame = target_frame
        found_snap = False

        if w_max > w_min:
            # Priority (b): Check for unvoiced->voiced transition inside window
            trans_candidates = [f for f in range(w_min, w_max) if f in f0_transition_frames]

            # Priority (a): True local onset peaks within search window
            local_peaks = [
                f for f in range(max(1, w_min), min(len(onset_env) - 1, w_max))
                if onset_env[f] >= onset_env[f-1]
                and onset_env[f] >= onset_env[f+1]
                and onset_env[f] >= thresh
            ]

            if trans_candidates:
                # Pick transition closest to target frame
                best_trans = min(trans_candidates, key=lambda f: abs(f - target_frame))
                best_frame = best_trans
                found_snap = True
            elif local_peaks:
                # Pick local onset peak closest to target frame
                best_peak = min(local_peaks, key=lambda f: abs(f - target_frame))
                best_frame = best_peak
                found_snap = True

        new_start = round(best_frame * hop_sec, 3) if found_snap else orig_s

        # Breakthrough 4: Refine onset using sub-frame spectral transient attack snapping (<= 8ms)
        try:
            from karaoke.transients import snap_onset_to_spectral_transient
            new_start = snap_onset_to_spectral_transient(
                rough_onset_sec=new_start,
                y=vocal_audio,
                sr=sr,
                search_window_ms=35.0,
            )
        except Exception:
            pass

        # Invariant constraints:
        # Never move earlier than prev_start + 0.030
        if new_start < prev_start + 0.030:
            new_start = round(prev_start + 0.030, 3)

        # Check against next syllable's start if known
        if i + 1 < len(syllables):
            next_s = float(syllables[i+1]["start"])
            if new_start > next_s - 0.030:
                new_start = max(round(prev_start + 0.030, 3), round(next_s - 0.030, 3))

        prev_start = new_start
        new_dur = max(0.030, orig_e - new_start)
        new_end = round(new_start + new_dur, 3)

        item = dict(s)
        item["start"] = new_start
        item["end"] = new_end
        if "note_start" in s:
            item["note_start"] = max(new_start, min(float(s["note_start"]), new_end - 0.030))
        snapped.append(item)

    return snapped


# ==============================================================================
# 6. Note End Pruning & Silence Gap Protection (Task 5)
# ==============================================================================

def prune_note_ends(
    syllables: List[Dict[str, Any]],
    pitch_data: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Task 5 Note End Pruning:
    note_end = min(syllable_end, last_voiced_frame + 40ms).
    A note must not extend across a silent/unvoiced gap >= 120ms.
    Guarantees minimum duration of 30ms.
    """
    if not pitch_data or not syllables:
        return syllables

    pitches = pitch_data.get("midi") if "midi" in pitch_data else pitch_data.get("pitches")
    if pitches is None or len(pitches) == 0:
        return syllables

    num_frames = len(pitches)
    hop_sec = float(pitch_data.get("frame_dur_sec", 0.010))

    pruned = []
    for s in syllables:
        start_sec = float(s["start"])
        end_sec = float(s["end"])
        f_start = max(0, int(round(start_sec / hop_sec)))
        f_end = min(num_frames, int(round(end_sec / hop_sec)))

        if f_end > f_start:
            window_pitches = pitches[f_start:f_end]
            voiced_mask = (~np.isnan(window_pitches)) & (window_pitches > 0)
            voiced_indices = np.where(voiced_mask)[0]

            if len(voiced_indices) > 0:
                # Find last voiced frame within the syllable
                last_voiced_idx = int(voiced_indices[-1])
                last_voiced_sec = (f_start + last_voiced_idx) * hop_sec
                # min(syllable end, last voiced frame + 40ms)
                cand_end = min(end_sec, last_voiced_sec + VOICED_TAIL_MARGIN_SEC)

                # Check for silent/unvoiced gaps >= 120ms within the voiced span
                # An unvoiced run of >= 12 frames (120ms) truncates the note
                curr_silent_len = 0
                cut_sec = None
                first_voiced_idx = int(voiced_indices[0])
                gap_frames_threshold = int(round(SILENT_GAP_NOTE_END_SEC / hop_sec))
                for idx in range(first_voiced_idx, len(voiced_mask)):
                    is_v = voiced_mask[idx]
                    if not is_v:
                        curr_silent_len += 1
                        if curr_silent_len >= gap_frames_threshold:
                            # Cut note at the start of the silent gap + 40ms
                            cut_idx = idx - curr_silent_len
                            cut_sec = (f_start + max(0, cut_idx)) * hop_sec + VOICED_TAIL_MARGIN_SEC
                            break
                    else:
                        curr_silent_len = 0

                if cut_sec is not None:
                    cand_end = min(cand_end, cut_sec)

                end_sec = max(start_sec + 0.030, cand_end)

        item = dict(s)
        item["start"] = round(start_sec, 3)
        item["end"] = round(end_sec, 3)
        if "note_start" in s:
            item["note_start"] = max(item["start"], min(float(s["note_start"]), item["end"] - 0.030))
        pruned.append(item)

    return pruned


# ==============================================================================
# 7. High-Level Forced Alignment Pipeline (Tasks 1, 2, 3, 5, 6)
# ==============================================================================

def align_lyrics_doc_to_audio(
    vocals_path: Path | str,
    doc: Any,  # LyricsDoc
    pitch_data: Optional[Dict[str, Any]] = None,
    hardware_profile: Optional[HardwareProfile] = None,
) -> List[Dict[str, Any]]:
    """
    Main Phase 4 Alignment Entrypoint for canonical LyricsDoc.
    Delegates to MMS CTC Trellis forced aligner in karaoke.align_mms.
    """
    return align_lyrics_doc_mms(
        vocals_path=vocals_path,
        doc=doc,
        pitch_data=pitch_data,
        hardware_profile=hardware_profile,
    )


def align_whisper_words(
    vocals_path: Path | str,
    whisper_words: List[Dict[str, Any]],
    pitch_data: Optional[Dict[str, Any]] = None,
    lang: str = "de",
    hardware_profile: Optional[HardwareProfile] = None,
) -> List[Dict[str, Any]]:
    """
    Refines Whisper word timestamps via MMS CTC forced alignment.
    Delegates to MMS CTC Trellis forced aligner in karaoke.align_mms.
    """
    return align_whisper_words_mms(
        vocals_path=vocals_path,
        whisper_words=whisper_words,
        pitch_data=pitch_data,
        lang=lang,
        hardware_profile=hardware_profile,
    )
