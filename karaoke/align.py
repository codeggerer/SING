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


# ==============================================================================
# 1. Text Normalization for MMS Forced Aligner
# ==============================================================================

# MMS FA dictionary supported characters
MMS_VALID_CHARS = set("'abcdefghijklmnopqrstuvwxyz")


def clean_word_for_mms(word: str) -> str:
    """
    Cleans a word for MMS CTC tokenization:
    - Lowercases text
    - Transliterates German umlauts and special characters
    - Keeps only characters present in the MMS vocabulary (a-z and apostrophe)
    """
    w = word.lower().strip()
    # German umlauts and ligature transliterations
    w = w.replace('ä', 'ae').replace('ö', 'oe').replace('ü', 'ue').replace('ß', 'ss')
    # Accented Latin vowels (French, Spanish)
    w = re.sub(r'[àáâãå]', 'a', w)
    w = re.sub(r'[èéêë]', 'e', w)
    w = re.sub(r'[ìíîï]', 'i', w)
    w = re.sub(r'[òóôõ]', 'o', w)
    w = re.sub(r'[ùúû]', 'u', w)
    w = re.sub(r'[ýÿ]', 'y', w)
    w = re.sub(r'[ç]', 'c', w)
    w = re.sub(r'[ñ]', 'n', w)
    # Strip any punctuation except apostrophe
    w = re.sub(r"[^\w']+", '', w)
    # Filter to MMS dictionary
    return ''.join(c for c in w if c in MMS_VALID_CHARS)


# ==============================================================================
# 2. MMS Forced Aligner
# ==============================================================================

class MMSForcedAligner:
    """
    Multilingual CTC Forced Aligner using torchaudio's MMS_FA pipeline.
    """
    _instance: Optional[MMSForcedAligner] = None

    def __init__(self, device: Optional[str] = None):
        if torchaudio is None or torch is None:
            raise ImportError("PyTorch and TorchAudio are required for MMS Forced Alignment.")
        
        self.device = device or ("cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))
        # Some MPS ops can fall back to CPU safely if needed
        self.bundle = torchaudio.pipelines.MMS_FA
        self.sample_rate = self.bundle.sample_rate
        
        try:
            self.model = self.bundle.get_model().to(self.device)
            self.model.eval()
        except Exception:
            # Fallback to CPU if device fails
            self.device = "cpu"
            self.model = self.bundle.get_model().to("cpu")
            self.model.eval()

        self.tokenizer = self.bundle.get_tokenizer()
        self.aligner = self.bundle.get_aligner()

    @classmethod
    def get_instance(cls, device: Optional[str] = None) -> MMSForcedAligner:
        if cls._instance is None:
            cls._instance = MMSForcedAligner(device=device)
        return cls._instance

    def align_chunk(
        self,
        waveform_chunk: torch.Tensor,
        words: List[str],
    ) -> List[Optional[List[Any]]]:
        """
        Runs CTC forced alignment on a single audio chunk for the given words.
        Returns a list of token spans per word, or None if alignment fails.
        """
        if waveform_chunk.ndim == 1:
            waveform_chunk = waveform_chunk.unsqueeze(0)
        elif waveform_chunk.shape[0] > 1:
            waveform_chunk = torch.mean(waveform_chunk, dim=0, keepdim=True)

        if waveform_chunk.shape[1] < 160:  # < 10ms
            return [None] * len(words)

        tokens = self.tokenizer(words)
        try:
            chunk_dev = waveform_chunk.to(self.device)
            with torch.inference_mode():
                emission, _ = self.model(chunk_dev)
            spans = self.aligner(emission[0].cpu(), tokens)
            ratio = (waveform_chunk.shape[1] / emission.shape[1]) / self.sample_rate
            return spans, ratio
        except Exception:
            return None, 0.0


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


def distribute_word_syllables(
    word: str,
    start: float,
    end: float,
    lang: str = "de",
    char_spans: Optional[List[Tuple[str, float, float]]] = None,
    is_last_in_phrase: bool = False,
    has_pause_after: bool = False,
) -> List[Dict[str, Any]]:
    """
    Distributes a word's duration across its phonetic syllables.
    - If char_spans (character-level CTC boundaries) are provided and match, uses them.
    - Otherwise, distributes via the Task 2 vowel-nucleus weighted formula:
      - Base weight: 1.0 (vowel present) or 0.5 (no vowel)
      - Onset consonant cluster: +0.15 per consonant before the vowel
      - Last syllable of word: +20% (* 1.2) for phrase lengthening
      - Words before a pause / phrase end: +20% (* 1.2) for pause lengthening
    """
    total_dur = max(0.030, end - start)
    clean_w = word.strip()
    syllables = split_syllables(clean_w, lang=lang, word_duration=total_dur)
    num_sylls = len(syllables)

    if num_sylls <= 1:
        text = f"{clean_w} " if not clean_w.endswith(" ") else clean_w
        return [{
            "word": text,
            "start": round(start, 3),
            "end": round(end, 3),
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
                result.append({
                    "word": text,
                    "start": round(max(start, s_start), 3),
                    "end": round(min(end + 0.1, max(s_start + 0.030, s_end)), 3),
                    "is_syllable": True,
                })
            # Ensure monotonicity
            for i in range(1, len(result)):
                if result[i]["start"] < result[i-1]["end"]:
                    mid = (result[i-1]["start"] + result[i]["end"]) / 2.0
                    result[i-1]["end"] = round(mid, 3)
                    result[i]["start"] = round(mid, 3)
            return result

    # Case B: Vowel-nucleus weighted split (Task 2 specification)
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
        result.append({
            "word": text,
            "start": round(curr_start, 3),
            "end": round(s_end, 3),
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
    if pitch_data and "pitches" in pitch_data:
        pitches = pitch_data["pitches"]
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
    A note must not extend across a silent/unvoiced gap > 120ms.
    Guarantees minimum duration of 30ms.
    """
    if not pitch_data or "pitches" not in pitch_data or not syllables:
        return syllables

    pitches = pitch_data["pitches"]
    num_frames = len(pitches)
    hop_sec = 0.010  # 10ms frame resolution

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

                # Check for silent/unvoiced gaps > 120ms within the voiced span
                # An unvoiced run of >= 12 frames (120ms) truncates the note
                curr_silent_len = 0
                cut_sec = None
                for idx, is_v in enumerate(voiced_mask):
                    if not is_v:
                        curr_silent_len += 1
                        if curr_silent_len >= int(round(SILENT_GAP_NOTE_END_SEC / hop_sec)):
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
    - If doc is already syllable-synced: uses provider syllables after offset correction,
      then applies audio snapping (Task 3) and note end pruning (Task 5).
    - If doc is line-synced or word-synced: runs MMS CTC forced alignment on each line
      prior window (±1.5s margin), distributes syllable timings (Task 2),
      applies audio snapping (Task 3), and tags phrase line breaks (Task 6).
    """
    offset = getattr(doc, "lyricsOffsetSec", 0.0)
    sync_type = getattr(doc, "syncType", "line")
    lang = getattr(doc, "language", "de") or "de"

    # Load vocals audio at 16 kHz for aligner and snapping
    vocal_audio_16k, sr = load_audio_mono(vocals_path, target_sr=16000)
    audio_dur = len(vocal_audio_16k) / sr

    # --------------------------------------------------------------------------
    # Case 1: Syllable-synced lyrics
    # --------------------------------------------------------------------------
    if sync_type == "syllable":
        raw_words = doc.to_words_list()
        # Apply audio snapping
        snapped = snap_syllables_to_audio(raw_words, vocal_audio_16k, sr=sr, pitch_data=pitch_data)
        # Apply note end pruning
        pruned = prune_note_ends(snapped, pitch_data=pitch_data)
        return pruned

    # --------------------------------------------------------------------------
    # Case 2: Line-synced, word-synced, or static lyrics -> MMS Forced Alignment
    # --------------------------------------------------------------------------
    aligner_dev = hardware_profile.device if hardware_profile else None
    aligner = MMSForcedAligner.get_instance(device=aligner_dev)
    waveform_tensor = torch.from_numpy(vocal_audio_16k).unsqueeze(0)

    final_syllables: List[Dict[str, Any]] = []

    for line_idx, line in enumerate(doc.lines):
        line_words_raw = [w for w in line.words.split() if w.strip()]
        if not line_words_raw:
            continue

        line_start = max(0.0, line.start + offset)
        line_end = max(line_start + 0.5, line.end + offset)

        # Window prior with ±1.5s margin (Task 1)
        win_start = max(0.0, line_start - 1.5)
        win_end = min(audio_dur, line_end + 1.5)
        start_samp = int(win_start * sr)
        end_samp = int(win_end * sr)
        chunk = waveform_tensor[:, start_samp:end_samp]

        # Clean words for MMS
        cleaned_pairs = [(r, clean_word_for_mms(r)) for r in line_words_raw]
        valid_pairs = [(r, c) for r, c in cleaned_pairs if len(c) > 0]

        aligned_for_line = []
        if valid_pairs:
            mms_words = [c for r, c in valid_pairs]
            spans, ratio = aligner.align_chunk(chunk, mms_words)

            if spans and len(spans) == len(valid_pairs):
                for (raw_w, clean_w), sp in zip(valid_pairs, spans):
                    if sp and len(sp) > 0:
                        w_start = win_start + (sp[0].start * ratio)
                        w_end = win_start + (sp[-1].end * ratio)
                        char_spans = [
                            (ch, win_start + s.start * ratio, win_start + s.end * ratio)
                            for ch, s in zip(clean_w, sp)
                        ]
                        aligned_for_line.append({
                            "word": raw_w,
                            "start": w_start,
                            "end": max(w_start + 0.030, w_end),
                            "char_spans": char_spans,
                        })

        # Fallback if alignment failed for this line
        if len(aligned_for_line) < len(line_words_raw):
            aligned_for_line = []
            dur = max(0.5, line_end - line_start)
            step = dur / len(line_words_raw)
            for idx, r in enumerate(line_words_raw):
                w_s = line_start + (idx * step)
                w_e = w_s + step
                aligned_for_line.append({
                    "word": r,
                    "start": w_s,
                    "end": w_e,
                    "char_spans": None,
                })

        # Distribute syllables for each word in the line (Task 2)
        n_words = len(aligned_for_line)
        for w_idx, w_data in enumerate(aligned_for_line):
            is_last_word = (w_idx == n_words - 1)
            sylls = distribute_word_syllables(
                word=w_data["word"],
                start=w_data["start"],
                end=w_data["end"],
                lang=lang,
                char_spans=w_data.get("char_spans"),
                is_last_in_phrase=is_last_word,
                has_pause_after=is_last_word,
            )
            # Tag phrase line break on the first syllable of the next line (Task 6)
            if is_last_word:
                sylls[-1]["line_break_after"] = True
            final_syllables.extend(sylls)

    # Audio-based onset snapping (Task 3)
    final_syllables = snap_syllables_to_audio(
        final_syllables,
        vocal_audio_16k,
        sr=sr,
        pitch_data=pitch_data,
    )

    # Note end pruning (Task 5)
    final_syllables = prune_note_ends(final_syllables, pitch_data=pitch_data)

    return final_syllables


def align_whisper_words(
    vocals_path: Path | str,
    whisper_words: List[Dict[str, Any]],
    pitch_data: Optional[Dict[str, Any]] = None,
    lang: str = "de",
    hardware_profile: Optional[HardwareProfile] = None,
) -> List[Dict[str, Any]]:
    """
    Refines Whisper word timestamps via MMS CTC forced alignment:
    - Groups Whisper words into phrases/lines (pause >= 0.6s or 8 words)
    - Runs MMS forced alignment on each phrase window
    - Distributes syllables via Task 2, snaps onsets via Task 3, prunes ends via Task 5.
    """
    if not whisper_words:
        return []

    vocal_audio_16k, sr = load_audio_mono(vocals_path, target_sr=16000)
    audio_dur = len(vocal_audio_16k) / sr

    aligner_dev = hardware_profile.device if hardware_profile else None
    aligner = MMSForcedAligner.get_instance(device=aligner_dev)
    waveform_tensor = torch.from_numpy(vocal_audio_16k).unsqueeze(0)

    # 1. Group Whisper words into lines/phrases (Task 6)
    lines: List[List[Dict[str, Any]]] = []
    current_line: List[Dict[str, Any]] = []

    for i, w in enumerate(whisper_words):
        if not current_line:
            current_line.append(w)
            continue

        prev_w = current_line[-1]
        pause = w["start"] - prev_w["end"]

        if pause >= PAUSE_BREAK_THRESHOLD_SEC or len(current_line) >= LINE_MAX_WORDS:
            lines.append(current_line)
            current_line = [w]
        else:
            current_line.append(w)

    if current_line:
        lines.append(current_line)

    final_syllables: List[Dict[str, Any]] = []

    # 2. Align each phrase
    for line in lines:
        line_start = line[0]["start"]
        line_end = line[-1]["end"]

        win_start = max(0.0, line_start - 1.5)
        win_end = min(audio_dur, line_end + 1.5)
        start_samp = int(win_start * sr)
        end_samp = int(win_end * sr)
        chunk = waveform_tensor[:, start_samp:end_samp]

        raw_words = [w["word"] for w in line]
        cleaned_pairs = [(r, clean_word_for_mms(r)) for r in raw_words]
        valid_pairs = [(r, c) for r, c in cleaned_pairs if len(c) > 0]

        aligned_for_line = []
        if valid_pairs:
            mms_words = [c for r, c in valid_pairs]
            spans, ratio = aligner.align_chunk(chunk, mms_words)

            if spans and len(spans) == len(valid_pairs):
                for (raw_w, clean_w), sp in zip(valid_pairs, spans):
                    if sp and len(sp) > 0:
                        w_start = win_start + (sp[0].start * ratio)
                        w_end = win_start + (sp[-1].end * ratio)
                        char_spans = [
                            (ch, win_start + s.start * ratio, win_start + s.end * ratio)
                            for ch, s in zip(clean_w, sp)
                        ]
                        aligned_for_line.append({
                            "word": raw_w,
                            "start": w_start,
                            "end": max(w_start + 0.030, w_end),
                            "char_spans": char_spans,
                        })

        if len(aligned_for_line) < len(line):
            aligned_for_line = [
                {"word": w["word"], "start": w["start"], "end": w["end"], "char_spans": None}
                for w in line
            ]

        n_words = len(aligned_for_line)
        for w_idx, w_data in enumerate(aligned_for_line):
            is_last_word = (w_idx == n_words - 1)
            sylls = distribute_word_syllables(
                word=w_data["word"],
                start=w_data["start"],
                end=w_data["end"],
                lang=lang,
                char_spans=w_data.get("char_spans"),
                is_last_in_phrase=is_last_word,
                has_pause_after=is_last_word,
            )
            if is_last_word:
                sylls[-1]["line_break_after"] = True
            final_syllables.extend(sylls)

    # Audio-based onset snapping (Task 3)
    final_syllables = snap_syllables_to_audio(
        final_syllables,
        vocal_audio_16k,
        sr=sr,
        pitch_data=pitch_data,
    )

    # Note end pruning (Task 5)
    final_syllables = prune_note_ends(final_syllables, pitch_data=pitch_data)

    return final_syllables
