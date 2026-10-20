"""
High-Accuracy Pitch Tracking (CREPE / pYIN), Key Detection & Syllable Pitch Extraction.
"""

from __future__ import annotations
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple, Callable
import numpy as np

try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import librosa
except ImportError:
    librosa = None

from karaoke.hardware import HardwareProfile, ModelSelection, detect_hardware, select_models
from karaoke.cache import StageCache
from karaoke.config import (
    VOCAL_FMIN_MALE, VOCAL_FMIN_FEMALE, VOCAL_FMAX,
    MIN_MELISMA_DUR, MELISMA_SEMITONE_DIFF
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


def detect_song_key(audio_path: Path | str, manual_key: str = "", stage_cache: Optional[StageCache] = None) -> Optional[Dict[str, Any]]:
    """
    Detects song musical key (root + major/minor) using Krumhansl-Schmuckler
    chroma correlation, and returns the scale pitch classes.
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
        return {"key": f"{NOTE_NAMES[root_idx]} {mode.capitalize()}", "root": root_idx, "mode": mode, "scale_pcs": scale_pcs}

    if stage_cache:
        cached_key = stage_cache.load_key()
        if cached_key is not None:
            return cached_key

    if librosa is None:
        return None

    try:
        print("🎹 Erkenne Tonart (Key Detection) mit Librosa Chroma...")
        y, sr = librosa.load(str(audio_path), sr=22050, duration=75)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)

        best_corr = -1
        best_root = 0
        best_mode = "major"

        for root in range(12):
            maj_prof = np.roll(MAJOR_PROFILE, root)
            corr_maj = np.corrcoef(chroma, maj_prof)[0, 1]
            if corr_maj > best_corr:
                best_corr = corr_maj
                best_root = root
                best_mode = "major"

            min_prof = np.roll(MINOR_PROFILE, root)
            corr_min = np.corrcoef(chroma, min_prof)[0, 1]
            if corr_min > best_corr:
                best_corr = corr_min
                best_root = root
                best_mode = "minor"

        intervals = MAJOR_INTERVALS if best_mode == "major" else MINOR_INTERVALS
        scale_pcs = {(best_root + iv) % 12 for iv in intervals}
        key_name = f"{NOTE_NAMES[best_root]} {best_mode.capitalize()}"
        print(f"✅ Erkannte Tonart: {key_name} (Sicherheit: {best_corr:.2f})")
        res = {"key": key_name, "root": best_root, "mode": best_mode, "scale_pcs": scale_pcs}

        if stage_cache:
            stage_cache.save_key(res)

        return res
    except Exception as e:
        print(f"⚠️ Tonart-Erkennung übersprungen ({e})")
        return None


def snap_pitch_to_scale(midi_val: float, scale_pcs: set) -> int:
    """Snaps off-key microtonal noise to the nearest in-scale pitch class."""
    if not scale_pcs:
        return int(round(midi_val))
    m = int(round(midi_val))
    if (m % 12) in scale_pcs:
        return m
    # Try one semitone down or up
    down_match = ((m - 1) % 12) in scale_pcs
    up_match = ((m + 1) % 12) in scale_pcs
    if down_match and not up_match:
        return m - 1
    if up_match and not down_match:
        return m + 1
    if down_match and up_match:
        # Snap to closer side
        return m - 1 if (midi_val - (m - 1) < (m + 1) - midi_val) else m + 1
    return m


def analyze_vocal_pitch(
    vocals_path: Path | str,
    pitch_engine: str = "pyin",
    crepe_model: str = "tiny",
    vocal_range: str = "auto",
    hardware_profile: Optional[HardwareProfile] = None,
    model_selection: Optional[ModelSelection] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Dict[str, Any]:
    """
    Extracts continuous fundamental pitch (f0) contour and frame confidence.
    Defaults to Librosa pYIN for ultra-fast, smooth, zero-lag inference.
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
    print("[3/4] 🎵 Tonhöhen-Analyse mit KI / Monophonem Viterbi-Tracking")
    print("=" * 65)

    if hardware_profile is None:
        hardware_profile = detect_hardware()
    if model_selection is None:
        model_selection = select_models(hardware_profile, requested_pitch_engine=pitch_engine, requested_crepe_model=crepe_model)

    device = hardware_profile.device if hardware_profile.backend in ("mps", "cuda") else "cpu"

    use_crepe = (pitch_engine == "crepe")
    if use_crepe:
        try:
            result = _analyze_pitch_crepe(vocals_path, model_name=crepe_model, vocal_range=vocal_range, device=device)
        except Exception as e:
            print(f"⚠️ CREPE fehlgeschlagen ({e}). Schalte auf Librosa pYIN um...")
            result = _analyze_pitch_pyin(vocals_path, vocal_range=vocal_range)
    else:
        result = _analyze_pitch_pyin(vocals_path, vocal_range=vocal_range)

    if stage_cache:
        stage_cache.save_f0(result, pitch_engine=pitch_engine, crepe_model=crepe_model)

    if progress_cb:
        progress_cb("pitch", 1.0, f"Pitch tracking complete: {result['total_frames']} frames")

    return result


def _analyze_pitch_crepe(vocals_path: Path | str, model_name: str = "tiny", vocal_range: str = "auto", device: Optional[str] = None) -> Dict[str, Any]:
    import torch
    import torchcrepe

    print(f"🧠 Starte CREPE ({model_name}) Neural Pitch Inferenz...")
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
        raise RuntimeError("Konnte Gesangsdatei weder mit SoundFile noch mit Librosa laden.")

    audio = torch.from_numpy(y.astype(np.float32)).unsqueeze(0)

    hop_length = 160  # 10 ms at 16 kHz
    if device is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"

    fmin = VOCAL_FMIN_MALE if vocal_range == "male" else VOCAL_FMIN_FEMALE
    fmax = VOCAL_FMAX
    print(f"🚀 Inferenz auf {device.upper()} (Hop: 10 ms, Frequenz: {fmin:.0f} - {fmax:.0f} Hz)...")

    # Run CREPE prediction with batch size to avoid GPU lag
    pitch_hz, periodicity = torchcrepe.predict(
        audio,
        sample_rate=sr,
        hop_length=hop_length,
        fmin=fmin,
        fmax=fmax,
        model=model_name,
        batch_size=512,
        device=device,
        return_periodicity=True
    )

    pitch_np = pitch_hz.squeeze().cpu().numpy()
    conf_np = periodicity.squeeze().cpu().numpy()

    with np.errstate(divide='ignore', invalid='ignore'):
        midi_np = 69.0 + 12.0 * np.log2(np.maximum(1e-4, pitch_np) / 440.0)
        midi_np = np.nan_to_num(midi_np, nan=60.0)

    y_mono = audio.squeeze().cpu().numpy()
    rms_np = compute_audio_rms(y_mono, sr, hop_length)
    min_len = min(len(midi_np), len(rms_np), len(conf_np))

    print(f"✅ CREPE-Analyse erfolgreich: {min_len} Frames (10 ms Raster).")
    return {
        "type": "contour",
        "frame_dur_sec": hop_length / sr,
        "midi": midi_np[:min_len],
        "conf": conf_np[:min_len],
        "rms": rms_np[:min_len],
        "total_frames": min_len,
        "audio": y_mono,
        "sr": sr
    }


def _analyze_pitch_pyin(vocals_path: Path | str, vocal_range: str = "auto") -> Dict[str, Any]:
    """Librosa pYIN Viterbi tracking with dead code cleaned up."""
    print("🎼 Starte Librosa pYIN (Ultra-schnelles Viterbi Pitch-Tracking, kein Lag)...")
    if librosa is None:
        raise RuntimeError("Librosa ist nicht installiert. Bitte 'pip install librosa' ausführen.")

    y, sr = librosa.load(str(vocals_path), sr=22050, mono=True)
    hop_length = int(sr * 0.010)  # 10 ms per frame

    fmin = VOCAL_FMIN_MALE if vocal_range == "male" else VOCAL_FMIN_FEMALE
    fmax = VOCAL_FMAX

    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=fmin,
        fmax=fmax,
        sr=sr,
        hop_length=hop_length,
        fill_na=None
    )

    f0 = np.nan_to_num(f0, nan=0.0)
    conf_np = np.nan_to_num(voiced_probs, nan=0.0)

    with np.errstate(divide='ignore', invalid='ignore'):
        midi_np = np.where(f0 > 0, 69.0 + 12.0 * np.log2(f0 / 440.0), 60.0)

    rms_np = compute_audio_rms(y, sr, hop_length)
    min_len = min(len(midi_np), len(rms_np), len(conf_np))

    print(f"✅ pYIN-Analyse blitzschnell abgeschlossen: {min_len} Frames.")
    return {
        "type": "contour",
        "frame_dur_sec": hop_length / sr,
        "midi": midi_np[:min_len],
        "conf": conf_np[:min_len],
        "rms": rms_np[:min_len],
        "total_frames": min_len,
        "audio": y,
        "sr": sr
    }


def get_syllable_pitch(pitch_data: Dict[str, Any], start_sec: float, end_sec: float, fallback_pitch: int = 60) -> int:
    """
    Calculates the exact musical pitch of a sung syllable.
    Trims onset/offset consonant transients and computes an energy-weighted median.
    """
    frame_dur = pitch_data["frame_dur_sec"]
    dur = end_sec - start_sec

    # Transient trimming: vowels reside in the core 70% of the segment
    trim_ratio = 0.15 if dur >= 0.16 else 0.0
    core_start = start_sec + (dur * trim_ratio)
    core_end = end_sec - (dur * trim_ratio)

    start_frame = max(0, int(core_start / frame_dur))
    end_frame = min(pitch_data["total_frames"], int(core_end / frame_dur))

    if end_frame <= start_frame:
        start_frame = max(0, int(start_sec / frame_dur))
        end_frame = min(pitch_data["total_frames"], int(end_sec / frame_dur))
        if end_frame <= start_frame:
            return fallback_pitch

    midi_slice = pitch_data["midi"][start_frame:end_frame]
    conf_slice = pitch_data["conf"][start_frame:end_frame]
    rms_slice = pitch_data["rms"][start_frame:end_frame]

    # Voiced frame filtering: confidence and energy threshold
    # Never accept confidence < 0.35 (which is unvoiced noise/breath)
    for min_conf in [0.45, 0.35]:
        mask = (conf_slice >= min_conf)
        if np.any(mask):
            voiced_midis = midi_slice[mask]
            voiced_weights = conf_slice[mask] * (rms_slice[mask] + 1e-4)

            # Weighted median
            sort_idx = np.argsort(voiced_midis)
            sorted_midis = voiced_midis[sort_idx]
            sorted_weights = voiced_weights[sort_idx]
            cum_weights = np.cumsum(sorted_weights)
            cutoff = cum_weights[-1] / 2.0
            median_idx = np.searchsorted(cum_weights, cutoff)
            median_pitch = sorted_midis[min(median_idx, len(sorted_midis) - 1)]
            return int(round(median_pitch))

    # If completely unvoiced (e.g. unvoiced consonant 'f', 's', 't'), inherit the melodic pitch
    # instead of guessing random unvoiced noise!
    return fallback_pitch


def detect_melisma_pitches(pitch_data: Dict[str, Any], start_sec: float, end_sec: float, min_dur: float = MIN_MELISMA_DUR) -> Optional[List[Tuple[float, float, int]]]:
    """
    Checks if a held single-syllable note contains a deliberate melisma (distinct pitch change).
    Returns a list of (start_time, end_time, pitch) tuples.
    """
    dur = end_sec - start_sec
    if dur < min_dur:
        return None

    frame_dur = pitch_data["frame_dur_sec"]
    sf = max(0, int(start_sec / frame_dur))
    ef = min(pitch_data["total_frames"], int(end_sec / frame_dur))
    if ef - sf < 30:  # < 300 ms of data
        return None

    midis = pitch_data["midi"][sf:ef]
    confs = pitch_data["conf"][sf:ef]
    voiced = confs >= 0.40
    if np.sum(voiced) < 20:
        return None

    # Test if there are two distinct pitch plateaus (first half vs second half)
    half = len(midis) // 2
    p1 = get_syllable_pitch(pitch_data, start_sec, start_sec + (dur * 0.5))
    p2 = get_syllable_pitch(pitch_data, start_sec + (dur * 0.5), end_sec)

    # If the two halves differ by at least 1 full semitone
    if abs(p1 - p2) >= MELISMA_SEMITONE_DIFF:
        mid_time = start_sec + (dur * 0.5)
        return [
            (start_sec, mid_time, p1),
            (mid_time, end_sec, p2)
        ]

    return None
