"""
High-Accuracy Pitch Tracking (FCPE / CREPE / pYIN), Contour Cleanup, Key Detection & Note Building.
"""

from __future__ import annotations
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple, Callable, Set
import numpy as np

try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import librosa
except ImportError:
    librosa = None

import scipy.signal

from karaoke.hardware import HardwareProfile, ModelSelection, detect_hardware, select_models
from karaoke.cache import StageCache
from karaoke.config import (
    VOCAL_FMIN_MALE, VOCAL_FMIN_FEMALE, VOCAL_FMAX,
    VOICED_PROB_THRESHOLD, RMS_FLOOR_DBFS, F0_MEDIAN_FILTER_SIZE,
    MIN_VOICED_RUN_FRAMES, OCTAVE_JUMP_TOLERANCE_ST, OCTAVE_NEIGHBOR_WINDOW_FRAMES,
    TUNING_MAX_CORRECTION_CENTS, VIBRATO_LPF_CUTOFF_HZ,
    SPLIT_MIN_SYLLABLE_DUR_SEC, SPLIT_MIN_PLATEAU_DUR_SEC, SPLIT_MIN_SEMITONE_DIFF,
    SPLIT_MAX_PLATEAU_STD_ST, SPLIT_TILDE_MIN_SEMITONE_DIFF,
    KEY_MIN_CONFIDENCE_FOR_SNAP, SCALE_SNAP_MAX_DEV_ST,
    PITCH_ENGINE_FCPE, PITCH_ENGINE_CREPE, PITCH_ENGINE_PYIN, PITCH_ENGINE_RMVPE,
)

# Krumhansl-Schmuckler Key Profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11]
MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10]


def compute_audio_rms(y: np.ndarray, sr: int, hop_length: int) -> np.ndarray:
    """Computes frame-level RMS energy."""
    if librosa is not None:
        rms = librosa.feature.rms(y=y, frame_length=hop_length * 2, hop_length=hop_length)[0]
    else:
        num_frames = int(len(y) / hop_length)
        rms = np.zeros(num_frames)
        for i in range(num_frames):
            frame = y[i * hop_length : (i + 1) * hop_length]
            rms[i] = np.sqrt(np.mean(frame ** 2) + 1e-8)
    return rms


def _analyze_key_chroma(audio_data: np.ndarray, sr: int) -> Tuple[int, str, float]:
    """Helper to detect key from audio array using Krumhansl-Schmuckler."""
    if librosa is None:
        return 0, "major", 0.0

    chroma = librosa.feature.chroma_cqt(y=audio_data, sr=sr).mean(axis=1)
    best_corr = -1.0
    best_root = 0
    best_mode = "major"

    for root in range(12):
        maj_prof = np.roll(MAJOR_PROFILE, root)
        corr_maj = np.corrcoef(chroma, maj_prof)[0, 1]
        if corr_maj > best_corr:
            best_corr = float(corr_maj)
            best_root = root
            best_mode = "major"

        min_prof = np.roll(MINOR_PROFILE, root)
        corr_min = np.corrcoef(chroma, min_prof)[0, 1]
        if corr_min > best_corr:
            best_corr = float(corr_min)
            best_root = root
            best_mode = "minor"

    return best_root, best_mode, best_corr


def detect_song_key(
    audio_path: Path | str,
    vocal_path: Optional[Path | str] = None,
    manual_key: str = "",
    stage_cache: Optional[StageCache] = None,
) -> Optional[Dict[str, Any]]:
    """
    PLAN.md Phase 5.5: Soft key prior.
    Detects key from vocal stem and from mix.
    If they agree, confidence is high. Otherwise lower the confidence.
    """
    if manual_key:
        clean_k = manual_key.strip()
        is_minor = 'm' in clean_k.lower() and 'maj' not in clean_k.lower()
        root_str = clean_k.replace('m', '').replace('M', '').replace('aj', '').strip()
        root_idx = 0
        for idx, name in enumerate(NOTE_NAMES):
            if name.lower() == root_str.lower() or name.replace('b', '#').lower() == root_str.lower():
                root_idx = idx
                break
        mode = "minor" if is_minor else "major"
        intervals = MINOR_INTERVALS if is_minor else MAJOR_INTERVALS
        scale_pcs = {(root_idx + iv) % 12 for iv in intervals}
        print(f"🎹 Manuelle Tonart gesetzt: {NOTE_NAMES[root_idx]} {mode.capitalize()}")
        return {
            "key": f"{NOTE_NAMES[root_idx]} {mode.capitalize()}",
            "root": root_idx,
            "mode": mode,
            "scale_pcs": scale_pcs,
            "confidence": 1.0,
        }

    if stage_cache:
        cached_key = stage_cache.load_key()
        if cached_key is not None:
            return cached_key

    if librosa is None:
        return None

    try:
        print("🎹 Erkenne Tonart (Key Detection) mit Librosa Chroma...")
        y_mix, sr_mix = librosa.load(str(audio_path), sr=22050, duration=75)
        root_mix, mode_mix, corr_mix = _analyze_key_chroma(y_mix, sr_mix)

        chosen_root = root_mix
        chosen_mode = mode_mix
        confidence = max(0.0, corr_mix)

        # Check vocal stem if provided
        if vocal_path is not None and Path(vocal_path).exists():
            try:
                y_voc, sr_voc = librosa.load(str(vocal_path), sr=22050, duration=75)
                root_voc, mode_voc, corr_voc = _analyze_key_chroma(y_voc, sr_voc)

                if root_voc == root_mix and mode_voc == mode_mix:
                    # Agreement! High confidence
                    confidence = min(1.0, max(corr_mix, corr_voc) * 1.15)
                    print(f"🎹 Mix & Gesang stimmen überein: {NOTE_NAMES[chosen_root]} {chosen_mode.capitalize()} (Konfidenz: {confidence:.2f})")
                else:
                    # Disagreement: lower confidence
                    if corr_voc > corr_mix:
                        chosen_root = root_voc
                        chosen_mode = mode_voc
                        confidence = corr_voc * 0.65
                    else:
                        confidence = corr_mix * 0.65
                    print(f"🎹 Mix ({NOTE_NAMES[root_mix]} {mode_mix}) und Gesang ({NOTE_NAMES[root_voc]} {mode_voc}) uneins. Konfidenz reduziert: {confidence:.2f}")
            except Exception:
                pass

        intervals = MAJOR_INTERVALS if chosen_mode == "major" else MINOR_INTERVALS
        scale_pcs = {(chosen_root + iv) % 12 for iv in intervals}
        key_name = f"{NOTE_NAMES[chosen_root]} {chosen_mode.capitalize()}"
        print(f"✅ Erkannte Tonart: {key_name} (Sicherheit: {confidence:.2f})")

        res = {
            "key": key_name,
            "root": chosen_root,
            "mode": chosen_mode,
            "scale_pcs": scale_pcs,
            "confidence": confidence,
        }

        if stage_cache:
            stage_cache.save_key(res)

        return res
    except Exception as e:
        print(f"⚠️ Tonart-Erkennung übersprungen ({e})")
        return None


def snap_pitch_to_scale(midi_val: float, scale_pcs: set) -> int:
    """Legacy hard snap: snaps to nearest in-scale tone (maintained for backward compatibility)."""
    if not scale_pcs:
        return int(round(midi_val))
    m = int(round(midi_val))
    if (m % 12) in scale_pcs:
        return m
    down_match = ((m - 1) % 12) in scale_pcs
    up_match = ((m + 1) % 12) in scale_pcs
    if down_match and not up_match:
        return m - 1
    if up_match and not down_match:
        return m + 1
    if down_match and up_match:
        return m - 1 if (midi_val - (m - 1) < (m + 1) - midi_val) else m + 1
    return m


def soft_snap_to_scale(
    midi_float: float,
    scale_pcs: Set[int],
    confidence: float = 1.0,
    max_dev_st: float = SCALE_SNAP_MAX_DEV_ST,
    min_confidence: float = KEY_MIN_CONFIDENCE_FOR_SNAP,
) -> int:
    """
    PLAN.md Phase 5.5: Soft scale prior.
    No snap at all when key confidence < 0.6.
    If |midi_float - nearest_scale_tone| <= 0.35 st, snap to that scale tone.
    Otherwise keep the rounded measured pitch.
    """
    if np.isnan(midi_float):
        return 60

    rounded = int(round(midi_float))
    if confidence < min_confidence or not scale_pcs:
        return rounded

    # If already on scale tone, keep
    if (rounded % 12) in scale_pcs:
        return rounded

    # Search nearest in-scale tone (within ±1 semitone)
    best_diff = 999.0
    best_candidate = rounded
    for offset in [-1, 1]:
        cand = rounded + offset
        if (cand % 12) in scale_pcs:
            diff = abs(midi_float - cand)
            if diff < best_diff:
                best_diff = diff
                best_candidate = cand

    if best_diff <= max_dev_st:
        return best_candidate

    return rounded


def track_f0(
    audio: np.ndarray,
    sr: int,
    pitch_engine: str = "fcpe",
    device: Optional[str] = None,
    vocal_range: str = "auto",
    crepe_model: str = "full",
) -> Dict[str, Any]:
    """
    PLAN.md Phase 5.2: Unified f0 tracker interface.
    track_f0(audio, sr) -> {t, f0_hz, voiced_prob} with 10 ms hop.
    Unvoiced frames have NaN for f0_hz.
    Supported engines: fcpe (default), crepe, pyin, rmvpe.
    """
    pitch_engine = pitch_engine.lower()
    hop_sec = 0.010  # 10 ms hop resolution

    if pitch_engine == PITCH_ENGINE_FCPE:
        return _track_f0_fcpe(audio, sr, device=device, hop_sec=hop_sec)
    elif pitch_engine == PITCH_ENGINE_CREPE:
        return _track_f0_crepe(audio, sr, device=device, model_name=crepe_model, vocal_range=vocal_range, hop_sec=hop_sec)
    elif pitch_engine == PITCH_ENGINE_PYIN:
        return _track_f0_pyin(audio, sr, vocal_range=vocal_range, hop_sec=hop_sec)
    elif pitch_engine == PITCH_ENGINE_RMVPE:
        try:
            return _track_f0_rmvpe(audio, sr, device=device, hop_sec=hop_sec)
        except Exception as e:
            print(f"⚠️ RMVPE nicht verfügbar ({e}), schalte auf FCPE um...")
            return _track_f0_fcpe(audio, sr, device=device, hop_sec=hop_sec)
    else:
        # Default to FCPE with fallback to pYIN
        try:
            return _track_f0_fcpe(audio, sr, device=device, hop_sec=hop_sec)
        except Exception as e:
            print(f"⚠️ FCPE fehlgeschlagen ({e}), weiche auf pYIN aus...")
            return _track_f0_pyin(audio, sr, vocal_range=vocal_range, hop_sec=hop_sec)


def _track_f0_fcpe(
    audio: np.ndarray,
    sr: int,
    device: Optional[str] = None,
    hop_sec: float = 0.010,
) -> Dict[str, Any]:
    """Fast Context-based Pitch Estimation (singing-oriented neural tracker)."""
    import torch
    import torchfcpe

    if device is None:
        if torch.backends.mps.is_available():
            device = "mps"
        elif torch.cuda.is_available():
            device = "cuda"
        else:
            device = "cpu"

    target_sr = 16000
    if sr != target_sr:
        if librosa is not None:
            audio_16k = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        else:
            audio_16k = audio
    else:
        audio_16k = audio

    # Ensure float32 tensor
    wav_tensor = torch.from_numpy(audio_16k.astype(np.float32)).unsqueeze(0)
    if device != "cpu":
        try:
            wav_tensor = wav_tensor.to(device)
        except Exception:
            device = "cpu"

    try:
        model = torchfcpe.spawn_bundled_infer_model(device=device)
    except Exception:
        model = torchfcpe.spawn_bundled_infer_model(device="cpu")

    # torchfcpe infer with 16kHz
    f0_tensor = model.infer(wav_tensor, sr=target_sr)
    f0_np = f0_tensor.squeeze().detach().cpu().numpy()

    # Unvoiced frames in torchfcpe return 0.0 -> map to NaN (Phase 5.2 requirement)
    f0_hz = np.where(f0_np > 0.0, f0_np, np.nan)
    voiced_prob = np.where(f0_np > 0.0, 1.0, 0.0)

    num_frames = len(f0_hz)
    t = np.arange(num_frames) * hop_sec

    return {
        "t": t,
        "f0_hz": f0_hz,
        "voiced_prob": voiced_prob,
        "hop_sec": hop_sec,
    }


def _track_f0_crepe(
    audio: np.ndarray,
    sr: int,
    device: Optional[str] = None,
    model_name: str = "full",
    vocal_range: str = "auto",
    hop_sec: float = 0.010,
) -> Dict[str, Any]:
    """CREPE Neural Pitch Tracking with Viterbi decoding."""
    import torch
    import torchcrepe

    target_sr = 16000
    if sr != target_sr:
        if librosa is not None:
            audio_16k = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        else:
            audio_16k = audio
    else:
        audio_16k = audio

    wav_tensor = torch.from_numpy(audio_16k.astype(np.float32)).unsqueeze(0)
    hop_length = int(target_sr * hop_sec)  # 160 samples = 10 ms

    if device is None:
        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")

    fmin = VOCAL_FMIN_MALE if vocal_range == "male" else VOCAL_FMIN_FEMALE
    fmax = VOCAL_FMAX

    pitch_hz_t, periodicity_t = torchcrepe.predict(
        wav_tensor,
        sample_rate=target_sr,
        hop_length=hop_length,
        fmin=fmin,
        fmax=fmax,
        model=model_name,
        decoder=torchcrepe.decode.weighted_argmax,
        batch_size=512,
        device=device,
        return_periodicity=True,
    )

    pitch_hz = pitch_hz_t.squeeze().cpu().numpy()
    voiced_prob = periodicity_t.squeeze().cpu().numpy()

    # Unvoiced frames: map to NaN (Phase 5.2 requirement)
    f0_hz = np.where(voiced_prob >= 0.25, pitch_hz, np.nan)
    num_frames = len(f0_hz)
    t = np.arange(num_frames) * hop_sec

    return {
        "t": t,
        "f0_hz": f0_hz,
        "voiced_prob": voiced_prob,
        "hop_sec": hop_sec,
    }


def _track_f0_pyin(
    audio: np.ndarray,
    sr: int,
    vocal_range: str = "auto",
    hop_sec: float = 0.010,
) -> Dict[str, Any]:
    """Librosa pYIN Viterbi tracking fallback."""
    if librosa is None:
        raise RuntimeError("Librosa ist erforderlich für pYIN.")

    hop_length = int(sr * hop_sec)
    fmin = VOCAL_FMIN_MALE if vocal_range == "male" else VOCAL_FMIN_FEMALE
    fmax = VOCAL_FMAX

    f0, voiced_flag, voiced_probs = librosa.pyin(
        audio,
        fmin=fmin,
        fmax=fmax,
        sr=sr,
        hop_length=hop_length,
        fill_na=None,
    )

    f0_hz = np.where(voiced_flag & ~np.isnan(f0) & (f0 > 0), f0, np.nan)
    voiced_prob = np.nan_to_num(voiced_probs, nan=0.0)

    num_frames = len(f0_hz)
    t = np.arange(num_frames) * hop_sec

    return {
        "t": t,
        "f0_hz": f0_hz,
        "voiced_prob": voiced_prob,
        "hop_sec": hop_sec,
    }


def _track_f0_rmvpe(
    audio: np.ndarray,
    sr: int,
    device: Optional[str] = None,
    hop_sec: float = 0.010,
) -> Dict[str, Any]:
    """RMVPE pitch tracker if installed, else raises ImportError."""
    import rmvpe  # noqa: F401
    raise NotImplementedError("RMVPE backend adapter")


def clean_f0(
    t: np.ndarray,
    f0_hz: np.ndarray,
    voiced_prob: np.ndarray,
    rms: np.ndarray,
    hop_sec: float = 0.010,
) -> Tuple[np.ndarray, np.ndarray, float]:
    """
    PLAN.md Phase 5.3: Complete 6-Step Contour Cleanup Pipeline.

    1. Mask frames with voiced_prob < 0.5 or RMS below -45 dBFS relative to file peak.
    2. 5-frame median filter on valid f0. Remove isolated voiced runs < 5 frames.
    3. Octave-jump repair by continuity: if a frame is ≈ ±12 st (±1 st tolerance)
       from the median of its voiced neighbours (±15 frames), shift it by ∓12.
    4. Global tuning estimate: histogram of (midi - round(midi)) * 100 in cents
       weighted by voiced prob; take circular mean of the mode. Subtract it (clamp ±50 cents).
    5. Convert to MIDI float; keep float until final rounding.
    6. Vibrato suppression: low-pass at ~5 Hz (Butterworth on voiced runs).

    Returns:
        midi_float (np.ndarray with NaNs for unvoiced),
        cleaned_voiced_prob (np.ndarray),
        tuning_cents (float)
    """
    n_frames = min(len(f0_hz), len(voiced_prob), len(rms))
    f0 = np.copy(f0_hz[:n_frames])
    v_prob = np.copy(voiced_prob[:n_frames])
    r = np.copy(rms[:n_frames])

    # 1. Masking: voiced_prob < 0.5 or RMS below -45 dBFS
    max_rms = float(np.max(r)) if len(r) > 0 and np.max(r) > 0 else 1.0
    rms_floor = max_rms * (10.0 ** (RMS_FLOOR_DBFS / 20.0))  # -45 dBFS
    mask_unvoiced = (v_prob < VOICED_PROB_THRESHOLD) | (r < rms_floor) | np.isnan(f0) | (f0 <= 0)
    f0[mask_unvoiced] = np.nan
    v_prob[mask_unvoiced] = 0.0

    # 2. 5-frame median filter & remove isolated voiced runs < 5 frames
    is_voiced = ~np.isnan(f0)
    # Find contiguous voiced segments
    segments = []
    in_seg = False
    seg_start = 0
    for idx in range(n_frames):
        if is_voiced[idx] and not in_seg:
            in_seg = True
            seg_start = idx
        elif not is_voiced[idx] and in_seg:
            in_seg = False
            segments.append((seg_start, idx))
    if in_seg:
        segments.append((seg_start, n_frames))

    for seg_s, seg_e in segments:
        seg_len = seg_e - seg_s
        if seg_len < MIN_VOICED_RUN_FRAMES:
            f0[seg_s:seg_e] = np.nan
            v_prob[seg_s:seg_e] = 0.0
        else:
            # Apply 5-frame median filter
            seg_f0 = f0[seg_s:seg_e]
            if seg_len >= 5:
                f0[seg_s:seg_e] = scipy.signal.medfilt(seg_f0, kernel_size=F0_MEDIAN_FILTER_SIZE)

    # 3. Octave-jump repair by continuity (±15 frames window, ±12 ±1 st)
    is_voiced = ~np.isnan(f0)
    w_size = OCTAVE_NEIGHBOR_WINDOW_FRAMES
    for idx in range(n_frames):
        if not is_voiced[idx]:
            continue

        left = max(0, idx - w_size)
        right = min(n_frames, idx + w_size + 1)
        # Neighbors excluding current frame
        nbrs = [f0[j] for j in range(left, right) if j != idx and is_voiced[j]]
        if len(nbrs) >= 3:
            nbr_median = float(np.median(nbrs))
            if nbr_median > 0:
                st_diff = 12.0 * np.log2(f0[idx] / nbr_median)
                # Check 1 octave (+12 st) jump
                if abs(st_diff - 12.0) <= OCTAVE_JUMP_TOLERANCE_ST:
                    f0[idx] /= 2.0
                # Check 1 octave (-12 st) drop
                elif abs(st_diff - (-12.0)) <= OCTAVE_JUMP_TOLERANCE_ST:
                    f0[idx] *= 2.0
                # Check 2 octave jump
                elif abs(st_diff - 24.0) <= OCTAVE_JUMP_TOLERANCE_ST:
                    f0[idx] /= 4.0
                # Check 2 octave drop
                elif abs(st_diff - (-24.0)) <= OCTAVE_JUMP_TOLERANCE_ST:
                    f0[idx] *= 4.0

    # 4. Convert to MIDI float
    with np.errstate(divide='ignore', invalid='ignore'):
        midi_float = np.where(~np.isnan(f0) & (f0 > 0), 69.0 + 12.0 * np.log2(np.maximum(1e-4, f0) / 440.0), np.nan)

    # 5. Global tuning estimate (circular mean of the mode in cents)
    valid_voiced = ~np.isnan(midi_float)
    tuning_cents = 0.0
    if np.sum(valid_voiced) >= 30:
        valid_midis = midi_float[valid_voiced]
        valid_weights = v_prob[valid_voiced] * (r[valid_voiced] + 1e-4)

        # Deviation in cents (-50 to +50 cents)
        cents_dev = (valid_midis - np.round(valid_midis)) * 100.0

        # Histogram with 50 bins
        hist, bin_edges = np.histogram(cents_dev, bins=50, range=(-50.0, 50.0), weights=valid_weights)
        mode_bin = int(np.argmax(hist))

        # Frames in mode and its immediate neighbor bins
        bin_w = bin_edges[1] - bin_edges[0]
        mode_center = (bin_edges[mode_bin] + bin_edges[mode_bin + 1]) / 2.0
        mode_mask = np.abs(cents_dev - mode_center) <= (bin_w * 2.0)

        if np.any(mode_mask):
            angles = cents_dev[mode_mask] * (2.0 * np.pi / 100.0)
            w_mode = valid_weights[mode_mask]
            mean_sin = np.sum(w_mode * np.sin(angles))
            mean_cos = np.sum(w_mode * np.cos(angles))
            circ_angle = np.arctan2(mean_sin, mean_cos)
            tuning_cents = float(np.clip(circ_angle * (100.0 / (2.0 * np.pi)), -TUNING_MAX_CORRECTION_CENTS, TUNING_MAX_CORRECTION_CENTS))
            # Subtract global tuning offset
            midi_float = midi_float - (tuning_cents / 100.0)

    # 6. Vibrato suppression: Butterworth low-pass at ~5 Hz on voiced runs
    # Sampling frequency of frames is 100 Hz (10 ms hop), Nyquist = 50 Hz.
    # Wn = 5.0 / 50.0 = 0.1
    b, a = scipy.signal.butter(2, VIBRATO_LPF_CUTOFF_HZ / (0.5 / hop_sec), btype='low')
    # Re-identify voiced segments after cleanup
    is_voiced = ~np.isnan(midi_float)
    segments = []
    in_seg = False
    seg_start = 0
    for idx in range(n_frames):
        if is_voiced[idx] and not in_seg:
            in_seg = True
            seg_start = idx
        elif not is_voiced[idx] and in_seg:
            in_seg = False
            segments.append((seg_start, idx))
    if in_seg:
        segments.append((seg_start, n_frames))

    for seg_s, seg_e in segments:
        seg_len = seg_e - seg_s
        if seg_len >= 15:
            try:
                midi_float[seg_s:seg_e] = scipy.signal.filtfilt(b, a, midi_float[seg_s:seg_e])
            except Exception:
                pass

    return midi_float, v_prob, tuning_cents


def analyze_vocal_pitch(
    vocals_path: Path | str,
    pitch_engine: str = "fcpe",
    crepe_model: str = "full",
    vocal_range: str = "auto",
    hardware_profile: Optional[HardwareProfile] = None,
    model_selection: Optional[ModelSelection] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Dict[str, Any]:
    """
    Extracts continuous fundamental pitch (f0) contour and frame confidence.
    Follows Phase 5 pipeline with clean_f0 post-processing.
    """
    if progress_cb:
        progress_cb("pitch", 0.0, f"Analyzing pitch ({pitch_engine})...")

    # Check cache first
    if stage_cache:
        cached_f0 = stage_cache.load_f0(pitch_engine=pitch_engine, crepe_model=crepe_model)
        if cached_f0 is not None:
            print(f"⚡ Verwende gecachte f0 Pitch-Kontur ({pitch_engine}): {cached_f0['total_frames']} Frames")
            if progress_cb:
                progress_cb("pitch", 1.0, f"Loaded {cached_f0['total_frames']} frames from cache")
            return cached_f0

    print("\n" + "=" * 65)
    print(f"[3/4] 🎵 Tonhöhen-Analyse mit KI ({pitch_engine.upper()}) & Kontur-Bereinigung")
    print("=" * 65)

    if hardware_profile is None:
        hardware_profile = detect_hardware()
    if model_selection is None:
        model_selection = select_models(
            hardware_profile,
            requested_pitch_engine=pitch_engine,
            requested_crepe_model=crepe_model,
        )

    device = hardware_profile.device if hardware_profile.backend in ("mps", "cuda") else "cpu"

    # Load audio
    sr = 16000
    y = None
    if sf is not None:
        try:
            data, orig_sr = sf.read(str(vocals_path), dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)
            if orig_sr != sr and librosa is not None:
                data = librosa.resample(data, orig_sr=orig_sr, target_sr=sr)
            y = data
        except Exception:
            y = None

    if y is None and librosa is not None:
        y, _ = librosa.load(str(vocals_path), sr=sr, mono=True)

    if y is None:
        raise RuntimeError(f"Konnte Gesangsdatei nicht laden: {vocals_path}")

    # Track raw f0
    raw_track = track_f0(
        y,
        sr,
        pitch_engine=pitch_engine,
        device=device,
        vocal_range=vocal_range,
        crepe_model=crepe_model,
    )

    t = raw_track["t"]
    f0_hz = raw_track["f0_hz"]
    voiced_prob = raw_track["voiced_prob"]
    hop_sec = raw_track["hop_sec"]
    hop_length = int(sr * hop_sec)

    # Compute RMS energy
    rms = compute_audio_rms(y, sr, hop_length)

    # Apply Phase 5.3 Contour Cleanup
    midi_float, cleaned_conf, tuning_cents = clean_f0(t, f0_hz, voiced_prob, rms, hop_sec=hop_sec)

    min_len = min(len(midi_float), len(cleaned_conf), len(rms), len(t))
    midi_float = midi_float[:min_len]
    cleaned_conf = cleaned_conf[:min_len]
    rms = rms[:min_len]
    t = t[:min_len]

    voiced_count = int(np.sum(~np.isnan(midi_float)))
    print(f"✅ Pitch-Analyse erfolgreich: {min_len} Frames (Stimmhaft: {voiced_count}, Tuning: {tuning_cents:+.1f}c).")

    result = {
        "type": "contour",
        "frame_dur_sec": hop_sec,
        "midi": midi_float,           # Cleaned MIDI float (NaN for unvoiced)
        "raw_f0_hz": f0_hz[:min_len],
        "conf": cleaned_conf,
        "rms": rms,
        "total_frames": min_len,
        "tuning_cents": tuning_cents,
        "audio": y,
        "sr": sr,
        "audio_path": str(vocals_path),
    }

    if stage_cache:
        stage_cache.save_f0(result, pitch_engine=pitch_engine, crepe_model=crepe_model)

    if progress_cb:
        progress_cb("pitch", 1.0, f"Pitch tracking complete: {min_len} frames")

    return result


def _analyze_pitch_crepe(vocals_path: Path | str, model_name: str = "full", vocal_range: str = "auto", device: Optional[str] = None) -> Dict[str, Any]:
    """Compatibility wrapper for CREPE analysis."""
    return analyze_vocal_pitch(vocals_path, pitch_engine="crepe", crepe_model=model_name, vocal_range=vocal_range)


def _analyze_pitch_pyin(vocals_path: Path | str, vocal_range: str = "auto") -> Dict[str, Any]:
    """Compatibility wrapper for pYIN analysis."""
    return analyze_vocal_pitch(vocals_path, pitch_engine="pyin", vocal_range=vocal_range)


def get_syllable_pitch(
    pitch_data: Dict[str, Any],
    start_sec: float,
    end_sec: float,
    fallback_pitch: float = 60.0,
    return_float: bool = False,
) -> int | Tuple[float, int]:
    """
    PLAN.md Phase 5.4: Syllable pitch extraction.
    1. Core region: skip first 20% (consonants) and last 10%, keeping >= 30 ms.
    2. Pitch = weighted median of cleaned MIDI floats (weights = conf * rms).
    Returns int by default, or (midi_float, rounded_int) if return_float=True.
    """
    frame_dur = pitch_data["frame_dur_sec"]
    dur = end_sec - start_sec

    # Core region: skip first 20% and last 10%
    trim_start = dur * 0.20
    trim_end = dur * 0.10
    core_start = start_sec + trim_start
    core_end = end_sec - trim_end

    # Guarantee at least 30 ms core if duration permits
    if core_end - core_start < 0.030 and dur >= 0.030:
        core_start = start_sec
        core_end = end_sec

    start_frame = max(0, int(core_start / frame_dur))
    end_frame = min(pitch_data["total_frames"], int(core_end / frame_dur))

    if end_frame <= start_frame:
        start_frame = max(0, int(start_sec / frame_dur))
        end_frame = min(pitch_data["total_frames"], int(end_sec / frame_dur))
        if end_frame <= start_frame:
            ret_f = float(fallback_pitch)
            ret_i = int(round(fallback_pitch))
            return (ret_f, ret_i) if return_float else ret_i

    midi_slice = pitch_data["midi"][start_frame:end_frame]
    conf_slice = pitch_data["conf"][start_frame:end_frame]
    rms_slice = pitch_data["rms"][start_frame:end_frame]

    # Voiced frames only (non-NaN and conf >= 0.35)
    voiced_mask = (~np.isnan(midi_slice)) & (conf_slice >= 0.35)

    # Fallback to whole window if core region had no voiced frames
    if not np.any(voiced_mask):
        full_sf = max(0, int(start_sec / frame_dur))
        full_ef = min(pitch_data["total_frames"], int(end_sec / frame_dur))
        if full_ef > full_sf:
            midi_slice = pitch_data["midi"][full_sf:full_ef]
            conf_slice = pitch_data["conf"][full_sf:full_ef]
            rms_slice = pitch_data["rms"][full_sf:full_ef]
            voiced_mask = (~np.isnan(midi_slice)) & (conf_slice >= 0.30)

    if not np.any(voiced_mask):
        # Unvoiced syllable: inherit neighbor pitch
        ret_f = float(fallback_pitch)
        ret_i = int(round(fallback_pitch))
        return (ret_f, ret_i) if return_float else ret_i

    voiced_midis = midi_slice[voiced_mask]
    voiced_weights = conf_slice[voiced_mask] * (rms_slice[voiced_mask] + 1e-4)

    # Weighted median
    sort_idx = np.argsort(voiced_midis)
    sorted_midis = voiced_midis[sort_idx]
    sorted_weights = voiced_weights[sort_idx]
    cum_weights = np.cumsum(sorted_weights)
    cutoff = cum_weights[-1] / 2.0
    median_idx = np.searchsorted(cum_weights, cutoff)
    median_idx = min(median_idx, len(sorted_midis) - 1)
    pitch_float = float(sorted_midis[median_idx])
    pitch_int = int(round(pitch_float))

    return (pitch_float, pitch_int) if return_float else pitch_int


def detect_syllable_split(
    pitch_data: Dict[str, Any],
    start_sec: float,
    end_sec: float,
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
    has_tilde: bool = False,
    fallback_pitch: float = 60.0,
) -> Optional[List[Tuple[float, float, float, int]]]:
    """
    PLAN.md Phase 5.4: Melisma / Step Split Detection (Fix for P2).
    Split ONLY if ALL of these hold:
    - syllable duration >= 500 ms (or >= 350 ms if tilde marker),
    - segment cleaned contour with change-point step detector (ruptures PELT). Both plateaus >= 150 ms,
    - plateau medians differ by >= 2 semitones (or >= 1 st if tilde) and std-dev < 0.6 st each,
    - Basic Pitch agrees on the change when available.
    Returns:
        [(s1, e1, float1, int1), (s2, e2, float2, int2)] or None.
    """
    dur = end_sec - start_sec
    min_dur = 0.35 if has_tilde else SPLIT_MIN_SYLLABLE_DUR_SEC
    if dur < min_dur:
        return None

    frame_dur = pitch_data["frame_dur_sec"]
    sf_idx = max(0, int(start_sec / frame_dur))
    ef_idx = min(pitch_data["total_frames"], int(end_sec / frame_dur))
    if ef_idx - sf_idx < 30:  # < 300 ms of data
        return None

    midis = pitch_data["midi"][sf_idx:ef_idx]
    confs = pitch_data["conf"][sf_idx:ef_idx]
    voiced_mask = (~np.isnan(midis)) & (confs >= 0.35)

    if np.sum(voiced_mask) < 25:
        return None

    # Linearly interpolate NaNs in the slice for change-point detection
    interpolated_midis = np.copy(midis)
    indices = np.arange(len(midis))
    voiced_indices = indices[voiced_mask]
    if len(voiced_indices) < 20:
        return None

    interpolated_midis = np.interp(indices, voiced_indices, midis[voiced_indices])

    # Run ruptures Pelt change-point detector
    try:
        import ruptures as rpt
        # min_size = 15 frames = 150 ms
        algo = rpt.Pelt(model="l2", min_size=15).fit(interpolated_midis)
        # Penalty 2.5: conservative step penalty
        bkps = algo.predict(pen=2.5)
    except Exception:
        return None

    # Filter breakpoints to find 2 distinct plateaus >= 150 ms
    valid_split_point = None
    min_plateau_frames = int(SPLIT_MIN_PLATEAU_DUR_SEC / frame_dur)  # 15 frames

    for bkp in bkps[:-1]:  # bkps ends with len(interpolated_midis)
        if bkp >= min_plateau_frames and (len(interpolated_midis) - bkp) >= min_plateau_frames:
            # Check plateau medians and standard deviations
            seg1_voiced = voiced_mask[:bkp]
            seg2_voiced = voiced_mask[bkp:]
            if np.sum(seg1_voiced) < 8 or np.sum(seg2_voiced) < 8:
                continue

            m1 = midis[:bkp][seg1_voiced]
            m2 = midis[bkp:][seg2_voiced]
            med1 = float(np.median(m1))
            med2 = float(np.median(m2))
            std1 = float(np.std(m1))
            std2 = float(np.std(m2))

            min_diff = SPLIT_TILDE_MIN_SEMITONE_DIFF if has_tilde else SPLIT_MIN_SEMITONE_DIFF
            if abs(med1 - med2) >= min_diff and std1 < SPLIT_MAX_PLATEAU_STD_ST and std2 < SPLIT_MAX_PLATEAU_STD_ST:
                valid_split_point = bkp
                break

    if valid_split_point is None:
        return None

    split_time = start_sec + (valid_split_point * frame_dur)

    # Basic Pitch agreement check if available
    if basic_pitch_notes:
        from karaoke.basicpitch_adapter import BasicPitchAdapter
        agrees = BasicPitchAdapter.votes_for_split(
            basic_pitch_notes,
            start_sec,
            end_sec,
            split_time,
            margin_sec=0.10,
        )
        if not agrees:
            # Disagreement: Basic Pitch does not support this split, reject
            return None

    p1_float, p1_int = get_syllable_pitch(pitch_data, start_sec, split_time, fallback_pitch=fallback_pitch, return_float=True)
    p2_float, p2_int = get_syllable_pitch(pitch_data, split_time, end_sec, fallback_pitch=p1_float, return_float=True)

    return [
        (start_sec, split_time, p1_float, p1_int),
        (split_time, end_sec, p2_float, p2_int),
    ]


def detect_melisma_pitches(
    pitch_data: Dict[str, Any],
    start_sec: float,
    end_sec: float,
    min_dur: float = SPLIT_MIN_SYLLABLE_DUR_SEC,
) -> Optional[List[Tuple[float, float, int]]]:
    """
    Backward-compatible wrapper for melisma detection calling detect_syllable_split.
    """
    splits = detect_syllable_split(pitch_data, start_sec, end_sec, has_tilde=False)
    if splits is None:
        return None
    return [(s[0], s[1], s[3]) for s in splits]


def mask_background_regions(
    pitch_data: Dict[str, Any],
    background_spans: List[Tuple[float, float]],
) -> None:
    """
    Masks background vocal regions in the f0 contour so backing vocals
    do not interfere with lead vocal pitch detection.
    """
    if not background_spans or "frame_dur_sec" not in pitch_data:
        return

    frame_dur = pitch_data["frame_dur_sec"]
    total_frames = pitch_data["total_frames"]

    for b_start, b_end in background_spans:
        sf = max(0, int(b_start / frame_dur))
        ef = min(total_frames, int(b_end / frame_dur))
        if ef > sf:
            pitch_data["midi"][sf:ef] = np.nan
            pitch_data["conf"][sf:ef] = 0.0
