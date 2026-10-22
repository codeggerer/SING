"""
Evaluation metrics for AI Karaoke Generator benchmark harness.

Implements all metrics specified in PLAN.md Phase 1:
1. Pitch accuracy (duration-weighted strict ±0, ±1 semitone, and octave-agnostic mod 12).
2. Onset error (median and P90 absolute error in ms via monotone DTW text alignment).
3. Duration error (median relative error).
4. Lyrics accuracy (WER and CER on normalized text).
5. False split rate (share of truth syllables matched by >1 generated note).
"""

from __future__ import annotations
import math
import re
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Tuple, Optional, Sequence


# ==============================================================================
# 1. Text Normalization & Edit Distance (WER / CER)
# ==============================================================================

def normalize_text(text: str) -> str:
    """
    Lowercase and strip punctuation, keeping alphanumeric characters and spaces.
    Preserves international unicode characters (e.g. ä, ö, ü, ß, é, etc.).
    """
    if not text:
        return ""
    # Strip tilde (melisma marker)
    text = text.replace("~", "")
    # Lowercase
    text = text.lower()
    # Strip punctuation (keep unicode letters, numbers, and whitespace)
    text = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE)
    # Normalize whitespace
    return " ".join(text.split())


def levenshtein_distance(seq1: Sequence[Any], seq2: Sequence[Any]) -> int:
    """
    Compute standard Levenshtein edit distance between two sequences (strings or token lists).
    Uses O(min(len1, len2)) memory.
    """
    if len(seq1) < len(seq2):
        return levenshtein_distance(seq2, seq1)
    if not seq2:
        return len(seq1)

    previous_row = list(range(len(seq2) + 1))
    for i, c1 in enumerate(seq1):
        current_row = [i + 1] + [0] * len(seq2)
        for j, c2 in enumerate(seq2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (0 if c1 == c2 else 1)
            current_row[j + 1] = min(insertions, deletions, substitutions)
        previous_row = current_row

    return previous_row[-1]


def compute_cer(ref: str, hyp: str) -> float:
    """
    Character Error Rate (CER) on normalized text.
    CER = Levenshtein(ref, hyp) / len(ref).
    """
    norm_ref = normalize_text(ref)
    norm_hyp = normalize_text(hyp)
    if not norm_ref:
        return 0.0 if not norm_hyp else 1.0
    dist = levenshtein_distance(norm_ref, norm_hyp)
    return dist / len(norm_ref)


def compute_wer(ref: str, hyp: str) -> float:
    """
    Word Error Rate (WER) on normalized text tokens.
    WER = Levenshtein(ref_words, hyp_words) / len(ref_words).
    """
    norm_ref = normalize_text(ref)
    norm_hyp = normalize_text(hyp)
    ref_words = norm_ref.split()
    hyp_words = norm_hyp.split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    dist = levenshtein_distance(ref_words, hyp_words)
    return dist / len(ref_words)


# ==============================================================================
# 2. Monotone DTW Syllable Alignment
# ==============================================================================

def align_syllables_dtw(
    truth_notes: List[Dict[str, Any]],
    gen_notes: List[Dict[str, Any]],
    time_weight: float = 0.05,
) -> List[Tuple[int, int]]:
    """
    Monotone Dynamic Time Warping (DTW) to align truth notes (syllables) with generated notes.
    Cost combines normalized character edit distance and timing proximity.
    Returns list of matched pairs (truth_idx, gen_idx).
    """
    M = len(truth_notes)
    N = len(gen_notes)
    if M == 0 or N == 0:
        return []

    # Precompute normalized texts
    truth_texts = [normalize_text(str(n.get("text", ""))) for n in truth_notes]
    gen_texts = [normalize_text(str(n.get("text", ""))) for n in gen_notes]

    # Precompute cost matrix
    cost_matrix: List[List[float]] = [[0.0] * N for _ in range(M)]
    for i in range(M):
        t_txt = truth_texts[i]
        t_start = float(truth_notes[i].get("start_sec", 0.0))
        t_len = max(1, len(t_txt))
        for j in range(N):
            g_txt = gen_texts[j]
            g_start = float(gen_notes[j].get("start_sec", 0.0))
            g_len = max(1, len(g_txt))
            text_dist = levenshtein_distance(t_txt, g_txt) / max(t_len, g_len)
            time_diff = abs(t_start - g_start)
            time_penalty = time_weight * min(15.0, time_diff)
            cost_matrix[i][j] = text_dist + time_penalty

    # Cumulative cost matrix D
    dp: List[List[float]] = [[float("inf")] * N for _ in range(M)]
    dp[0][0] = cost_matrix[0][0]

    for j in range(1, N):
        dp[0][j] = dp[0][j - 1] + cost_matrix[0][j]
    for i in range(1, M):
        dp[i][0] = dp[i - 1][0] + cost_matrix[i][0]

    for i in range(1, M):
        for j in range(1, N):
            dp[i][j] = cost_matrix[i][j] + min(
                dp[i - 1][j],       # deletion / insertion
                dp[i][j - 1],       # split
                dp[i - 1][j - 1]    # diagonal match
            )

    # Backtrack path from (M-1, N-1) to (0, 0)
    path = []
    i, j = M - 1, N - 1
    while i > 0 or j > 0:
        path.append((i, j))
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            prev_min = min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
            if prev_min == dp[i - 1][j - 1]:
                i -= 1
                j -= 1
            elif prev_min == dp[i - 1][j]:
                i -= 1
            else:
                j -= 1
    path.append((0, 0))
    path.reverse()
    return path


# ==============================================================================
# 3. Timing Metrics & False Split Rate
# ==============================================================================

def compute_timing_metrics(
    truth_notes: List[Dict[str, Any]],
    gen_notes: List[Dict[str, Any]],
    alignment: Optional[List[Tuple[int, int]]] = None,
) -> Dict[str, float]:
    """
    Compute onset errors (median, P90 in ms), duration error (median relative),
    and false split rate based on DTW alignment.
    """
    if not truth_notes or not gen_notes:
        return {
            "onset_error_median_ms": 0.0,
            "onset_error_p90_ms": 0.0,
            "duration_error_median": 0.0,
            "false_split_rate": 0.0,
        }

    if alignment is None:
        alignment = align_syllables_dtw(truth_notes, gen_notes)

    # Group matched generated notes by truth index
    truth_to_gen: Dict[int, List[int]] = {}
    for t_idx, g_idx in alignment:
        truth_to_gen.setdefault(t_idx, []).append(g_idx)

    onset_errors_ms: List[float] = []
    dur_relative_errors: List[float] = []
    split_count = 0

    for t_idx, g_indices in truth_to_gen.items():
        if not g_indices:
            continue

        if len(g_indices) > 1:
            split_count += 1

        t_note = truth_notes[t_idx]
        t_start = float(t_note.get("start_sec", 0.0))
        t_end = float(t_note.get("end_sec", 0.0))
        t_dur = max(0.01, t_end - t_start)

        # Matched generated timing spans all aligned notes
        matched_gens = [gen_notes[g] for g in g_indices]
        g_start = min(float(g.get("start_sec", 0.0)) for g in matched_gens)
        g_end = max(float(g.get("end_sec", 0.0)) for g in matched_gens)
        g_dur = max(0.0, g_end - g_start)

        onset_err_ms = abs(g_start - t_start) * 1000.0
        onset_errors_ms.append(onset_err_ms)

        dur_err_rel = abs(g_dur - t_dur) / t_dur
        dur_relative_errors.append(dur_err_rel)

    # Median and P90 of onset errors
    if onset_errors_ms:
        sorted_onsets = sorted(onset_errors_ms)
        mid = len(sorted_onsets) // 2
        median_onset = sorted_onsets[mid] if len(sorted_onsets) % 2 != 0 else (sorted_onsets[mid - 1] + sorted_onsets[mid]) / 2.0
        p90_idx = int(math.ceil(0.90 * len(sorted_onsets))) - 1
        p90_onset = sorted_onsets[max(0, min(len(sorted_onsets) - 1, p90_idx))]
    else:
        median_onset = 0.0
        p90_onset = 0.0

    # Median relative duration error
    if dur_relative_errors:
        sorted_durs = sorted(dur_relative_errors)
        mid = len(sorted_durs) // 2
        median_dur = sorted_durs[mid] if len(sorted_durs) % 2 != 0 else (sorted_durs[mid - 1] + sorted_durs[mid]) / 2.0
    else:
        median_dur = 0.0

    false_split_rate = split_count / len(truth_notes) if truth_notes else 0.0

    return {
        "onset_error_median_ms": round(median_onset, 2),
        "onset_error_p90_ms": round(p90_onset, 2),
        "duration_error_median": round(median_dur, 4),
        "false_split_rate": round(false_split_rate, 4),
    }


# ==============================================================================
# 4. Duration-Weighted Pitch Accuracy
# ==============================================================================

def compute_pitch_accuracy(
    truth_notes: List[Dict[str, Any]],
    gen_notes: List[Dict[str, Any]],
    anchor_octave: bool = False,
    scale_pcs: Optional[Set[int]] = None,
) -> Dict[str, float]:
    """
    Compute duration-weighted pitch accuracy:
    - strict ±0 semitones (anchored to song octave register)
    - strict ±1 semitone (anchored to song octave register)
    - octave-agnostic (mod 12) ±0 semitones
    - octave-agnostic (mod 12) ±1 semitone
    - raw strict ±0 and ±1 without octave anchoring
    - in-scale pitch adherence rate (if scale_pcs provided)
    Calculated over all overlapping time segments between pitched truth notes and generated notes.
    """
    # Filter out unpitched notes (e.g. Freestyle 'F')
    pitched_truth = [
        n for n in truth_notes
        if n.get("type") not in ("F", "R") and float(n.get("end_sec", 0.0)) > float(n.get("start_sec", 0.0))
    ]
    valid_gen = [
        n for n in gen_notes
        if float(n.get("end_sec", 0.0)) > float(n.get("start_sec", 0.0))
    ]

    total_overlap_sec = 0.0
    overlaps: List[Tuple[float, int, int]] = []

    for g in valid_gen:
        g_s = float(g.get("start_sec", 0.0))
        g_e = float(g.get("end_sec", 0.0))
        g_pitch = int(g.get("pitch", 0))

        for t in pitched_truth:
            t_s = float(t.get("start_sec", 0.0))
            t_e = float(t.get("end_sec", 0.0))
            t_pitch = int(t.get("pitch", 0))

            overlap = max(0.0, min(g_e, t_e) - max(g_s, t_s))
            if overlap <= 0.0:
                continue

            total_overlap_sec += overlap
            overlaps.append((overlap, g_pitch, t_pitch))

    if total_overlap_sec <= 0.0:
        return {
            "pitch_strict_0": 0.0,
            "pitch_strict_1": 0.0,
            "pitch_octave_0": 0.0,
            "pitch_octave_1": 0.0,
            "raw_pitch_strict_0": 0.0,
            "raw_pitch_strict_1": 0.0,
            "octave_shift": 0,
            "in_scale_rate": 0.0,
            "total_overlap_sec": 0.0,
        }

    # 1. Determine optimal octave anchor k* in [-4, 4]
    best_k = 0
    best_k_score = -1.0
    if anchor_octave:
        for k in range(-4, 5):
            k_score = 0.0
            for ov, gp, tp in overlaps:
                shifted_tp = tp + (12 * k)
                if abs(gp - shifted_tp) <= 1:
                    k_score += ov
            # Slight tie-breaker preference for k=0 (standard pitch)
            if k == 0:
                k_score += 1e-6
            if k_score > best_k_score:
                best_k_score = k_score
                best_k = k

    # 2. Compute weighted metrics using best_k
    weighted_strict_0 = 0.0
    weighted_strict_1 = 0.0
    raw_strict_0 = 0.0
    raw_strict_1 = 0.0
    weighted_octave_0 = 0.0
    weighted_octave_1 = 0.0
    in_scale_dur = 0.0

    for ov, gp, tp in overlaps:
        # Anchored strict
        diff_anchored = abs(gp - (tp + 12 * best_k))
        if diff_anchored == 0:
            weighted_strict_0 += ov
        if diff_anchored <= 1:
            weighted_strict_1 += ov

        # Raw unanchored
        diff_raw = abs(gp - tp)
        if diff_raw == 0:
            raw_strict_0 += ov
        if diff_raw <= 1:
            raw_strict_1 += ov

        # Octave-agnostic error (mod 12)
        diff_mod = abs((gp % 12) - (tp % 12))
        diff_oct = min(diff_mod, 12 - diff_mod)
        if diff_oct == 0:
            weighted_octave_0 += ov
        if diff_oct <= 1:
            weighted_octave_1 += ov

        # In-scale check
        if scale_pcs is not None:
            if (gp % 12) in scale_pcs:
                in_scale_dur += ov

    in_scale_rate = round(in_scale_dur / total_overlap_sec, 4) if scale_pcs is not None else 1.0

    return {
        "pitch_strict_0": round(weighted_strict_0 / total_overlap_sec, 4),
        "pitch_strict_1": round(weighted_strict_1 / total_overlap_sec, 4),
        "pitch_octave_0": round(weighted_octave_0 / total_overlap_sec, 4),
        "pitch_octave_1": round(weighted_octave_1 / total_overlap_sec, 4),
        "raw_pitch_strict_0": round(raw_strict_0 / total_overlap_sec, 4),
        "raw_pitch_strict_1": round(raw_strict_1 / total_overlap_sec, 4),
        "octave_shift": best_k,
        "in_scale_rate": in_scale_rate,
        "total_overlap_sec": round(total_overlap_sec, 2),
    }


# ==============================================================================
# 5. Composite Evaluation Result
# ==============================================================================

@dataclass
class EvalMetrics:
    pitch_strict_0: float
    pitch_strict_1: float
    pitch_octave_0: float
    pitch_octave_1: float
    onset_error_median_ms: float
    onset_error_p90_ms: float
    duration_error_median: float
    lyrics_wer: float
    lyrics_cer: float
    false_split_rate: float
    truth_note_count: int
    gen_note_count: int
    total_overlap_sec: float
    octave_shift: int = 0
    raw_pitch_strict_0: float = 0.0
    raw_pitch_strict_1: float = 0.0
    in_scale_rate: float = 1.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def evaluate_chart(
    truth_notes: List[Dict[str, Any]],
    gen_notes: List[Dict[str, Any]],
    anchor_octave: bool = False,
    scale_pcs: Optional[Set[int]] = None,
) -> EvalMetrics:
    """
    Run full metric suite comparing a generated note list against truth notes.
    """
    # 1. Pitch
    pitch_res = compute_pitch_accuracy(truth_notes, gen_notes, anchor_octave=anchor_octave, scale_pcs=scale_pcs)

    # 2. Timing & False Splits
    timing_res = compute_timing_metrics(truth_notes, gen_notes)

    # 3. Lyrics WER & CER
    truth_text = "".join(str(n.get("text", "")) for n in truth_notes)
    gen_text = "".join(str(n.get("text", "")) for n in gen_notes)
    wer = round(compute_wer(truth_text, gen_text), 4)
    cer = round(compute_cer(truth_text, gen_text), 4)

    return EvalMetrics(
        pitch_strict_0=pitch_res["pitch_strict_0"],
        pitch_strict_1=pitch_res["pitch_strict_1"],
        pitch_octave_0=pitch_res["pitch_octave_0"],
        pitch_octave_1=pitch_res["pitch_octave_1"],
        onset_error_median_ms=timing_res["onset_error_median_ms"],
        onset_error_p90_ms=timing_res["onset_error_p90_ms"],
        duration_error_median=timing_res["duration_error_median"],
        lyrics_wer=wer,
        lyrics_cer=cer,
        false_split_rate=timing_res["false_split_rate"],
        truth_note_count=len(truth_notes),
        gen_note_count=len(gen_notes),
        total_overlap_sec=pitch_res["total_overlap_sec"],
        octave_shift=pitch_res["octave_shift"],
        raw_pitch_strict_0=pitch_res["raw_pitch_strict_0"],
        raw_pitch_strict_1=pitch_res["raw_pitch_strict_1"],
        in_scale_rate=pitch_res["in_scale_rate"],
    )
