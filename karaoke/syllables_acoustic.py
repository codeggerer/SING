"""
karaoke/syllables_acoustic.py - Acoustic Syllable Nuclei Segmenter (Phase 3 of UNSYNCED_LYRICS_OVERHAUL_PLAN.md).

Precision Acoustic Alignment & Scale-Constrained Quantization for Niche Songs:
- Combines phonetic syllabification with vocal RMS energy & spectral flux.
- Fast path: Monosyllable protection (< 0.28s or phonetic syllable count <= 1).
- Acoustic Syllable Slicing: Detects multi-syllable vowel boundaries within words using acoustic energy valleys.
- Melisma detection (~): Triggers on sustained pitch inflection >= 1.5 semitones.
- Safe fallbacks: Proportional / vowel-nucleus weighted distribution when audio is silent, clipped, or too short.
"""

from __future__ import annotations
import re
from typing import List, Dict, Any, Optional, Tuple, Union
import numpy as np

try:
    import librosa
except ImportError:
    librosa = None

try:
    import scipy.signal
    import scipy.ndimage
except ImportError:
    scipy = None

from karaoke.config import (
    MIN_WORD_DUR_FOR_SPLIT,
    BEAT_DUR_SEC,
    MIN_NOTE_DUR_BEATS,
)
from karaoke.notes import (
    is_monosyllable,
    syllabify_word,
)

VOWELS_REGEX = re.compile(r'[aeiouyäöüAEIOUYÄÖÜ]')


def detect_melisma_in_syllable_slice(
    syllable: Dict[str, Any],
    pitch_data: Dict[str, Any],
    min_dur: float = 0.40,
    min_st_diff: float = 1.5,
) -> Optional[List[Dict[str, Any]]]:
    """
    Checks if a sustained syllable (>= min_dur) contains an internal pitch shift
    (>= min_st_diff semitones), indicating a sung melisma (~).
    Splits into the base syllable and a secondary '~' note.
    """
    s_start = float(syllable["start"])
    s_end = float(syllable["end"])
    s_dur = s_end - s_start
    if s_dur < min_dur:
        return None

    frame_dur = float(pitch_data.get("frame_dur_sec", 0.010))
    total_frames = int(pitch_data.get("total_frames", 0))
    midi_float = pitch_data.get("midi") if "midi" in pitch_data else pitch_data.get("pitches")
    conf = pitch_data.get("conf")

    if midi_float is None or len(midi_float) == 0:
        return None

    sf_idx = max(0, min(total_frames - 1, int(round(s_start / frame_dur))))
    ef_idx = max(sf_idx + 1, min(total_frames, int(round(s_end / frame_dur))))
    if ef_idx - sf_idx < 14:
        return None

    m_seg = midi_float[sf_idx:ef_idx]
    c_seg = conf[sf_idx:ef_idx] if conf is not None else np.ones_like(m_seg)

    valid = (~np.isnan(m_seg)) & (c_seg >= 0.30) & (m_seg > 30)
    if np.sum(valid) < 10:
        return None

    v_midis = m_seg[valid]
    p25 = float(np.percentile(v_midis, 25))
    p75 = float(np.percentile(v_midis, 75))

    if (p75 - p25) < min_st_diff:
        return None

    # Try to use quantizer's detect_melisma_in_syllable if available
    try:
        from karaoke.quantizer import detect_melisma_in_syllable
        rms_slice = pitch_data.get("rms", np.ones_like(midi_float))[sf_idx:ef_idx]
        melisma_res = detect_melisma_in_syllable(
            m_seg,
            c_seg,
            rms_slice,
            s_start,
            s_end,
            frame_dur,
            min_split_dur=min_dur,
            min_semitone_diff=min_st_diff,
        )
        if melisma_res:
            t_split, p1_f, p1_i, p2_f, p2_i, _ = melisma_res
            clean_text = str(syllable.get("text", syllable.get("word", ""))).rstrip("~").rstrip("-").rstrip()
            item1 = {
                "text": f"{clean_text}-",
                "word": f"{clean_text}-",
                "start": round(s_start, 3),
                "end": round(t_split, 3),
                "is_syllable": True,
                "pitch": p1_i,
                "pitch_float": p1_f,
            }
            item2 = {
                "text": "~ ",
                "word": "~ ",
                "start": round(t_split, 3),
                "end": round(s_end, 3),
                "is_syllable": True,
                "pitch": p2_i,
                "pitch_float": p2_f,
            }
            if syllable.get("line_break_after"):
                item2["line_break_after"] = True
            return [item1, item2]
    except Exception:
        pass

    # Direct midpoint split fallback
    mid_time = round((s_start + s_end) / 2.0, 3)
    if mid_time <= s_start + 0.12 or mid_time >= s_end - 0.12:
        return None

    clean_text = str(syllable.get("text", syllable.get("word", ""))).rstrip("~").rstrip("-").rstrip()
    item1 = {
        "text": f"{clean_text}-",
        "word": f"{clean_text}-",
        "start": round(s_start, 3),
        "end": round(mid_time, 3),
        "is_syllable": True,
    }
    item2 = {
        "text": "~ ",
        "word": "~ ",
        "start": round(mid_time, 3),
        "end": round(s_end, 3),
        "is_syllable": True,
    }
    if syllable.get("line_break_after"):
        item2["line_break_after"] = True

    return [item1, item2]


def slice_word_syllables_acoustically(
    word_item: Dict[str, Any],
    vocal_audio_segment: Optional[np.ndarray],
    sr: int = 16000,
    lang: str = "de",
    pitch_data: Optional[Dict[str, Any]] = None,
    detect_melisma: bool = True,
) -> List[Dict[str, Any]]:
    """
    Takes a word with start/end timestamps and vocal audio slice,
    and returns exact syllable sub-intervals [start, end].
    
    Acoustic Syllable Slicing Algorithm:
    1. Fast path: Monosyllable protection (< 0.28s or phonetic syllable count <= 1).
    2. Multi-syllable decomposition: splits dictionary text into syllables (Fens-ter).
    3. Vocal RMS energy & spectral flux analysis in 10ms frame hops.
    4. Energy valley & consonant boundary detection between vowel nuclei.
    5. Melisma pitch transition detection (~) on sustained notes.
    """
    word_text = str(word_item.get("word") if "word" in word_item else word_item.get("text", ""))
    w_start = float(word_item["start"])
    w_end = float(word_item["end"])
    w_dur = max(0.030, w_end - w_start)
    line_break_after = bool(word_item.get("line_break_after", False))

    clean_raw = word_text.rstrip()
    disp_single = f"{clean_raw} " if not (clean_raw.endswith("-") or clean_raw.endswith(" ")) else word_text

    # Fast path: Monosyllable protection or very short duration (< 0.28s)
    if is_monosyllable(word_text, lang=lang, duration=w_dur) or w_dur < MIN_WORD_DUR_FOR_SPLIT:
        single_syllable = {
            "text": disp_single,
            "word": disp_single,
            "start": round(w_start, 3),
            "end": round(w_end, 3),
            "is_syllable": True,
        }
        if line_break_after:
            single_syllable["line_break_after"] = True

        if detect_melisma and pitch_data:
            m = detect_melisma_in_syllable_slice(single_syllable, pitch_data)
            if m:
                return m

        return [single_syllable]

    text_syllables = syllabify_word(word_text, lang=lang, word_duration=w_dur)
    n_sylls = len(text_syllables)
    if n_sylls <= 1:
        single_syllable = {
            "text": disp_single,
            "word": disp_single,
            "start": round(w_start, 3),
            "end": round(w_end, 3),
            "is_syllable": True,
        }
        if line_break_after:
            single_syllable["line_break_after"] = True

        if detect_melisma and pitch_data:
            m = detect_melisma_in_syllable_slice(single_syllable, pitch_data)
            if m:
                return m

        return [single_syllable]

    # Proportional / vowel-nucleus fallback builder
    def _fallback_split() -> List[Dict[str, Any]]:
        # Vowel-nucleus weighted distribution
        weights = []
        for s_idx, s in enumerate(text_syllables):
            s_raw = s["raw"] if isinstance(s, dict) and "raw" in s else str(s).lower()
            has_vowel = bool(VOWELS_REGEX.search(s_raw))
            base_w = 1.0 if has_vowel else 0.5
            onset_m = re.match(r'^[^aeiouyäöü]+', s_raw)
            onset_c = len(onset_m.group(0)) if onset_m else 0
            w = base_w + 0.15 * onset_c
            if s_idx == n_sylls - 1:
                w *= 1.20
            weights.append(w)
        tot_w = sum(weights) or 1.0
        norm_w = [w / tot_w for w in weights]

        res = []
        cur_t = w_start
        for i, s in enumerate(text_syllables):
            is_last = (i == n_sylls - 1)
            dur_i = w_dur * norm_w[i]
            s_end_val = w_end if is_last else round(cur_t + dur_i, 3)
            disp = s["display"] if isinstance(s, dict) and "display" in s else (f"{s} " if is_last else f"{s}-")
            item = {
                "text": disp,
                "word": disp,
                "start": round(cur_t, 3),
                "end": round(s_end_val, 3),
                "is_syllable": True,
            }
            if is_last and line_break_after:
                item["line_break_after"] = True
            res.append(item)
            cur_t = s_end_val
        return res

    # Check if vocal audio segment is available
    if vocal_audio_segment is None or len(vocal_audio_segment) == 0 or librosa is None:
        return _fallback_split()

    # Audio chunk extraction (handles full track audio as well as word slices)
    if len(vocal_audio_segment) > int((w_dur + 0.5) * sr) and w_start >= 0:
        start_samp = max(0, int(round(w_start * sr)))
        end_samp = min(len(vocal_audio_segment), int(round(w_end * sr)))
        vocal_chunk = vocal_audio_segment[start_samp:end_samp]
    else:
        vocal_chunk = vocal_audio_segment

    if len(vocal_chunk) < int(sr * 0.030 * n_sylls):
        return _fallback_split()

    # Compute vocal RMS energy and spectral flux in 10ms hops
    hop_length = int(round(sr * 0.010))
    frame_length = 2 * hop_length

    try:
        rms = librosa.feature.rms(y=vocal_chunk, frame_length=frame_length, hop_length=hop_length)[0]
    except Exception:
        return _fallback_split()

    try:
        flux = librosa.onset.onset_strength(y=vocal_chunk, sr=sr, hop_length=hop_length)
    except Exception:
        flux = np.zeros_like(rms)

    min_len = min(len(rms), len(flux))
    if min_len < n_sylls * 2:
        return _fallback_split()

    rms = rms[:min_len]
    flux = flux[:min_len]
    max_rms = float(np.max(rms)) if len(rms) > 0 else 0.0
    if max_rms < 1e-4:
        return _fallback_split()

    # Smoothing & energy valley / consonant boundary detection
    import scipy.signal
    import scipy.ndimage

    smoothed_rms = scipy.ndimage.gaussian_filter1d(rms, sigma=1.5)
    rms_max = float(np.max(smoothed_rms)) + 1e-8
    flux_max = float(np.max(flux)) + 1e-8
    flux_norm = flux / flux_max

    cost = (rms_max - smoothed_rms) + 0.25 * rms_max * flux_norm
    min_dist = max(3, int(min_len / (n_sylls * 2.0)))

    # Find energy valleys between vowel nuclei (peaks in cost)
    valleys, props = scipy.signal.find_peaks(cost, distance=min_dist, prominence=max_rms * 0.03)

    needed = n_sylls - 1
    selected_valleys = []

    if len(valleys) == needed:
        selected_valleys = list(valleys)
    elif len(valleys) > needed:
        proms = props["prominences"]
        top_idx = sorted(range(len(valleys)), key=lambda i: proms[i], reverse=True)[:needed]
        selected_valleys = sorted([valleys[i] for i in top_idx])
    else:
        # Fallback: find vowel peaks per sector and place boundary at lowest RMS between them
        weights = []
        for s in text_syllables:
            s_raw = s["raw"] if isinstance(s, dict) and "raw" in s else str(s).lower()
            has_vowel = bool(VOWELS_REGEX.search(s_raw))
            base_w = 1.0 if has_vowel else 0.5
            onset_m = re.match(r'^[^aeiouyäöü]+', s_raw)
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

        sect_peaks = []
        for k in range(n_sylls):
            fs, fe = seg_bounds[k], seg_bounds[k + 1]
            if fe > fs:
                p_rel = int(np.argmax(smoothed_rms[fs:fe]))
                sect_peaks.append(fs + p_rel)
            else:
                sect_peaks.append(fs)

        for k in range(1, len(sect_peaks)):
            if sect_peaks[k] <= sect_peaks[k - 1]:
                sect_peaks[k] = min(min_len - 1, sect_peaks[k - 1] + 2)

        for k in range(n_sylls - 1):
            p1, p2 = sect_peaks[k], sect_peaks[k + 1]
            if p2 > p1:
                v_rel = int(np.argmin(smoothed_rms[p1:p2 + 1]))
                v = p1 + v_rel
            else:
                v = p1 + 1
            min_f = (selected_valleys[-1] + 3) if selected_valleys else 3
            max_f = min_len - 3 * (n_sylls - 1 - k)
            v = max(min_f, min(max_f, v))
            selected_valleys.append(v)

    split_points = [w_start + (v * 0.010) for v in selected_valleys]

    # Construct bounded syllable slices
    syllable_slices = []
    cur_start = w_start
    for i, s in enumerate(text_syllables):
        is_last = (i == n_sylls - 1)
        if is_last:
            cur_end = w_end
        else:
            raw_split = split_points[i]
            # Ensure at least 30ms per syllable and monotonic order
            min_split = cur_start + 0.030
            max_split = w_end - 0.030 * (n_sylls - 1 - i)
            cur_end = max(min_split, min(max_split, raw_split))

        cur_end = round(cur_end, 3)
        cur_start = round(cur_start, 3)
        disp = s["display"] if isinstance(s, dict) and "display" in s else (f"{s} " if is_last else f"{s}-")

        syll_item = {
            "text": disp,
            "word": disp,
            "start": cur_start,
            "end": cur_end,
            "is_syllable": True,
        }
        if is_last and line_break_after:
            syll_item["line_break_after"] = True

        if detect_melisma and pitch_data:
            m = detect_melisma_in_syllable_slice(syll_item, pitch_data)
            if m:
                syllable_slices.extend(m)
                cur_start = cur_end
                continue

        syllable_slices.append(syll_item)
        cur_start = cur_end

    return syllable_slices


def slice_words_acoustically(
    words: List[Dict[str, Any]],
    vocal_audio: Optional[np.ndarray],
    sr: int = 16000,
    lang: str = "de",
    pitch_data: Optional[Dict[str, Any]] = None,
    detect_melisma: bool = True,
) -> List[Dict[str, Any]]:
    """
    Slices an entire sequence of aligned words into precise acoustic syllables.
    Iterates over each word, slices it using acoustic energy peaks and valleys,
    and returns a flattened list of syllable items.
    """
    final_sylls = []
    n_words = len(words)

    for idx, w in enumerate(words):
        if w.get("is_syllable", False):
            # Already a syllable
            if detect_melisma and pitch_data:
                m = detect_melisma_in_syllable_slice(w, pitch_data)
                if m:
                    final_sylls.extend(m)
                    continue
            final_sylls.append(w)
            continue

        w_item = dict(w)
        if idx == n_words - 1:
            w_item["line_break_after"] = True

        sliced = slice_word_syllables_acoustically(
            word_item=w_item,
            vocal_audio_segment=vocal_audio,
            sr=sr,
            lang=lang,
            pitch_data=pitch_data,
            detect_melisma=detect_melisma,
        )
        final_sylls.extend(sliced)

    return final_sylls
