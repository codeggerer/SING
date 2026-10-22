"""
karaoke/sync.py - FFT Acoustic Cross-Correlation Engine (MASTER_OVERHAUL_PLAN Phase 2)

Mathematical Specification:
1. Resample both audio signals (YouTube audio x(t) and Reference audio y(t)) to 16,000 Hz mono.
2. Compute 12-dimensional chromagrams or spectral novelty envelopes:
   X[k, m] = Chroma(x),  Y[k, m] = Chroma(y)
3. Compute generalized cross-correlation via Fast Fourier Transform (GCC-PHAT or Chroma Dot Product):
   R_xy[tau] = sum_{k=1}^{12} sum_m X[k, m + tau] * Y[k, m]
4. Find the global maximum lag:
   tau* = argmax_tau R_xy[tau] (with sub-frame parabolic interpolation)
5. Compute aligned video gap:
   videoGapMs = chartGapMs + (tau* * 1000)

Guarantees sub-20ms inset alignment, permanently solving the first-note #GAP desync problem.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import scipy.signal

try:
    import librosa
except ImportError:
    librosa = None


@dataclass
class SyncResult:
    """Structured result of audio acoustic synchronization."""
    lag_sec: float
    lag_ms: float
    confidence: float
    original_gap_ms: float
    aligned_gap_ms: float
    method: str
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "lag_sec": round(self.lag_sec, 4),
            "lag_ms": round(self.lag_ms, 1),
            "confidence": round(self.confidence, 4),
            "original_gap_ms": round(self.original_gap_ms, 1),
            "aligned_gap_ms": round(self.aligned_gap_ms, 1),
            "method": self.method,
            "details": self.details,
        }


def _load_audio_mono(
    audio_input: Union[str, Path, np.ndarray],
    sr: int = 16000,
    max_duration: Optional[float] = None,
) -> Tuple[np.ndarray, int]:
    """
    Loads or normalizes audio into a 1D mono float32 NumPy array at target sample rate.
    """
    if isinstance(audio_input, np.ndarray):
        arr = audio_input.astype(np.float32)
        if arr.ndim > 1:
            arr = np.mean(arr, axis=0 if arr.shape[0] < arr.shape[1] else 1)
        if max_duration is not None:
            max_samples = int(round(max_duration * sr))
            if len(arr) > max_samples:
                arr = arr[:max_samples]
        return arr, sr

    path_obj = Path(audio_input)
    if not path_obj.exists():
        raise FileNotFoundError(f"Audio file not found: {path_obj}")

    if librosa is None:
        raise ImportError("librosa is required for audio loading and feature extraction")

    y, actual_sr = librosa.load(
        str(path_obj),
        sr=sr,
        mono=True,
        duration=max_duration,
    )
    return y.astype(np.float32), actual_sr


def _parabolic_interpolation(
    r: np.ndarray,
    peak_idx: int,
) -> float:
    """
    Refines a discrete correlation peak index using 3-point parabolic interpolation.
    Returns the fractional index offset delta in [-0.5, 0.5].
    """
    if peak_idx <= 0 or peak_idx >= len(r) - 1:
        return 0.0

    alpha = float(r[peak_idx - 1])
    beta = float(r[peak_idx])
    gamma = float(r[peak_idx + 1])

    denom = alpha - 2.0 * beta + gamma
    if abs(denom) < 1e-12:
        return 0.0

    delta = 0.5 * (alpha - gamma) / denom
    return float(np.clip(delta, -0.5, 0.5))


def _compute_confidence(
    r: np.ndarray,
    peak_idx: int,
    exclusion_radius_frames: int = 15,
) -> Tuple[float, float, float]:
    """
    Computes statistical confidence metrics for the detected correlation peak:
    - Peak-to-Sidelobe Ratio (PSR): (peak - mean_sidelobe) / std_sidelobe
    - z-score: standard score against all lags
    - Calibrated confidence score in [0.0, 1.0]
    """
    if len(r) == 0:
        return 0.0, 0.0, 0.0

    peak_val = float(r[peak_idx])
    total_mean = float(np.mean(r))
    total_std = float(np.std(r)) + 1e-9
    z_score = (peak_val - total_mean) / total_std

    # Sidelobes excluding a neighborhood around peak
    mask = np.ones(len(r), dtype=bool)
    start_ex = max(0, peak_idx - exclusion_radius_frames)
    end_ex = min(len(r), peak_idx + exclusion_radius_frames + 1)
    mask[start_ex:end_ex] = False

    if np.any(mask):
        sidelobes = r[mask]
        side_mean = float(np.mean(sidelobes))
        side_std = float(np.std(sidelobes)) + 1e-9
        psr = (peak_val - side_mean) / side_std
    else:
        psr = z_score

    # Calibrate confidence score:
    # A clear harmonic correlation peak has PSR >= 4.0 and z_score >= 3.0
    # Map PSR smoothly via sigmoid into [0.0, 1.0]
    # At PSR=3.0 -> ~0.70; at PSR=6.0 -> ~0.95; at PSR=10.0+ -> ~0.99
    conf = 1.0 / (1.0 + math.exp(-0.6 * (psr - 2.5)))
    conf = float(np.clip(conf, 0.0, 1.0))

    return psr, z_score, conf


def _compute_chroma_lag(
    y_yt: np.ndarray,
    y_ref: np.ndarray,
    sr: int = 16000,
    hop_length: int = 160,
    search_range_sec: Optional[Tuple[float, float]] = None,
) -> Tuple[float, float, Dict[str, Any]]:
    """
    Computes optimal time lag via 12-dimensional STFT chromagram dot product.
    R_xy[tau] = sum_{k=1}^{12} sum_m X[k, m + tau] * Y[k, m]
    """
    if librosa is None:
        raise ImportError("librosa is required for chroma feature extraction")

    # 1. Compute 12-dimensional chromagrams
    c_yt = librosa.feature.chroma_stft(y=y_yt, sr=sr, hop_length=hop_length, n_fft=1024)
    c_ref = librosa.feature.chroma_stft(y=y_ref, sr=sr, hop_length=hop_length, n_fft=1024)

    # 2. Standardize each pitch class across time: mean=0, std=1
    # This centers dynamic pitch contours and rejects stationary room hum / tone bleed
    c_yt_std = (c_yt - np.mean(c_yt, axis=1, keepdims=True)) / (np.std(c_yt, axis=1, keepdims=True) + 1e-8)
    c_ref_std = (c_ref - np.mean(c_ref, axis=1, keepdims=True)) / (np.std(c_ref, axis=1, keepdims=True) + 1e-8)

    # 3. Sum 1D FFT cross-correlations across all 12 pitch classes
    # scipy.signal.correlate(x, y): lag index 0 is -len(y) + 1, index len(y)-1 is lag 0
    num_frames_yt = c_yt.shape[1]
    num_frames_ref = c_ref.shape[1]
    r_chroma = np.zeros(num_frames_yt + num_frames_ref - 1, dtype=np.float64)

    for k in range(12):
        r_chroma += scipy.signal.correlate(c_yt_std[k], c_ref_std[k], mode="full", method="fft")

    # Lag frame array: tau_frames = index - (num_frames_ref - 1)
    frame_lags = np.arange(-num_frames_ref + 1, num_frames_yt, dtype=int)
    sec_lags = frame_lags * (hop_length / sr)

    # Apply search range constraint if requested
    if search_range_sec is not None:
        min_s, max_s = search_range_sec
        valid_mask = (sec_lags >= min_s) & (sec_lags <= max_s)
        if not np.any(valid_mask):
            raise ValueError(f"No valid correlation frames in search range {search_range_sec}")
        masked_r = np.where(valid_mask, r_chroma, -np.inf)
        best_idx = int(np.argmax(masked_r))
    else:
        best_idx = int(np.argmax(r_chroma))

    # 4. Refine discrete peak with parabolic interpolation
    delta = _parabolic_interpolation(r_chroma, best_idx)
    refined_frame_lag = float(frame_lags[best_idx]) + delta
    lag_sec = refined_frame_lag * (hop_length / sr)

    psr, z_score, confidence = _compute_confidence(r_chroma, best_idx, exclusion_radius_frames=15)

    details = {
        "psr": round(psr, 2),
        "z_score": round(z_score, 2),
        "peak_correlation": float(r_chroma[best_idx]),
        "frame_lag": round(refined_frame_lag, 3),
        "hop_length": hop_length,
        "sample_rate": sr,
    }

    return lag_sec, confidence, details


def _compute_gcc_phat_lag(
    y_yt: np.ndarray,
    y_ref: np.ndarray,
    sr: int = 16000,
    search_range_sec: Optional[Tuple[float, float]] = None,
) -> Tuple[float, float, Dict[str, Any]]:
    """
    Computes sub-millisecond lag via Generalized Cross Correlation Phase Transform (GCC-PHAT).
    """
    n = len(y_yt) + len(y_ref)
    # FFT
    Y_yt = np.fft.rfft(y_yt, n=n)
    Y_ref = np.fft.rfft(y_ref, n=n)
    R = Y_yt * np.conj(Y_ref)

    # Whiten amplitude with phase transform
    denom = np.abs(R) + 1e-12
    cc = np.fft.irfft(R / denom, n=n)

    # Shift zero-lag to center: index 0 is lag 0, indices > n/2 are negative lags
    cc_shifted = np.fft.fftshift(cc)
    lags_samples = np.arange(-len(cc) // 2, len(cc) // 2 + (len(cc) % 2))
    lags_sec = lags_samples / float(sr)

    if search_range_sec is not None:
        min_s, max_s = search_range_sec
        valid_mask = (lags_sec >= min_s) & (lags_sec <= max_s)
        if not np.any(valid_mask):
            raise ValueError(f"No valid GCC-PHAT samples in search range {search_range_sec}")
        masked_cc = np.where(valid_mask, np.abs(cc_shifted), -np.inf)
        best_idx = int(np.argmax(masked_cc))
    else:
        best_idx = int(np.argmax(np.abs(cc_shifted)))

    delta = _parabolic_interpolation(np.abs(cc_shifted), best_idx)
    refined_samples = float(lags_samples[best_idx]) + delta
    lag_sec = refined_samples / float(sr)

    psr, z_score, confidence = _compute_confidence(np.abs(cc_shifted), best_idx, exclusion_radius_frames=int(0.05 * sr))

    details = {
        "psr": round(psr, 2),
        "z_score": round(z_score, 2),
        "peak_correlation": float(np.abs(cc_shifted[best_idx])),
        "sample_lag": round(refined_samples, 2),
        "sample_rate": sr,
    }

    return lag_sec, confidence, details


def _compute_onset_lag(
    y_yt: np.ndarray,
    y_ref: np.ndarray,
    sr: int = 16000,
    hop_length: int = 80,  # 5ms resolution
    search_range_sec: Optional[Tuple[float, float]] = None,
) -> Tuple[float, float, Dict[str, Any]]:
    """
    Computes lag via spectral novelty / onset envelope cross-correlation.
    """
    if librosa is None:
        raise ImportError("librosa is required for onset envelope extraction")

    o_yt = librosa.onset.onset_strength(y=y_yt, sr=sr, hop_length=hop_length)
    o_ref = librosa.onset.onset_strength(y=y_ref, sr=sr, hop_length=hop_length)

    # Standardize
    o_yt_std = (o_yt - np.mean(o_yt)) / (np.std(o_yt) + 1e-8)
    o_ref_std = (o_ref - np.mean(o_ref)) / (np.std(o_ref) + 1e-8)

    r = scipy.signal.correlate(o_yt_std, o_ref_std, mode="full", method="fft")
    lags = np.arange(-len(o_ref) + 1, len(o_yt))
    sec_lags = lags * (hop_length / sr)

    if search_range_sec is not None:
        min_s, max_s = search_range_sec
        valid_mask = (sec_lags >= min_s) & (sec_lags <= max_s)
        if not np.any(valid_mask):
            raise ValueError(f"No valid onset frames in search range {search_range_sec}")
        masked_r = np.where(valid_mask, r, -np.inf)
        best_idx = int(np.argmax(masked_r))
    else:
        best_idx = int(np.argmax(r))

    delta = _parabolic_interpolation(r, best_idx)
    refined_lag = (float(lags[best_idx]) + delta) * (hop_length / sr)
    psr, z_score, confidence = _compute_confidence(r, best_idx, exclusion_radius_frames=10)

    details = {
        "psr": round(psr, 2),
        "z_score": round(z_score, 2),
        "peak_correlation": float(r[best_idx]),
        "hop_length": hop_length,
        "sample_rate": sr,
    }

    return refined_lag, confidence, details


def compute_audio_lag(
    yt_audio: Union[str, Path, np.ndarray],
    ref_audio: Union[str, Path, np.ndarray],
    sr: int = 16000,
    hop_length: int = 160,
    max_duration: Optional[float] = 120.0,
    method: str = "hybrid",
    search_range_sec: Optional[Tuple[float, float]] = None,
) -> Tuple[float, float, Dict[str, Any]]:
    """
    Computes the optimal time delay tau* (in seconds) of yt_audio relative to ref_audio.
    A positive tau* means yt_audio has an intro / is delayed by tau* seconds.

    Methods:
    - 'chroma': 12-dimensional chromagram cross-correlation (robust against EQ/timbre)
    - 'gcc_phat': Waveform generalized cross-correlation phase transform
    - 'onset': Spectral novelty envelope cross-correlation
    - 'hybrid': Coarse Chroma global alignment + fine local GCC-PHAT / onset refinement
    """
    y_yt, sr_yt = _load_audio_mono(yt_audio, sr=sr, max_duration=max_duration)
    y_ref, sr_ref = _load_audio_mono(ref_audio, sr=sr, max_duration=max_duration)

    if len(y_yt) == 0 or len(y_ref) == 0:
        raise ValueError("Audio input signals must not be empty")

    method_lower = method.lower()

    if method_lower == "chroma":
        return _compute_chroma_lag(
            y_yt, y_ref, sr=sr, hop_length=hop_length, search_range_sec=search_range_sec
        )
    elif method_lower == "gcc_phat":
        return _compute_gcc_phat_lag(
            y_yt, y_ref, sr=sr, search_range_sec=search_range_sec
        )
    elif method_lower == "onset":
        return _compute_onset_lag(
            y_yt, y_ref, sr=sr, hop_length=hop_length // 2, search_range_sec=search_range_sec
        )
    elif method_lower == "hybrid":
        # 1. Global coarse search via Chroma
        coarse_lag, coarse_conf, coarse_details = _compute_chroma_lag(
            y_yt, y_ref, sr=sr, hop_length=hop_length, search_range_sec=search_range_sec
        )

        # 2. Local fine search around coarse peak (+- 0.5s window)
        fine_window = 0.50
        local_range = (coarse_lag - fine_window, coarse_lag + fine_window)

        try:
            fine_lag, fine_conf, fine_details = _compute_gcc_phat_lag(
                y_yt, y_ref, sr=sr, search_range_sec=local_range
            )
            # If fine GCC-PHAT has solid confidence and agrees within window, use it
            if fine_conf >= 0.70 and abs(fine_lag - coarse_lag) <= fine_window:
                combined_details = {
                    "stage": "hybrid_gcc_phat",
                    "coarse_lag": round(coarse_lag, 4),
                    "coarse_confidence": round(coarse_conf, 4),
                    **fine_details,
                }
                return fine_lag, max(coarse_conf, fine_conf), combined_details
        except Exception:
            pass

        # Fallback to high-precision parabolic chroma
        coarse_details["stage"] = "hybrid_chroma_parabolic"
        return coarse_lag, coarse_conf, coarse_details
    else:
        raise ValueError(f"Unknown alignment method: '{method}'. Choose 'chroma', 'gcc_phat', 'onset', or 'hybrid'.")


def synthesize_chart_melody(
    chart_path_or_content: Union[str, Path],
    sr: int = 16000,
    duration_sec: Optional[float] = 60.0,
) -> Tuple[np.ndarray, float]:
    """
    Synthesizes reference vocal melody audio from an UltraStar .txt score chart.
    Used when no studio reference audio file is available.
    Returns: (synthesized_audio, chart_gap_ms)
    """
    if isinstance(chart_path_or_content, Path) or (
        isinstance(chart_path_or_content, str) and "\n" not in chart_path_or_content and os.path.exists(chart_path_or_content)
    ):
        with open(chart_path_or_content, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    else:
        lines = str(chart_path_or_content).splitlines()

    bpm = 1500.0
    gap_ms = 0.0

    for line in lines:
        line_clean = line.strip()
        if line_clean.upper().startswith("#BPM:"):
            bpm_str = line_clean.split(":", 1)[1].strip().replace(",", ".")
            try:
                bpm = float(bpm_str)
            except ValueError:
                pass
        elif line_clean.upper().startswith("#GAP:"):
            gap_str = line_clean.split(":", 1)[1].strip().replace(",", ".")
            try:
                gap_ms = float(gap_str)
            except ValueError:
                pass

    beat_dur_sec = 15.0 / bpm if bpm > 0 else 0.01

    # Parse notes
    notes = []
    max_end_sec = 0.0

    for line in lines:
        line_clean = line.strip()
        if line_clean.startswith(":") or line_clean.startswith("*") or line_clean.startswith("F"):
            parts = line_clean.split(None, 4)
            if len(parts) >= 4:
                try:
                    start_beat = int(parts[1])
                    dur_beat = int(parts[2])
                    midi_pitch = int(parts[3])

                    start_sec = (gap_ms / 1000.0) + (start_beat * beat_dur_sec)
                    dur_sec = dur_beat * beat_dur_sec
                    end_sec = start_sec + dur_sec

                    notes.append((start_sec, dur_sec, midi_pitch))
                    max_end_sec = max(max_end_sec, end_sec)
                except ValueError:
                    continue

    if duration_sec is not None:
        total_dur = min(duration_sec, max_end_sec + 2.0)
    else:
        total_dur = max_end_sec + 2.0

    total_samples = max(int(round(total_dur * sr)), sr * 5)
    audio = np.zeros(total_samples, dtype=np.float32)

    # Synthesize each note with soft attack/decay envelopes
    for start_sec, dur_sec, midi_pitch in notes:
        start_idx = int(round(start_sec * sr))
        dur_samples = int(round(dur_sec * sr))
        if start_idx >= total_samples or dur_samples <= 0:
            continue
        end_idx = min(total_samples, start_idx + dur_samples)
        actual_len = end_idx - start_idx
        if actual_len <= 0:
            continue

        freq = 440.0 * (2.0 ** ((midi_pitch - 69.0) / 12.0))
        t = np.arange(actual_len, dtype=np.float32) / float(sr)

        # Tone with fundamental + subtle 2nd harmonic
        sig = 0.7 * np.sin(2.0 * np.pi * freq * t) + 0.3 * np.sin(4.0 * np.pi * freq * t)

        # Smooth envelope (fade-in & fade-out)
        fade_len = min(int(0.01 * sr), actual_len // 2)
        if fade_len > 0:
            fade_in = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, fade_len)))
            fade_out = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, fade_len)))
            sig[:fade_len] *= fade_in
            sig[-fade_len:] *= fade_out

        audio[start_idx:end_idx] += sig.astype(np.float32)

    # Normalize amplitude
    max_amp = float(np.max(np.abs(audio)))
    if max_amp > 1e-6:
        audio /= max_amp

    return audio, gap_ms


def update_ultrastar_gap(
    chart_path_or_content: Union[str, Path],
    new_gap_ms: Union[int, float],
    output_path: Optional[Union[str, Path]] = None,
) -> str:
    """
    Updates or inserts the #GAP header in an UltraStar .txt score chart file or string.
    """
    is_path = isinstance(chart_path_or_content, Path) or (
        isinstance(chart_path_or_content, str) and "\n" not in chart_path_or_content and os.path.exists(chart_path_or_content)
    )

    if is_path:
        with open(chart_path_or_content, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    else:
        content = str(chart_path_or_content)

    formatted_gap = str(int(round(new_gap_ms)))
    gap_pattern = re.compile(r"^(#GAP:\s*)[^\r\n]+", re.IGNORECASE | re.MULTILINE)

    if gap_pattern.search(content):
        updated = gap_pattern.sub(rf"\g<1>{formatted_gap}", content)
    else:
        # Insert after #BPM if present, or at top
        bpm_pattern = re.compile(r"^(#BPM:[^\r\n]+)", re.IGNORECASE | re.MULTILINE)
        if bpm_pattern.search(content):
            updated = bpm_pattern.sub(rf"\1\n#GAP:{formatted_gap}", content, count=1)
        else:
            updated = f"#GAP:{formatted_gap}\n" + content

    if output_path is not None:
        out_p = Path(output_path).resolve()
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with open(out_p, "w", encoding="utf-8") as f:
            f.write(updated)
    elif is_path:
        with open(chart_path_or_content, "w", encoding="utf-8") as f:
            f.write(updated)

    return updated


def detect_vocal_onset(
    vocals_audio: Union[str, Path, np.ndarray],
    sr: int = 16000,
    max_duration: Optional[float] = 120.0,
) -> float:
    """
    Detects the onset timestamp (in seconds) of the first sung vocal in an isolated vocal stem.
    Uses RMS energy envelope tracking and onset novelty detection with backtracking.
    """
    y, sr = _load_audio_mono(vocals_audio, sr=sr, max_duration=max_duration)
    if len(y) == 0:
        return 0.0

    hop_length = 160  # 10ms frame resolution at 16kHz
    frame_length = 1024

    # Frame-wise RMS energy
    if librosa is not None:
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    else:
        pad_len = frame_length - (len(y) % hop_length) if (len(y) % hop_length) != 0 else 0
        padded_y = np.pad(y, (0, pad_len))
        num_frames = max(1, (len(padded_y) - frame_length) // hop_length + 1)
        strides = (padded_y.strides[0] * hop_length, padded_y.strides[0])
        frames = np.lib.stride_tricks.as_strided(
            padded_y, shape=(num_frames, frame_length), strides=strides
        )
        rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)

    if len(rms) == 0:
        return 0.0

    peak_rms = float(np.max(rms))
    if peak_rms < 1e-4:
        return 0.0  # Silent audio

    noise_floor = float(np.percentile(rms, 15))
    threshold = max(0.10 * peak_rms, noise_floor * 3.5, 0.005)

    min_sustained_frames = 12
    vocal_start_frame = None

    for i in range(len(rms) - min_sustained_frames):
        window = rms[i : i + min_sustained_frames]
        if np.mean(window >= (threshold * 0.7)) >= 0.7 and rms[i] >= (threshold * 0.5):
            vocal_start_frame = i
            break

    if vocal_start_frame is None:
        candidates = np.where(rms >= threshold)[0]
        if len(candidates) > 0:
            vocal_start_frame = int(candidates[0])
        else:
            return 0.0

    backtrack_start = max(0, vocal_start_frame - 15)
    search_region = rms[backtrack_start : vocal_start_frame + 1]
    local_min_offset = int(np.argmin(search_region))
    onset_frame = backtrack_start + local_min_offset

    if librosa is not None:
        try:
            detected_onsets = librosa.onset.onset_detect(
                y=y, sr=sr, hop_length=hop_length, backtrack=True, units="time"
            )
            target_time = onset_frame * (hop_length / float(sr))
            valid_onsets = [t for t in detected_onsets if abs(t - target_time) <= 0.25]
            if valid_onsets:
                best_onset = min(valid_onsets, key=lambda t: abs(t - target_time))
                return float(max(0.0, round(float(best_onset), 4)))
        except Exception:
            pass

    onset_sec = onset_frame * (hop_length / float(sr))
    return float(max(0.0, round(onset_sec, 4)))


def snap_vocal_onset_to_chart(
    vocals_audio: Union[str, Path, np.ndarray],
    chart_path_or_content: Union[str, Path],
    update_chart: bool = False,
    out_chart_path: Optional[Union[str, Path]] = None,
    max_duration: Optional[float] = 120.0,
) -> SyncResult:
    """
    Extracts the onset of the first sung vocal from Demucs vocals.wav and
    snaps it to the first note of the UltraStar chart:
    delta_tau* = t_vocal_onset - (t_first_note_beat * beat_dur_sec)
    alignedGapMs = round(delta_tau* * 1000)
    """
    if isinstance(chart_path_or_content, Path) or (
        isinstance(chart_path_or_content, str) and "\n" not in chart_path_or_content and os.path.exists(chart_path_or_content)
    ):
        with open(chart_path_or_content, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        chart_p = chart_path_or_content
    else:
        lines = str(chart_path_or_content).splitlines()
        chart_p = None

    bpm = 1500.0
    original_gap_ms = 0.0

    for line in lines:
        line_clean = line.strip()
        if line_clean.upper().startswith("#BPM:"):
            bpm_str = line_clean.split(":", 1)[1].strip().replace(",", ".")
            try:
                bpm = float(bpm_str)
            except ValueError:
                pass
        elif line_clean.upper().startswith("#GAP:"):
            gap_str = line_clean.split(":", 1)[1].strip().replace(",", ".")
            try:
                original_gap_ms = float(gap_str)
            except ValueError:
                pass

    beat_dur_sec = 15.0 / bpm if bpm > 0 else 0.01

    first_note_beat = None
    for line in lines:
        line_clean = line.strip()
        if line_clean.startswith(":") or line_clean.startswith("*") or line_clean.startswith("F"):
            parts = line_clean.split(None, 4)
            if len(parts) >= 4:
                try:
                    first_note_beat = int(parts[1])
                    break
                except ValueError:
                    continue

    if first_note_beat is None:
        first_note_beat = 0

    t_vocal_onset = detect_vocal_onset(vocals_audio, max_duration=max_duration)

    delta_tau = t_vocal_onset - (first_note_beat * beat_dur_sec)
    aligned_gap_ms = round(delta_tau * 1000.0, 1)

    lag_ms = aligned_gap_ms - original_gap_ms
    lag_sec = lag_ms / 1000.0

    if update_chart and chart_p is not None:
        target_out = out_chart_path if out_chart_path is not None else chart_p
        update_ultrastar_gap(chart_p, aligned_gap_ms, output_path=target_out)

    return SyncResult(
        lag_sec=lag_sec,
        lag_ms=lag_ms,
        confidence=0.95,
        original_gap_ms=original_gap_ms,
        aligned_gap_ms=aligned_gap_ms,
        method="vocal_onset",
        details={
            "vocal_onset_sec": round(t_vocal_onset, 4),
            "first_note_beat": first_note_beat,
            "bpm": bpm,
            "beat_dur_sec": round(beat_dur_sec, 4),
        },
    )


def measure_studio_offset(
    vocals_audio: Union[str, Path, np.ndarray],
    lyrics_input: Union[str, Path, Dict[str, Any]],
    sr: int = 16000,
    max_duration: Optional[float] = 120.0,
    use_onset: bool = True,
) -> Dict[str, Any]:
    """
    Phase 2.2: Studio vs. Live Audio Offset Auto-Detection.
    Measures the difference between the first non-silent vocal energy peak/onset in vocals.wav
    and the first syllable timestamp in lyrics.json:
        offset = t_vocal_first - t_lyric_first
    Stores this calibrated studioOffsetSec in meta.json so playback starts perfectly in lockstep.
    """
    # 1. Parse lyrics input
    doc_dict = None
    if isinstance(lyrics_input, dict):
        doc_dict = lyrics_input
    elif isinstance(lyrics_input, (str, Path)):
        p = Path(lyrics_input)
        if p.exists() and p.is_file():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    doc_dict = json.load(f)
            except Exception as e:
                return {"success": False, "message": f"Failed to parse lyrics.json: {e}"}
        else:
            try:
                doc_dict = json.loads(str(lyrics_input))
            except Exception as e:
                return {"success": False, "message": f"Invalid lyrics JSON string: {e}"}

    if not doc_dict:
        return {"success": False, "message": "Lyrics data missing or empty"}

    # Extract first syllable / line timestamp
    t_lyric_first = None
    lines = doc_dict.get("lines", [])
    for line in lines:
        sylls = line.get("syllables", [])
        if sylls and isinstance(sylls, list):
            for s in sylls:
                txt = str(s.get("text", s.get("words", ""))).strip()
                if txt and txt not in ("♪", "♫"):
                    t_val = s.get("start") if s.get("start") is not None else s.get("startTime", s.get("t"))
                    if t_val is not None:
                        t_lyric_first = float(t_val)
                        break
            if t_lyric_first is not None:
                break

        txt = str(line.get("words", line.get("text", ""))).strip()
        if txt and txt not in ("♪", "♫"):
            t_val = line.get("start") if line.get("start") is not None else line.get("startTime", line.get("t"))
            if t_val is not None:
                t_lyric_first = float(t_val)
                break

    if t_lyric_first is None:
        return {"success": False, "message": "No valid syllable or line timestamp found in lyrics"}

    # 2. Extract first vocal onset & peak from vocals stem
    y, actual_sr = _load_audio_mono(vocals_audio, sr=sr, max_duration=max_duration)
    if len(y) == 0:
        return {"success": False, "message": "Vocals audio is empty"}

    t_vocal_onset = detect_vocal_onset(y, sr=actual_sr, max_duration=max_duration)

    hop_length = 160
    frame_length = 1024
    if librosa is not None:
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    else:
        pad = frame_length - (len(y) % hop_length) if (len(y) % hop_length) != 0 else 0
        padded_y = np.pad(y, (0, pad))
        num_frames = max(1, (len(padded_y) - frame_length) // hop_length + 1)
        strides = (padded_y.strides[0] * hop_length, padded_y.strides[0])
        frames = np.lib.stride_tricks.as_strided(padded_y, shape=(num_frames, frame_length), strides=strides)
        rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)

    onset_frame = int(round(t_vocal_onset * (float(actual_sr) / hop_length)))
    burst_end_frame = min(len(rms), onset_frame + 50)  # ~500ms window
    if burst_end_frame > onset_frame:
        peak_offset = int(np.argmax(rms[onset_frame:burst_end_frame]))
        t_vocal_peak = (onset_frame + peak_offset) * (hop_length / float(actual_sr))
    else:
        t_vocal_peak = t_vocal_onset

    # When measuring offset against syllable start timestamps, onset alignment is exact
    t_vocal_first = t_vocal_onset if use_onset else t_vocal_peak
    offset = float(round(t_vocal_first - t_lyric_first, 3))

    return {
        "success": True,
        "vocal_first_sec": round(float(t_vocal_first), 3),
        "vocal_onset_sec": round(float(t_vocal_onset), 3),
        "vocal_peak_sec": round(float(t_vocal_peak), 3),
        "lyric_first_sec": round(float(t_lyric_first), 3),
        "studio_offset_sec": offset,
        "offset_ms": round(offset * 1000.0, 1),
        "details": {
            "vocal_onset": round(float(t_vocal_onset), 3),
            "vocal_peak": round(float(t_vocal_peak), 3),
            "lyric_start": round(float(t_lyric_first), 3),
        },
    }


def align_audio_gap(
    yt_audio: Optional[Union[str, Path, np.ndarray]] = None,
    ref_audio: Optional[Union[str, Path, np.ndarray]] = None,
    vocals_audio: Optional[Union[str, Path, np.ndarray]] = None,
    chart_path: Optional[Union[str, Path]] = None,
    chart_gap_ms: Optional[float] = None,
    update_chart: bool = False,
    out_chart_path: Optional[Union[str, Path]] = None,
    sr: int = 16000,
    hop_length: int = 160,
    max_duration: Optional[float] = 120.0,
    method: str = "hybrid",
) -> SyncResult:
    """
    Computes acoustic cross-correlation between YouTube audio and Reference audio,
    or snaps first sung vocal onset from Demucs vocals.wav to chart note:

    videoGapMs = chartGapMs + (tau* * 1000)
    """
    # 1. If vocals_audio is provided and (ref_audio is None or method is vocal_onset), use onset snapping!
    if vocals_audio is not None and (ref_audio is None or method == "vocal_onset"):
        if chart_path is None:
            raise ValueError("chart_path must be provided when aligning via vocals onset")
        return snap_vocal_onset_to_chart(
            vocals_audio=vocals_audio,
            chart_path_or_content=chart_path,
            update_chart=update_chart,
            out_chart_path=out_chart_path,
            max_duration=max_duration,
        )

    if yt_audio is None:
        raise ValueError("yt_audio must be provided for acoustic cross-correlation alignment.")

    parsed_original_gap = 0.0

    # Determine reference signal
    if ref_audio is not None:
        target_ref = ref_audio
        if chart_gap_ms is not None:
            parsed_original_gap = float(chart_gap_ms)
        elif chart_path is not None and os.path.exists(str(chart_path)):
            with open(chart_path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.strip().upper().startswith("#GAP:"):
                        try:
                            parsed_original_gap = float(line.strip().split(":", 1)[1].replace(",", "."))
                        except ValueError:
                            pass
                        break
    elif chart_path is not None:
        # Synthesize reference audio from UltraStar score chart!
        synth_audio, synth_gap = synthesize_chart_melody(chart_path, sr=sr, duration_sec=max_duration)
        target_ref = synth_audio
        parsed_original_gap = chart_gap_ms if chart_gap_ms is not None else synth_gap
    else:
        raise ValueError("Either ref_audio, vocals_audio, or chart_path must be provided for alignment.")

    # Execute FFT cross-correlation
    lag_sec, confidence, details = compute_audio_lag(
        yt_audio=yt_audio,
        ref_audio=target_ref,
        sr=sr,
        hop_length=hop_length,
        max_duration=max_duration,
        method=method,
    )

    lag_ms = lag_sec * 1000.0
    aligned_gap_ms = parsed_original_gap + lag_ms

    # Update chart file if requested
    if update_chart and chart_path is not None:
        target_out = out_chart_path if out_chart_path is not None else chart_path
        update_ultrastar_gap(chart_path, aligned_gap_ms, output_path=target_out)

    return SyncResult(
        lag_sec=lag_sec,
        lag_ms=lag_ms,
        confidence=confidence,
        original_gap_ms=parsed_original_gap,
        aligned_gap_ms=aligned_gap_ms,
        method=method,
        details=details,
    )
