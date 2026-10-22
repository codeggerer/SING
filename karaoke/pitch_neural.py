"""
SOTA Neural Singing Pitch Tracking Engine (Phase 5.1).

Implements neural fundamental frequency (f0) extraction for singing voice:
- FCPE (Fast Context-based Pitch Estimation, via torchfcpe)
- RMVPE (Robust Model for Vocal Pitch Estimation) with graceful fallback to FCPE
- TorchCREPE (Deep convolutional pitch tracker)
"""

from __future__ import annotations
import math
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, Callable
import numpy as np

try:
    import torch
except ImportError:
    torch = None

try:
    import librosa
except ImportError:
    librosa = None

try:
    import soundfile as sf
except ImportError:
    sf = None

from karaoke.config import (
    PITCH_ENGINE_FCPE,
    PITCH_ENGINE_RMVPE,
    PITCH_ENGINE_CREPE,
    PITCH_ENGINE_PYIN,
    VOCAL_FMIN_MALE,
    VOCAL_FMIN_FEMALE,
    VOCAL_FMAX,
)
from karaoke.hardware import HardwareProfile, detect_hardware


def get_optimal_neural_device(preferred_device: Optional[str] = None) -> str:
    """Select the best available accelerator for neural pitch tracking."""
    if preferred_device is not None and preferred_device in ("cuda", "mps", "cpu"):
        return preferred_device

    if torch is not None:
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    return "cpu"


def track_f0_fcpe(
    audio: np.ndarray,
    sr: int,
    device: Optional[str] = None,
    hop_sec: float = 0.010,
) -> Dict[str, Any]:
    """
    Fast Context-based Pitch Estimation (singing-oriented neural tracker).
    Uses torchfcpe on the designated device (MPS/CUDA/CPU).
    """
    if torch is None:
        raise RuntimeError("PyTorch is required for FCPE neural pitch tracking.")

    try:
        import torchfcpe
    except ImportError:
        raise RuntimeError("torchfcpe is not installed in the python environment.")

    dev = get_optimal_neural_device(device)
    target_sr = 16000
    if sr != target_sr:
        if librosa is not None:
            audio_16k = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        else:
            audio_16k = audio
    else:
        audio_16k = audio

    wav_tensor = torch.from_numpy(audio_16k.astype(np.float32)).unsqueeze(0)
    if dev != "cpu":
        try:
            wav_tensor = wav_tensor.to(dev)
        except Exception:
            dev = "cpu"
            wav_tensor = wav_tensor.to(dev)

    try:
        model = torchfcpe.spawn_bundled_infer_model(device=dev)
    except Exception:
        dev = "cpu"
        model = torchfcpe.spawn_bundled_infer_model(device=dev)
        wav_tensor = wav_tensor.to("cpu")

    f0_tensor = model.infer(wav_tensor, sr=target_sr)
    f0_np = f0_tensor.squeeze().detach().cpu().numpy()

    # Unvoiced frames return 0.0 -> map to NaN
    f0_hz = np.where(f0_np > 0.0, f0_np, np.nan)
    voiced_prob = np.where(f0_np > 0.0, 1.0, 0.0)

    num_frames = len(f0_hz)
    t = np.arange(num_frames) * hop_sec

    return {
        "t": t,
        "f0_hz": f0_hz,
        "voiced_prob": voiced_prob,
        "hop_sec": hop_sec,
        "engine": PITCH_ENGINE_FCPE,
        "device": dev,
    }


def track_f0_rmvpe(
    audio: np.ndarray,
    sr: int,
    device: Optional[str] = None,
    hop_sec: float = 0.010,
) -> Dict[str, Any]:
    """
    Robust Model for Vocal Pitch Estimation (singing voice SOTA).
    If rmvpe package is not installed, gracefully falls back to FCPE.
    """
    dev = get_optimal_neural_device(device)
    try:
        import rmvpe  # type: ignore
        # If RMVPE model is present
        if hasattr(rmvpe, "RMVPE"):
            model = rmvpe.RMVPE(is_half=False, device=dev)
            f0_hz = model.infer_from_audio(audio, sample_rate=sr)
            voiced_prob = np.where(f0_hz > 0.0, 1.0, 0.0)
            f0_hz = np.where(f0_hz > 0.0, f0_hz, np.nan)
            t = np.arange(len(f0_hz)) * hop_sec
            return {
                "t": t,
                "f0_hz": f0_hz,
                "voiced_prob": voiced_prob,
                "hop_sec": hop_sec,
                "engine": PITCH_ENGINE_RMVPE,
                "device": dev,
            }
    except Exception:
        pass

    # Seamless fallback to FCPE
    res = track_f0_fcpe(audio, sr, device=device, hop_sec=hop_sec)
    res["engine"] = f"{PITCH_ENGINE_RMVPE}->fcpe"
    return res


def track_f0_neural(
    audio: np.ndarray,
    sr: int,
    engine: str = PITCH_ENGINE_FCPE,
    device: Optional[str] = None,
    hop_sec: float = 0.010,
    vocal_range: str = "auto",
    crepe_model: str = "full",
) -> Dict[str, Any]:
    """
    Unified neural pitch estimation dispatcher.
    Supported engines: 'fcpe', 'rmvpe', 'crepe', 'pyin'.
    """
    eng = engine.lower().strip()
    if eng == PITCH_ENGINE_FCPE:
        return track_f0_fcpe(audio, sr, device=device, hop_sec=hop_sec)
    elif eng == PITCH_ENGINE_RMVPE:
        return track_f0_rmvpe(audio, sr, device=device, hop_sec=hop_sec)
    elif eng == PITCH_ENGINE_CREPE:
        from karaoke.pitch import _track_f0_crepe
        return _track_f0_crepe(audio, sr, device=device, model_name=crepe_model, vocal_range=vocal_range, hop_sec=hop_sec)
    elif eng == PITCH_ENGINE_PYIN:
        from karaoke.pitch import _track_f0_pyin
        return _track_f0_pyin(audio, sr, vocal_range=vocal_range, hop_sec=hop_sec)
    else:
        # Default fallback to FCPE
        return track_f0_fcpe(audio, sr, device=device, hop_sec=hop_sec)


def apply_harmonic_octave_continuity_filter(
    pitch_data: Dict[str, Any],
    sr: int = 16000,
    max_semitone_leap_rate: float = 11.0,
) -> Dict[str, Any]:
    """
    Breakthrough 5: Harmonic Octave Continuity Filter (HOCF).
    Re-exported from karaoke.pitch for neural pitch pipelines.
    """
    from karaoke.pitch import apply_harmonic_octave_continuity_filter as _hocf
    return _hocf(pitch_data, sr=sr, max_semitone_leap_rate=max_semitone_leap_rate)

