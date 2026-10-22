"""
Scale-Constrained Hidden Markov Model (HMM) Quantizer (Phase 5.2).

Transforms continuous neural f0 pitch contours into discrete, musical UltraStar notes:
1. Pitch Class Profile (PCP) & Key/Scale Detection
2. Tessitura Analysis & Octave Register Anchoring
3. Scale-Constrained Viterbi HMM Dynamic Programming
4. Melisma Inflection Detection (split on stable plateaus >= 1.5 semitones)
"""

from __future__ import annotations
import math
from typing import List, Dict, Any, Optional, Tuple, Set
import numpy as np

try:
    import librosa
except ImportError:
    librosa = None

from karaoke.config import (
    SONG_MEDIAN_MIN_MIDI,
    SONG_MEDIAN_MAX_MIDI,
    KEY_MIN_CONFIDENCE_FOR_SNAP,
    PAUSE_BREAK_THRESHOLD_SEC,
    LINE_MAX_WORDS,
    BEAT_DUR_SEC,
    MIN_NOTE_DUR_BEATS,
    MIN_NOTE_GAP_BEATS,
    DEFAULT_SPLIT_METHOD,
    SPLIT_METHOD_HSMM,
)
from karaoke.hsmm import viterbi_decode_notes_hsmm

# Krumhansl-Schmuckler cognitive key profiles (energy distribution)
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11]
MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10]
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def compute_pitch_class_profile(
    midi_float: np.ndarray,
    conf: np.ndarray,
    rms: np.ndarray,
    min_conf: float = 0.35,
) -> np.ndarray:
    """
    Computes energy-weighted 12-dimensional Pitch Class Profile (PCP).
    PCP[pc] = sum of (conf * rms) for frames where round(midi) % 12 == pc.
    """
    pcp = np.zeros(12, dtype=np.float64)
    valid = (~np.isnan(midi_float)) & (conf >= min_conf) & (midi_float > 0)
    if not np.any(valid):
        return np.ones(12) / 12.0

    valid_midis = midi_float[valid]
    valid_weights = conf[valid] * (rms[valid] + 1e-4)

    for m, w in zip(valid_midis, valid_weights):
        pc = int(round(m)) % 12
        pcp[pc] += w

    total = np.sum(pcp)
    if total > 0:
        pcp /= total
    return pcp


def detect_key_from_pcp(pcp: np.ndarray) -> Tuple[int, str, float, Set[int]]:
    """
    Identifies root note and mode (major/minor) from PCP using Krumhansl-Schmuckler correlation.
    Returns: (root_idx, mode, confidence, scale_pcs)
    """
    best_corr = -1.0
    best_root = 0
    best_mode = "major"

    for root in range(12):
        maj_prof = np.roll(MAJOR_PROFILE, root)
        corr_maj = np.corrcoef(pcp, maj_prof)[0, 1]
        if corr_maj > best_corr:
            best_corr = float(corr_maj)
            best_root = root
            best_mode = "major"

        min_prof = np.roll(MINOR_PROFILE, root)
        corr_min = np.corrcoef(pcp, min_prof)[0, 1]
        if corr_min > best_corr:
            best_corr = float(corr_min)
            best_root = root
            best_mode = "minor"

    confidence = max(0.0, best_corr)
    intervals = MAJOR_INTERVALS if best_mode == "major" else MINOR_INTERVALS
    scale_pcs = {(best_root + iv) % 12 for iv in intervals}
    return best_root, best_mode, confidence, scale_pcs


def snap_to_scale(
    midi_val: float,
    scale_pcs: Set[int] | set,
    confidence: float = 0.7,
) -> int:
    """
    Scale-constrained snapping (Phase 4).
    Locks candidate MIDI notes to the song's musical scale degrees.
    """
    if np.isnan(midi_val) or midi_val <= 0:
        return 60

    round_m = int(round(midi_val))
    if not scale_pcs or confidence < 0.35:
        return round_m

    pc = round_m % 12
    if pc in scale_pcs:
        return round_m

    # Snap to nearest scale degree
    down = round_m - 1
    up = round_m + 1
    down_in = (down % 12) in scale_pcs
    up_in = (up % 12) in scale_pcs

    if down_in and not up_in:
        return down
    if up_in and not down_in:
        return up
    if down_in and up_in:
        return down if abs(midi_val - down) <= abs(midi_val - up) else up

    # If neither adjacent note is in scale, check ±2
    for offset in [-2, 2]:
        cand = round_m + offset
        if (cand % 12) in scale_pcs:
            return cand

    return round_m


def analyze_tessitura(
    midi_float: np.ndarray,
    conf: np.ndarray,
    min_conf: float = 0.35,
) -> Tuple[float, float, float, int, Tuple[int, int]]:
    """
    Analyzes the singer's vocal register (tessitura).
    Determines median MIDI pitch, 10th and 90th percentiles, and register bounds.
    Returns:
        median_pitch, p10, p90, octave_shift, (candidate_min_midi, candidate_max_midi)
    """
    valid = (~np.isnan(midi_float)) & (conf >= min_conf) & (midi_float > 0)
    if not np.any(valid):
        # Fallback to standard middle range (MIDI 60 = C4)
        return 60.0, 53.0, 67.0, 0, (48, 72)

    v_midis = midi_float[valid]
    median_pitch = float(np.median(v_midis))
    p10 = float(np.percentile(v_midis, 10))
    p90 = float(np.percentile(v_midis, 90))

    # Octave register anchoring:
    # If the singer is far outside [SONG_MEDIAN_MIN_MIDI, SONG_MEDIAN_MAX_MIDI]
    shift = 0
    curr_med = median_pitch
    while curr_med + shift < SONG_MEDIAN_MIN_MIDI:
        shift += 12
    while curr_med + shift > SONG_MEDIAN_MAX_MIDI:
        shift -= 12

    # Candidate search range: 1.5 octaves below p10 to 1.5 octaves above p90
    cand_min = max(36, int(math.floor(p10 + shift - 12)))
    cand_max = min(88, int(math.ceil(p90 + shift + 12)))
    if cand_max - cand_min < 24:
        cand_min = max(36, cand_min - 6)
        cand_max = min(88, cand_max + 6)

    return median_pitch, p10, p90, shift, (cand_min, cand_max)


def detect_melisma_in_syllable(
    midi_slice: np.ndarray,
    conf_slice: np.ndarray,
    rms_slice: np.ndarray,
    start_sec: float,
    end_sec: float,
    frame_dur: float,
    min_split_dur: float = 0.40,
    min_semitone_diff: float = 1.5,
) -> Optional[Tuple[float, float, float, float, float, float]]:
    """
    Detects if a single syllable contains a musical melisma (inflection between two notes).
    Splits ONLY if:
    - Syllable duration >= min_split_dur (or >= 0.30s with marker)
    - Two contiguous plateaus each >= 120 ms
    - Plateau median pitches differ by >= min_semitone_diff (1.5 st)
    - Intra-plateau standard deviation <= 0.85 st (stable tones)
    - Not a monotonic portamento scoop (R^2 check)

    Returns:
        (t_split, p1_float, p1_int, p2_float, p2_int, conf) or None.
    """
    dur = end_sec - start_sec
    if dur < min_split_dur or len(midi_slice) < 14:
        return None

    valid = (~np.isnan(midi_slice)) & (conf_slice >= 0.30)
    if np.sum(valid) < 10:
        return None

    # Try split points between 25% and 75% of the syllable
    n = len(midi_slice)
    min_sub_frames = max(4, int(0.12 / frame_dur))
    best_split_idx = -1
    best_score = -1.0
    best_p1, best_p2 = 0.0, 0.0

    for idx in range(min_sub_frames, n - min_sub_frames):
        left_m = midi_slice[:idx]
        left_v = valid[:idx]
        right_m = midi_slice[idx:]
        right_v = valid[idx:]

        if np.sum(left_v) < min_sub_frames or np.sum(right_v) < min_sub_frames:
            continue

        left_pts = left_m[left_v]
        right_pts = right_m[right_v]

        med1 = float(np.median(left_pts))
        med2 = float(np.median(right_pts))
        diff = abs(med1 - med2)

        if diff < min_semitone_diff:
            continue

        std1 = float(np.std(left_pts))
        std2 = float(np.std(right_pts))
        if std1 > 0.85 or std2 > 0.85:
            continue

        # Score is proportional to separation distance and plateau stability
        score = diff / (std1 + std2 + 0.1)
        if score > best_score:
            best_score = score
            best_split_idx = idx
            best_p1 = med1
            best_p2 = med2

    if best_split_idx > 0 and best_score >= 1.5:
        # Check portamento / linear scoop filter
        valid_indices = np.where(valid)[0]
        if len(valid_indices) >= 8:
            x = valid_indices.astype(np.float64)
            y = midi_slice[valid].astype(np.float64)
            slope, intercept = np.polyfit(x, y, 1)
            corr = np.corrcoef(x, y)[0, 1]
            # If monotonic linear glide with R^2 > 0.80, it's a pitch scoop / portamento, not a split note
            if (corr ** 2) > 0.80 and abs(best_p1 - best_p2) < 2.5:
                return None

        t_split = start_sec + (best_split_idx * frame_dur)
        return (
            t_split,
            best_p1,
            int(round(best_p1)),
            best_p2,
            int(round(best_p2)),
            best_score,
        )

    return None


def detect_melisma_in_syllable_hsmm(
    midi_slice: np.ndarray,
    conf_slice: np.ndarray,
    rms_slice: np.ndarray,
    start_sec: float,
    end_sec: float,
    frame_dur: float = 0.010,
    scale_pcs: Optional[Set[int]] = None,
    has_melisma_marker: bool = False,
) -> Optional[List[Tuple[float, float, float, int]]]:
    """
    Decodes multi-note melismas or vocal runs via HSMM Viterbi optimization (Issue #2).
    """
    dur = end_sec - start_sec
    if dur < 0.160 and not has_melisma_marker:
        return None

    effective_dwell = 0.060 if has_melisma_marker else 0.080
    effective_switch = 7.0 if has_melisma_marker else 10.0

    raw_segs = viterbi_decode_notes_hsmm(
        midis=midi_slice,
        confs=conf_slice,
        rms=rms_slice,
        frame_dur_sec=frame_dur,
        min_dwell_sec=effective_dwell,
        switch_cost=effective_switch,
        jump_cost=0.5,
        sigma_semitones=0.6,
        scale_pcs=scale_pcs,
        scale_penalty=0.6,
        fallback_pitch=60.0,
        filter_scoops=True,
    )

    if len(raw_segs) <= 1:
        return None

    result = []
    for s_frame, e_frame, pf, pi in raw_segs:
        t0 = round(start_sec + s_frame * frame_dur, 3)
        t1 = round(start_sec + e_frame * frame_dur, 3)
        result.append((t0, t1, pf, pi))

    result[0] = (start_sec, result[0][1], result[0][2], result[0][3])
    result[-1] = (result[-1][0], end_sec, result[-1][2], result[-1][3])
    return result


def quantize_syllable_notes_in_key(
    syllable: Dict[str, Any],
    pitch_data: Dict[str, Any],
    key_info: Optional[Dict[str, Any]] = None,
    min_dur_beats: int = 3,
) -> List[Dict[str, Any]]:
    """
    Calculates stable, in-key UltraStar note(s) for a syllable duration (Phase 4).
    Detects melisma pitch transitions (~) when the singer changes pitch mid-syllable.
    """
    s_start = float(syllable.get("start", 0.0))
    s_end = float(syllable.get("end", s_start + 0.030))
    s_text = str(syllable.get("text", syllable.get("word", syllable.get("display", ""))))

    # Minimum duration check
    min_dur_sec = min_dur_beats * 0.010
    if s_end < s_start + min_dur_sec:
        s_end = s_start + min_dur_sec

    # Extract pitch frames inside syllable
    f0_midis = pitch_data.get("midi") if "midi" in pitch_data else pitch_data.get("pitches", [])
    if isinstance(f0_midis, list):
        f0_midis = np.asarray(f0_midis)
    elif f0_midis is None:
        f0_midis = np.array([])

    f0_times = pitch_data.get("timestamps")
    if f0_times is None:
        frame_dur = float(pitch_data.get("frame_dur_sec", 0.010))
        f0_times = np.arange(len(f0_midis)) * frame_dur
    elif isinstance(f0_times, list):
        f0_times = np.asarray(f0_times)

    confidence = pitch_data.get("confidence", pitch_data.get("conf"))
    if confidence is None:
        confidence = np.ones(len(f0_times), dtype=np.float32)
    elif isinstance(confidence, list):
        confidence = np.asarray(confidence)

    mask = (f0_times >= s_start) & (f0_times <= s_end)
    seg_midis = f0_midis[mask]
    seg_conf = confidence[mask]

    # Filter unvoiced or low-confidence frames
    valid = (~np.isnan(seg_midis)) & (seg_midis > 30) & (seg_conf > 0.45)
    if not np.any(valid):
        return [{
            "start": s_start,
            "end": s_end,
            "pitch": 60,  # Middle C default
            "text": s_text,
        }]

    midis = seg_midis[valid]
    confs = seg_conf[valid]

    # Scale Snapping Mask
    key_info = key_info or {}
    scale_pcs = key_info.get("scale_pcs", set())  # e.g. {3, 5, 6, 8, 10, 11, 1} for Eb Minor
    key_conf = float(key_info.get("confidence", 0.7))

    # Melisma check: Does the pitch shift significantly within this single syllable?
    p25 = float(np.percentile(midis, 25))
    p75 = float(np.percentile(midis, 75))

    if (s_end - s_start) >= 0.40 and (p75 - p25) >= 1.6:
        # Singer is doing a pitch glide / melisma! Split into 2 notes with '~'
        mid_time = (s_start + s_end) / 2.0
        seg_times = f0_times[mask][valid]
        m1 = midis[seg_times < mid_time]
        m2 = midis[seg_times >= mid_time]

        pitch1 = snap_to_scale(float(np.median(m1)) if len(m1) > 0 else float(np.median(midis)), scale_pcs, key_conf)
        pitch2 = snap_to_scale(float(np.median(m2)) if len(m2) > 0 else float(np.median(midis)), scale_pcs, key_conf)

        first_text = s_text.rstrip() + " " if not (s_text.endswith("-") or s_text.endswith(" ")) else s_text
        return [
            {"start": s_start, "end": mid_time, "pitch": int(pitch1), "text": first_text},
            {"start": mid_time, "end": s_end, "pitch": int(pitch2), "text": "~"}
        ]

    # Single sustained note
    med_pitch = float(np.median(midis))
    final_pitch = snap_to_scale(med_pitch, scale_pcs, key_conf)

    return [{
        "start": s_start,
        "end": s_end,
        "pitch": int(final_pitch),
        "text": s_text,
    }]


class ViterbiHMMQuantizer:
    """
    Scale-Constrained Hidden Markov Model (HMM) Viterbi Quantizer.
    Quantizes a sequence of continuous vocal syllable segments into optimal discrete musical notes.
    """

    def __init__(
        self,
        transition_weight: float = 0.35,
        scale_penalty: float = 0.15,
        octave_jump_penalty: float = 4.5,
        scale_pcs: Optional[Set[int]] = None,
        key_confidence: float = 1.0,
        cand_range: Tuple[int, int] = (36, 84),
    ):
        self.transition_weight = transition_weight
        self.scale_penalty = scale_penalty * max(0.0, min(1.0, key_confidence))
        self.octave_jump_penalty = octave_jump_penalty
        self.scale_pcs = scale_pcs if scale_pcs else set()
        self.key_confidence = key_confidence
        self.cand_range = cand_range
        self.candidates = list(range(cand_range[0], cand_range[1] + 1))

    def compute_emission_costs(
        self,
        midi_slice: np.ndarray,
        conf_slice: np.ndarray,
        rms_slice: np.ndarray,
        fallback_pitch: float = 60.0,
    ) -> np.ndarray:
        """
        Emission cost for each candidate MIDI pitch m:
        Cost(m) = sum(w(t) * (midi(t) - m)^2) / sum(w(t)) + scale_penalty * (m not in Scale)
        """
        num_cands = len(self.candidates)
        costs = np.zeros(num_cands, dtype=np.float64)

        valid = (~np.isnan(midi_slice)) & (conf_slice >= 0.25) & (midi_slice > 0)
        if not np.any(valid):
            # Syllable is completely unvoiced or breathy:
            # Quadratic distance from fallback pitch, scale penalty still applies
            for idx, m in enumerate(self.candidates):
                c_dist = 0.25 * ((m - fallback_pitch) ** 2)
                if self.scale_pcs and (m % 12) not in self.scale_pcs:
                    c_dist += self.scale_penalty * 0.5
                costs[idx] = c_dist
            return costs

        v_midi = midi_slice[valid]
        v_weights = conf_slice[valid] * (rms_slice[valid] + 1e-4)
        sum_w = np.sum(v_weights) + 1e-8

        for idx, m in enumerate(self.candidates):
            dev = np.abs(v_midi - m)
            # Robust Huber loss: quadratic for small deviations <= 1.5 st, linear for octave outliers
            huber = np.where(dev <= 1.5, dev ** 2, (3.0 * dev) - 2.25)
            cost_val = np.sum(v_weights * huber) / sum_w
            if self.scale_pcs and (m % 12) not in self.scale_pcs:
                cost_val += self.scale_penalty
            costs[idx] = cost_val

        return costs

    def quantize_sequence(
        self,
        syllable_slices: List[Dict[str, Any]],
    ) -> List[int]:
        """
        Runs Viterbi Dynamic Programming over a sequence of syllables.
        syllable_slices contains:
            [{'midi': ..., 'conf': ..., 'rms': ..., 'is_phrase_break': bool, 'fallback_pitch': float}]
        Returns:
            optimal sequence of integer MIDI notes [m_0, m_1, ..., m_{K-1}].
        """
        K = len(syllable_slices)
        if K == 0:
            return []

        num_cands = len(self.candidates)
        cands_arr = np.array(self.candidates, dtype=np.float64)

        # dp[k, j] = minimum cost to reach candidate j at step k
        dp = np.zeros((K, num_cands), dtype=np.float64)
        backpointers = np.zeros((K, num_cands), dtype=np.int32)

        # Step 0
        first_slice = syllable_slices[0]
        emission_0 = self.compute_emission_costs(
            first_slice["midi"],
            first_slice["conf"],
            first_slice["rms"],
            fallback_pitch=first_slice.get("fallback_pitch", 60.0),
        )
        dp[0] = emission_0

        # Steps 1 to K-1
        for k in range(1, K):
            curr_slice = syllable_slices[k]
            emission_k = self.compute_emission_costs(
                curr_slice["midi"],
                curr_slice["conf"],
                curr_slice["rms"],
                fallback_pitch=curr_slice.get("fallback_pitch", 60.0),
            )

            is_phrase_break = curr_slice.get("is_phrase_break", False)
            # When phrase break occurs, dampen transition weight
            trans_w = self.transition_weight * (0.15 if is_phrase_break else 1.0)
            oct_pen = self.octave_jump_penalty * (0.25 if is_phrase_break else 1.0)

            # Compute transition cost matrix: [num_cands, num_cands]
            # dist[prev, curr] = abs(cand_prev - cand_curr)
            cand_diffs = np.abs(cands_arr[:, None] - cands_arr[None, :])
            oct_jumps = (cand_diffs >= 11.5).astype(np.float64) * oct_pen
            transition_matrix = (trans_w * cand_diffs) + oct_jumps

            # Total cost to reach curr from each prev: dp[k-1, :] + transition_matrix
            # cost_candidates[prev, curr]
            cost_matrix = dp[k - 1, :][:, None] + transition_matrix
            best_prev = np.argmin(cost_matrix, axis=0)
            min_prev_cost = cost_matrix[best_prev, np.arange(num_cands)]

            dp[k] = min_prev_cost + emission_k
            backpointers[k] = best_prev

        # Backtracking
        best_last_cand = int(np.argmin(dp[K - 1]))
        quantized = [0] * K
        curr_cand_idx = best_last_cand
        quantized[K - 1] = self.candidates[curr_cand_idx]

        for k in range(K - 1, 0, -1):
            curr_cand_idx = backpointers[k, curr_cand_idx]
            quantized[k - 1] = self.candidates[curr_cand_idx]

        return quantized


def quantize_notes(
    words: List[Dict[str, Any]],
    pitch_data: Dict[str, Any],
    key_info: Optional[Dict[str, Any]] = None,
    lang: str = "de",
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Main entry point for Phase 5 Note Quantization.
    Takes aligned words/syllables and continuous pitch data,
    performs Key/PCP detection, Tessitura register anchoring, melisma detection,
    and Scale-Constrained Viterbi HMM optimization.
    """
    frame_dur = float(pitch_data.get("frame_dur_sec", 0.010))
    midi_float = pitch_data.get("midi") if "midi" in pitch_data else pitch_data.get("pitches")
    if midi_float is None or len(midi_float) == 0:
        return []
    total_frames = int(pitch_data.get("total_frames", len(midi_float)))
    conf = pitch_data.get("conf") if "conf" in pitch_data else pitch_data.get("confidence")
    if conf is None:
        conf = np.ones_like(midi_float)
    rms = pitch_data.get("rms")
    if rms is None:
        rms = np.ones_like(midi_float)

    # 1. Key & Scale Analysis
    scale_pcs: Set[int] = set()
    key_conf = 1.0
    if key_info and "scale_pcs" in key_info:
        scale_pcs = key_info["scale_pcs"]
        key_conf = float(key_info.get("confidence", 1.0))
    else:
        pcp = compute_pitch_class_profile(midi_float, conf, rms)
        _, _, key_conf, scale_pcs = detect_key_from_pcp(pcp)

    # 2. Tessitura Analysis & Register Bounds
    med_pitch, p10, p90, oct_shift, cand_range = analyze_tessitura(midi_float, conf)
    if oct_shift != 0:
        midi_float = midi_float + oct_shift

    # 3. Build Syllable Items (with Melisma Detection)
    syllable_items: List[Dict[str, Any]] = []
    word_indices: List[Tuple[int, int]] = []  # Maps syllable item index to word group
    words_in_current_phrase = 0
    prev_end_sec = 0.0

    for w_idx, w in enumerate(words):
        w_start = float(w["start"])
        w_end = max(float(w["end"]), w_start + 0.030)
        raw_word = str(w.get("word", ""))
        w_dur = w_end - w_start

        # Check phrase break condition
        is_phrase_break = False
        pause_beat = None
        if w_idx > 0:
            pause_sec = w_start - prev_end_sec
            has_line_break_marker = bool(words[w_idx - 1].get("line_break_after", False))
            if (
                has_line_break_marker
                or pause_sec >= PAUSE_BREAK_THRESHOLD_SEC
                or words_in_current_phrase >= LINE_MAX_WORDS
            ):
                is_phrase_break = True
                if words[w_idx - 1].get("pause_beat") is not None:
                    # Acoustic breath pause beat from Silero VAD
                    raw_pb = int(words[w_idx - 1]["pause_beat"])
                    prev_b = int(round(prev_end_sec / BEAT_DUR_SEC))
                    curr_b = int(round(w_start / BEAT_DUR_SEC))
                    if curr_b > prev_b + 1:
                        pause_beat = max(prev_b + 1, min(curr_b - 1, raw_pb))
                    else:
                        pause_beat = prev_b + 1
                else:
                    pause_sec_mid = (
                        prev_end_sec + min(0.15, max(0.02, pause_sec / 2.0))
                        if pause_sec > 0.04
                        else prev_end_sec + 0.01
                    )
                    pause_beat = int(round(pause_sec_mid / BEAT_DUR_SEC))
                words_in_current_phrase = 0

        words_in_current_phrase += 1
        prev_end_sec = w_end

        is_already_syllable = bool(w.get("is_syllable", False))
        has_melisma_marker = "~" in raw_word

        note_start = float(w.get("note_start", 0.0))
        if note_start < w_start or note_start > w_end - 0.030:
            from karaoke.align_mms import compute_vowel_nucleus_onset
            note_start = compute_vowel_nucleus_onset(
                raw_word,
                w_start,
                w_end,
                char_spans=w.get("char_spans"),
                pitch_data=pitch_data,
            )
        note_start = max(w_start, min(note_start, w_end - 0.030))

        # Extract frames aligned to vowel nucleus
        sf_idx = max(0, min(total_frames - 1, int(note_start / frame_dur)))
        ef_idx = max(sf_idx + 1, min(total_frames, int(w_end / frame_dur)))
        m_slice = midi_float[sf_idx:ef_idx]
        c_slice = conf[sf_idx:ef_idx]
        r_slice = rms[sf_idx:ef_idx]

        # Check for melisma split (HSMM or Heuristic)
        melisma_segs = None
        if DEFAULT_SPLIT_METHOD == SPLIT_METHOD_HSMM:
            melisma_segs = detect_melisma_in_syllable_hsmm(
                m_slice,
                c_slice,
                r_slice,
                note_start,
                w_end,
                frame_dur=frame_dur,
                scale_pcs=scale_pcs,
                has_melisma_marker=has_melisma_marker,
            )
        else:
            melisma_res = detect_melisma_in_syllable(
                m_slice,
                c_slice,
                r_slice,
                note_start,
                w_end,
                frame_dur,
                min_split_dur=0.35 if has_melisma_marker else 0.55,
                min_semitone_diff=1.4 if has_melisma_marker else 1.8,
            )
            if melisma_res:
                t_split, p1_f, p1_i, p2_f, p2_i, _ = melisma_res
                melisma_segs = [
                    (note_start, t_split, p1_f, p1_i),
                    (t_split, w_end, p2_f, p2_i),
                ]

        if melisma_segs and len(melisma_segs) >= 2:
            clean_word = raw_word.rstrip("~").rstrip("-").rstrip(" ")
            items = []
            s_idx_start = len(syllable_items)

            for m_idx, (t0, t1, pf, pi) in enumerate(melisma_segs):
                m_sf = max(sf_idx, min(total_frames - 1, int(t0 / frame_dur)))
                m_ef = max(m_sf + 1, min(total_frames, int(t1 / frame_dur)))
                is_first = (m_idx == 0)
                n_start = note_start if is_first else t0
                txt = f"{clean_word}-" if is_first else "~ "
                items.append({
                    "start": w_start if is_first else t0,
                    "note_start": n_start,
                    "end": t1,
                    "text": txt,
                    "midi": midi_float[m_sf:m_ef],
                    "conf": conf[m_sf:m_ef],
                    "rms": rms[m_sf:m_ef],
                    "is_phrase_break": is_phrase_break if is_first else False,
                    "pause_beat": pause_beat if is_first else None,
                    "fallback_pitch": pf,
                })

            syllable_items.extend(items)
            word_indices.append((s_idx_start, len(items)))
        else:
            item = {
                "start": w_start,
                "note_start": note_start,
                "end": w_end,
                "text": raw_word,
                "midi": m_slice,
                "conf": c_slice,
                "rms": r_slice,
                "is_phrase_break": is_phrase_break,
                "pause_beat": pause_beat,
                "fallback_pitch": float(np.nanmedian(m_slice)) if np.any(~np.isnan(m_slice)) else 60.0,
            }
            s_idx_start = len(syllable_items)
            syllable_items.append(item)
            word_indices.append((s_idx_start, 1))

    # 4. Scale-Constrained Viterbi HMM Optimization
    quantizer = ViterbiHMMQuantizer(
        transition_weight=0.35,
        scale_penalty=0.15,
        octave_jump_penalty=4.5,
        scale_pcs=scale_pcs,
        key_confidence=key_conf,
        cand_range=cand_range,
    )
    optimal_pitches = quantizer.quantize_sequence(syllable_items)

    # 5. Assemble Structured Word-Notes Output
    word_notes_list: List[Dict[str, Any]] = []
    for s_idx_start, num_notes in word_indices:
        raw_notes = []
        pause_beat = syllable_items[s_idx_start]["pause_beat"]

        for i in range(num_notes):
            s_item = syllable_items[s_idx_start + i]
            chosen_pitch = optimal_pitches[s_idx_start + i]
            fb_pitch = float(s_item.get("fallback_pitch", chosen_pitch))
            octave_shift = round((chosen_pitch - fb_pitch) / 12.0) * 12
            p_float = fb_pitch + octave_shift
            raw_notes.append({
                "start": s_item["start"],
                "note_start": s_item.get("note_start", s_item["start"]),
                "end": s_item["end"],
                "pitch": chosen_pitch,
                "pitch_float": p_float,
                "text": s_item["text"],
            })

        word_notes_list.append({
            "pause_beat": pause_beat,
            "notes": raw_notes,
            "num_sylls": num_notes,
        })

    return word_notes_list
