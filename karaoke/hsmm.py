"""
Hidden Semi-Markov Model (HSMM) / Viterbi Note Decoding (Issue #2).

Provides globally optimal discrete-time note transcription within syllables:
1. Candidate MIDI note state space with optional soft musical scale prior
2. Energy- and confidence-weighted Gaussian emission likelihood
3. Semi-Markov minimum dwell duration constraint (anti-vibrato regularizer)
4. Smooth note transition penalty proportional to interval jumps
5. Robust handling of vocal scoops, glides, and rapid melisma runs
"""

from __future__ import annotations
import numpy as np
import scipy.signal
from typing import Dict, Any, List, Tuple, Optional, Set


def viterbi_decode_notes_hsmm(
    midis: np.ndarray,
    confs: np.ndarray,
    rms: Optional[np.ndarray] = None,
    frame_dur_sec: float = 0.010,
    min_dwell_sec: float = 0.080,
    switch_cost: float = 10.0,
    jump_cost: float = 0.5,
    sigma_semitones: float = 0.6,
    scale_pcs: Optional[Set[int]] = None,
    scale_penalty: float = 0.6,
    fallback_pitch: float = 60.0,
    filter_scoops: bool = True,
) -> List[Tuple[int, int, float, int]]:
    """
    Decodes the optimal sequence of distinct notes from a continuous pitch contour.
    
    Returns:
        List of (start_frame, end_frame, pitch_float, pitch_int) tuples.
    """
    T = len(midis)
    if T == 0:
        return []

    voiced_mask = (~np.isnan(midis)) & (confs >= 0.35)
    total_voiced = int(np.sum(voiced_mask))
    if total_voiced < 5:
        p_int = int(round(fallback_pitch))
        return [(0, T, fallback_pitch, p_int)]

    voiced_midis = midis[voiced_mask]
    min_pitch = float(np.min(voiced_midis))
    max_pitch = float(np.max(voiced_midis))

    # If entire voiced pitch variation is less than 0.8 semitones and no scale prior is set,
    # it is unambiguously a single unconstrained note.
    if (scale_pcs is None or len(scale_pcs) == 0) and (max_pitch - min_pitch) < 0.8:
        med_p = float(np.median(voiced_midis))
        return [(0, T, med_p, int(round(med_p)))]

    # Portamento / continuous glide filter:
    # If the syllable contour is a continuous monotonic glide (R^2 > 0.70),
    # classify as natural portamento ornament rather than discrete melisma note sequence.
    if filter_scoops and len(voiced_midis) >= 15:
        voiced_indices = np.where(voiced_mask)[0]
        x_pts = voiced_indices.astype(float)
        y_pts = voiced_midis.astype(float)
        poly = np.polyfit(x_pts, y_pts, 1)
        slope = float(poly[0])
        y_pred = slope * x_pts + float(poly[1])
        ss_res = float(np.sum((y_pts - y_pred) ** 2))
        ss_tot = float(np.sum((y_pts - np.mean(y_pts)) ** 2))
        r2_linear = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-4 else 0.0

        if r2_linear > 0.70 and abs(slope) > 1e-4:
            mid_idx = len(y_pts) // 2
            slope_h1 = float(np.polyfit(x_pts[:mid_idx], y_pts[:mid_idx], 1)[0])
            slope_h2 = float(np.polyfit(x_pts[mid_idx:], y_pts[mid_idx:], 1)[0])

            y_smooth = scipy.signal.medfilt(y_pts, 5) if len(y_pts) >= 5 else y_pts
            diffs = np.diff(y_smooth)
            # In a continuous portamento glide, pitch moves steadily throughout almost all frames (> 60%).
            # In a discrete melisma run, pitch stays on stable plateaus (moving frames < 40%).
            pct_moving = float(np.mean(np.abs(diffs) > 0.02)) if len(diffs) > 0 else 0.0

            if pct_moving >= 0.60:
                if slope > 0:
                    is_monotonic = (slope_h1 >= 0.20 * slope) and (slope_h2 >= 0.20 * slope) and (np.mean(diffs >= -0.10) >= 0.85)
                else:
                    is_monotonic = (slope_h1 <= 0.20 * slope) and (slope_h2 <= 0.20 * slope) and (np.mean(diffs <= 0.10) >= 0.85)

                if is_monotonic:
                    med_p = float(np.median(voiced_midis))
                    return [(0, T, med_p, int(round(med_p)))]

    min_m = max(20, int(np.floor(min_pitch)) - 1)
    max_m = min(108, int(np.ceil(max_pitch)) + 1)
    candidates = np.arange(min_m, max_m + 1)
    K = len(candidates)
    if K <= 1:
        med_p = float(np.median(voiced_midis))
        return [(0, T, med_p, int(round(med_p)))]

    d_min = max(2, int(round(min_dwell_sec / frame_dur_sec)))
    if T < d_min:
        med_p = float(np.median(voiced_midis))
        return [(0, T, med_p, int(round(med_p)))]

    # Frame weights
    if rms is not None and len(rms) == T:
        v_rms = rms[voiced_mask]
        max_r = float(np.max(v_rms)) if len(v_rms) > 0 else 1.0
        norm_rms = np.clip(rms / max(1e-4, max_r), 0.2, 1.0)
        weights = confs * norm_rms
    else:
        weights = confs

    # Scale prior penalty
    scale_pen = np.zeros(K, dtype=float)
    if scale_pcs is not None and len(scale_pcs) > 0:
        for k_idx, m in enumerate(candidates):
            if (int(m) % 12) not in scale_pcs:
                scale_pen[k_idx] = scale_penalty

    # Precompute emission log-likelihood cost E[t, k]
    E = np.zeros((T, K), dtype=float)
    denom = 2.0 * (sigma_semitones ** 2)
    for k_idx, m in enumerate(candidates):
        diff = midis - m
        E[:, k_idx] = np.where(
            voiced_mask,
            weights * (diff ** 2) / denom + scale_pen[k_idx],
            scale_pen[k_idx]
        )

    # Dynamic Programming:
    # State: (k, d) where k in [0, K-1], d in [1, d_min]
    INF = 1e9
    V = np.full((T, K, d_min + 1), INF, dtype=float)
    back_k = np.zeros((T, K, d_min + 1), dtype=int)
    back_d = np.zeros((T, K, d_min + 1), dtype=int)

    # Initialization: allow starting at any note with d = 1
    for k in range(K):
        V[0, k, 1] = E[0, k]

    # Precompute jump transition penalties
    cand_arr = candidates.astype(float)
    jump_pen = switch_cost + jump_cost * np.abs(cand_arr[:, None] - cand_arr[None, :])
    np.fill_diagonal(jump_pen, 0.0)

    # Forward Viterbi recursion
    for t in range(1, T):
        e_t = E[t]

        # 1. Stay in same state k:
        for d in range(1, d_min):
            cost = V[t - 1, :, d] + e_t
            mask = cost < V[t, :, d + 1]
            V[t, mask, d + 1] = cost[mask]
            back_k[t, mask, d + 1] = np.arange(K)[mask]
            back_d[t, mask, d + 1] = d

        cost_stay_max = V[t - 1, :, d_min] + e_t
        mask_stay = cost_stay_max < V[t, :, d_min]
        V[t, mask_stay, d_min] = cost_stay_max[mask_stay]
        back_k[t, mask_stay, d_min] = np.arange(K)[mask_stay]
        back_d[t, mask_stay, d_min] = d_min

        # 2. Switch note from any state where d == d_min
        prev_ready = V[t - 1, :, d_min]
        if np.any(prev_ready < INF):
            for k in range(K):
                trans = prev_ready + jump_pen[:, k]
                trans[k] = INF
                best_j = int(np.argmin(trans))
                tot = trans[best_j] + e_t[k]
                if tot < V[t, k, 1]:
                    V[t, k, 1] = tot
                    back_k[t, k, 1] = best_j
                    back_d[t, k, 1] = d_min

    # Termination: choose best ending state
    final_ready = V[T - 1, :, d_min]
    if np.min(final_ready) >= INF / 2:
        flat_idx = int(np.argmin(V[T - 1]))
        curr_k, curr_d = np.unravel_index(flat_idx, V[T - 1].shape)
    else:
        curr_k = int(np.argmin(final_ready))
        curr_d = d_min

    # Backtracking
    opt_pitches = np.zeros(T, dtype=int)
    opt_pitches[T - 1] = int(candidates[curr_k])
    for t in range(T - 1, 0, -1):
        prev_k = back_k[t, curr_k, curr_d]
        prev_d = back_d[t, curr_k, curr_d]
        curr_k, curr_d = prev_k, prev_d
        opt_pitches[t - 1] = int(candidates[curr_k])

    # Extract contiguous runs
    raw_segments: List[Tuple[int, int, float, int]] = []
    run_s = 0
    run_p = opt_pitches[0]

    for t in range(1, T):
        if opt_pitches[t] != run_p:
            seg_midis = midis[run_s:t]
            seg_mask = voiced_mask[run_s:t]
            p_float = float(np.median(seg_midis[seg_mask])) if np.any(seg_mask) else float(run_p)
            raw_segments.append((run_s, t, p_float, int(run_p)))
            run_s = t
            run_p = opt_pitches[t]

    seg_midis = midis[run_s:T]
    seg_mask = voiced_mask[run_s:T]
    p_float = float(np.median(seg_midis[seg_mask])) if np.any(seg_mask) else float(run_p)
    raw_segments.append((run_s, T, p_float, int(run_p)))

    if len(raw_segments) <= 1 or not filter_scoops:
        return raw_segments

    # Post-processing: Scoop / Glide attack and release filter
    # If the first segment is an onset scoop (e.g. <= 100 ms, <= 2 semitone diff into a longer note):
    # merge it into the main note.
    cleaned_segments = list(raw_segments)

    # Check attack scoop on segment 0
    if len(cleaned_segments) >= 2:
        s0_len = cleaned_segments[0][1] - cleaned_segments[0][0]
        s1_len = cleaned_segments[1][1] - cleaned_segments[1][0]
        s0_dur_sec = s0_len * frame_dur_sec
        pitch_diff = abs(cleaned_segments[0][3] - cleaned_segments[1][3])

        if s0_dur_sec <= 0.120 and pitch_diff <= 2 and s1_len >= 2 * s0_len:
            # Scoop attack: merge s0 into s1
            new_s1_start = cleaned_segments[0][0]
            new_s1_end = cleaned_segments[1][1]
            seg_midis = midis[new_s1_start:new_s1_end]
            seg_mask = voiced_mask[new_s1_start:new_s1_end]
            target_p = cleaned_segments[1][3]
            p_float = float(np.median(seg_midis[seg_mask])) if np.any(seg_mask) else float(target_p)
            cleaned_segments[1] = (new_s1_start, new_s1_end, p_float, target_p)
            cleaned_segments.pop(0)

    # Check release glide on the last segment
    if len(cleaned_segments) >= 2:
        slast_len = cleaned_segments[-1][1] - cleaned_segments[-1][0]
        sprev_len = cleaned_segments[-2][1] - cleaned_segments[-2][0]
        slast_dur_sec = slast_len * frame_dur_sec
        pitch_diff = abs(cleaned_segments[-1][3] - cleaned_segments[-2][3])

        if slast_dur_sec <= 0.080 and pitch_diff <= 2 and sprev_len >= 2 * slast_len:
            new_prev_start = cleaned_segments[-2][0]
            new_prev_end = cleaned_segments[-1][1]
            seg_midis = midis[new_prev_start:new_prev_end]
            seg_mask = voiced_mask[new_prev_start:new_prev_end]
            target_p = cleaned_segments[-2][3]
            p_float = float(np.median(seg_midis[seg_mask])) if np.any(seg_mask) else float(target_p)
            cleaned_segments[-2] = (new_prev_start, new_prev_end, p_float, target_p)
            cleaned_segments.pop(-1)

    return cleaned_segments


def detect_syllable_split_hsmm(
    pitch_data: Dict[str, Any],
    start_sec: float,
    end_sec: float,
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
    has_tilde: bool = False,
    fallback_pitch: float = 60.0,
    scale_pcs: Optional[Set[int]] = None,
    min_dwell_sec: float = 0.080,
    switch_cost: float = 10.0,
) -> Optional[List[Tuple[float, float, float, int]]]:
    """
    Syllable melisma detection and sequence segmentation via HSMM Viterbi optimization.
    
    Returns:
        List of (seg_start_sec, seg_end_sec, seg_pitch_float, seg_pitch_int) if syllable
        contains a multi-note melisma or vocal run, or None if it is a single note.
    """
    dur = end_sec - start_sec
    # A single note shorter than 160 ms without tilde is unlikely to be a multi-note melisma
    if dur < 0.160 and not has_tilde:
        return None

    frame_dur = pitch_data.get("frame_dur_sec", 0.010)
    sf_idx = max(0, int(round(start_sec / frame_dur)))
    ef_idx = min(pitch_data.get("total_frames", len(pitch_data.get("midi", []))), int(round(end_sec / frame_dur)))

    if ef_idx - sf_idx < 8:
        return None

    midi_arr = pitch_data.get("midi") if "midi" in pitch_data else pitch_data.get("pitches")
    if midi_arr is None:
        return None

    midis = midi_arr[sf_idx:ef_idx]
    confs = pitch_data["conf"][sf_idx:ef_idx]
    rms = pitch_data.get("rms")[sf_idx:ef_idx] if "rms" in pitch_data else None

    # Syllables with explicit tilde marker allow slightly faster note transitions (60ms)
    effective_dwell = 0.060 if has_tilde else min_dwell_sec
    effective_switch = max(6.0, switch_cost - 3.0) if has_tilde else switch_cost

    segments = viterbi_decode_notes_hsmm(
        midis=midis,
        confs=confs,
        rms=rms,
        frame_dur_sec=frame_dur,
        min_dwell_sec=effective_dwell,
        switch_cost=effective_switch,
        jump_cost=0.5,
        sigma_semitones=0.6,
        scale_pcs=scale_pcs,
        scale_penalty=0.6,
        fallback_pitch=fallback_pitch,
        filter_scoops=True,
    )

    if len(segments) <= 1:
        return None

    # Check Basic Pitch confirmation if available
    if basic_pitch_notes:
        from karaoke.basicpitch_adapter import BasicPitchAdapter
        # Verify that at least one transition is corroborated
        has_agreement = False
        for s_idx in range(len(segments) - 1):
            split_t = start_sec + (segments[s_idx][1] * frame_dur)
            if BasicPitchAdapter.votes_for_split(basic_pitch_notes, start_sec, end_sec, split_t, margin_sec=0.10):
                has_agreement = True
                break
        if not has_agreement:
            # Basic pitch does not agree with any split: reject melisma
            return None

    # Convert frame indices to seconds
    result = []
    for (s_frame, e_frame, pf, pi) in segments:
        seg_s = round(start_sec + s_frame * frame_dur, 3)
        seg_e = round(start_sec + e_frame * frame_dur, 3)
        result.append((seg_s, seg_e, pf, pi))

    # Guarantee first segment starts at start_sec and last ends at end_sec
    if result:
        result[0] = (start_sec, result[0][1], result[0][2], result[0][3])
        result[-1] = (result[-1][0], end_sec, result[-1][2], result[-1][3])

    return result
