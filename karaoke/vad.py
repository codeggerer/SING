"""
karaoke/vad.py - Silero VAD v5 Voice Activity Detector & Breath Break Engine

Implements Breakthrough 2 of TIER3_TIER4_NEURAL_OVERHAUL_PLAN.md:
- Silero VAD v5 neural voice activity detection (frame-level).
- Pre-filtering vocal audio to eliminate non-vocal/instrumental hallucinations in Whisper.
- Automatic breath line break detection ('- <beat>') at acoustic pause midpoints.
- Resilient audio loading via soundfile/librosa to bypass torchaudio 2.11 torchcodec restrictions.
"""

from __future__ import annotations
import os
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional

import numpy as np

try:
    import torch
except ImportError:
    torch = None

try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import librosa
except ImportError:
    librosa = None


_SILERO_MODEL = None
_SILERO_UTILS = None


def load_silero_vad() -> Tuple[Any, Any]:
    """
    Loads Silero VAD model and utils from torch.hub (cached locally).
    Reuses cached singleton in memory across inferences.
    """
    global _SILERO_MODEL, _SILERO_UTILS
    if _SILERO_MODEL is not None and _SILERO_UTILS is not None:
        return _SILERO_MODEL, _SILERO_UTILS

    if torch is None:
        raise ImportError("PyTorch is required for Silero VAD.")

    try:
        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            onnx=False,
            trust_repo=True,
        )
        _SILERO_MODEL = model
        _SILERO_UTILS = utils
        return _SILERO_MODEL, _SILERO_UTILS
    except Exception as e:
        # Check if local hub cache directory exists directly
        hub_dir = Path.home() / ".cache" / "torch" / "hub" / "snakers4_silero-vad_master"
        if hub_dir.exists():
            model, utils = torch.hub.load(
                repo_or_dir=str(hub_dir),
                model="silero_vad",
                source="local",
                force_reload=False,
                onnx=False,
            )
            _SILERO_MODEL = model
            _SILERO_UTILS = utils
            return _SILERO_MODEL, _SILERO_UTILS
        raise RuntimeError(f"Could not load Silero VAD model: {e}")


def _load_audio_tensor_16k(audio_path: Path | str | torch.Tensor | np.ndarray) -> Tuple[torch.Tensor, int]:
    """
    Loads audio as a 16kHz mono PyTorch float tensor.
    Accepts file path, numpy array, or PyTorch tensor.
    Uses soundfile / librosa to prevent torchaudio 2.11+ torchcodec requirements.
    """
    if torch is not None and isinstance(audio_path, torch.Tensor):
        t = audio_path.float()
        if t.ndim > 1:
            t = torch.mean(t, dim=0)
        return t, 16000

    if isinstance(audio_path, np.ndarray):
        arr = audio_path.astype(np.float32)
        if arr.ndim > 1:
            arr = np.mean(arr, axis=0) if arr.shape[0] < arr.shape[1] else np.mean(arr, axis=1)
        if torch is not None:
            return torch.from_numpy(arr), 16000
        return arr, 16000

    path_str = str(audio_path)
    data = None
    sr = 16000

    if sf is not None:
        try:
            data, file_sr = sf.read(path_str, dtype="float32")
            if data.ndim > 1:
                data = np.mean(data, axis=1)
            if file_sr != 16000:
                if librosa is not None:
                    data = librosa.resample(data, orig_sr=file_sr, target_sr=16000)
                else:
                    raise RuntimeError("librosa required for resampling")
            sr = 16000
        except Exception:
            data = None

    if data is None and librosa is not None:
        data, sr = librosa.load(path_str, sr=16000, mono=True)

    if data is None:
        raise RuntimeError(f"Could not read audio file for VAD: {path_str}")

    wav_tensor = torch.from_numpy(data.astype(np.float32))
    return wav_tensor, sr


def detect_vocal_intervals(
    audio_path: Path | str | torch.Tensor | np.ndarray,
    threshold: float = 0.50,
    min_speech_duration_ms: int = 250,
    min_silence_duration_ms: int = 400,
) -> List[Dict[str, float]]:
    """
    Returns continuous voiced speech segments [{'start': float, 'end': float}, ...].
    Uses Silero VAD v5 with energy-based fallback if unavailable.
    """
    try:
        model, utils = load_silero_vad()
        (get_speech_timestamps, _, _, _, _) = utils

        wav, sr = _load_audio_tensor_16k(audio_path)
        speech_timestamps = get_speech_timestamps(
            wav,
            model,
            threshold=threshold,
            sampling_rate=sr,
            min_speech_duration_ms=min_speech_duration_ms,
            min_silence_duration_ms=min_silence_duration_ms,
            return_seconds=True,
        )
        if speech_timestamps and len(speech_timestamps) > 0:
            return speech_timestamps
        # If Silero returned empty (e.g. synthetic tone), fall back to RMS energy intervals
        return _detect_intervals_rms(audio_path, min_silence_sec=min_silence_duration_ms / 1000.0)
    except Exception as e:
        print(f"⚠️ Silero VAD failed ({e}), falling back to RMS energy intervals...")
        return _detect_intervals_rms(audio_path, min_silence_sec=min_silence_duration_ms / 1000.0)


def extract_speech_timestamps(
    audio_path: Path | str,
    threshold: float = 0.50,
    min_speech_duration_ms: int = 250,
    min_silence_duration_ms: int = 400,
) -> List[Dict[str, float]]:
    """Convenience alias for detect_vocal_intervals."""
    return detect_vocal_intervals(
        audio_path=audio_path,
        threshold=threshold,
        min_speech_duration_ms=min_speech_duration_ms,
        min_silence_duration_ms=min_silence_duration_ms,
    )


def calculate_acoustic_line_breaks(
    speech_timestamps: List[Dict[str, float]],
    bpm: float = 1500.0,
    min_silence_dur_sec: float = 0.40,
) -> List[int]:
    """
    Generates UltraStar phrase split beats ('- <beat>') at the midpoint of natural breath pauses.
    """
    line_breaks: List[int] = []
    beat_dur_sec = 15.0 / bpm  # 0.01s for BPM:1500

    for i in range(len(speech_timestamps) - 1):
        prev_end = speech_timestamps[i]["end"]
        next_start = speech_timestamps[i + 1]["start"]
        silence_dur = next_start - prev_end

        if silence_dur >= min_silence_dur_sec:
            # Acoustic breath detected: break at midpoint of silence
            mid_sec = prev_end + (silence_dur / 2.0)
            break_beat = int(round(mid_sec / beat_dur_sec))
            line_breaks.append(break_beat)

    return line_breaks


def filter_hallucinations_vad(
    words: List[Dict[str, Any]],
    speech_timestamps: List[Dict[str, float]],
    pad_sec: float = 0.35,
) -> List[Dict[str, Any]]:
    """
    Eliminates hallucinated text generated during non-vocal sections
    (e.g., guitar solos, drum breaks, instrumental intros/outros).

    A word is considered a hallucination if its active span [start, end] has zero overlap
    with any Silero VAD voiced interval [interval_start - pad_sec, interval_end + pad_sec].
    If speech_timestamps is empty, returns original words safely without filtering.
    """
    if not words or not speech_timestamps:
        return words

    clean_words: List[Dict[str, Any]] = []
    dropped_words: List[str] = []

    for w in words:
        w_start = float(w.get("start", 0.0))
        w_end = float(w.get("end", w_start + 0.030))

        # Check if [w_start, w_end] overlaps with any voiced interval (with pad_sec tolerance)
        has_overlap = False
        for interval in speech_timestamps:
            v_start = float(interval["start"]) - pad_sec
            v_end = float(interval["end"]) + pad_sec
            if w_end > v_start and w_start < v_end:
                has_overlap = True
                break

        if has_overlap:
            clean_words.append(w)
        else:
            dropped_words.append(str(w.get("word", "")))

    if dropped_words:
        print(f"🛡️ Silero VAD filtered {len(dropped_words)} hallucinated words in non-vocal sections: {dropped_words[:5]}...")

    return clean_words


def apply_acoustic_breath_breaks(
    words: List[Dict[str, Any]],
    speech_timestamps: Optional[List[Dict[str, float]]] = None,
    vocals_path: Optional[Path | str] = None,
    bpm: float = 1500.0,
    min_silence_dur_sec: float = 0.40,
) -> List[Dict[str, Any]]:
    """
    Automates natural, human-like phrase breaks ('- <beat>') based on singer acoustic breath pauses.

    1. Obtains continuous speech segments from Silero VAD v5 (or speech_timestamps).
    2. Identifies breath pauses where silence between consecutive vocal segments is >= min_silence_dur_sec (400ms).
    3. Finds the word boundary spanning the silence interval, marking the preceding word with
       line_break_after = True and pause_beat = midpoint beat.
    4. Computes safe midpoint pause beats for any pre-existing line_break_after markers.
    """
    if not words:
        return []

    updated_words = [dict(w) for w in words]
    beat_dur_sec = 15.0 / bpm

    if speech_timestamps is None and vocals_path is not None:
        speech_timestamps = detect_vocal_intervals(
            vocals_path,
            min_silence_duration_ms=int(min_silence_dur_sec * 1000),
        )

    # 1. Apply breaks based on VAD speech_timestamps
    if speech_timestamps and len(speech_timestamps) >= 2:
        for i in range(len(speech_timestamps) - 1):
            pause_start = float(speech_timestamps[i]["end"])
            pause_end = float(speech_timestamps[i + 1]["start"])
            silence_dur = pause_end - pause_start

            if silence_dur < min_silence_dur_sec:
                continue

            mid_sec = pause_start + (silence_dur / 2.0)
            mid_beat = int(round(mid_sec / beat_dur_sec))

            # Find the best split boundary among updated_words
            best_idx = None
            best_score = float("inf")

            for j in range(len(updated_words) - 1):
                w_curr = updated_words[j]
                w_next = updated_words[j + 1]
                w_curr_end = float(w_curr.get("end", 0.0))
                w_next_start = float(w_next.get("start", w_curr_end))

                # Boundary must be within plausible distance of the breath pause
                if w_curr_end <= pause_end + 0.35 and w_next_start >= pause_start - 0.35:
                    boundary_mid = (w_curr_end + w_next_start) / 2.0
                    dist = abs(boundary_mid - mid_sec)
                    if dist < best_score:
                        best_score = dist
                        best_idx = j

            if best_idx is not None and best_score < max(1.5, silence_dur):
                w_curr = updated_words[best_idx]
                w_next = updated_words[best_idx + 1]
                w_curr_end = float(w_curr.get("end", 0.0))
                w_next_start = float(w_next.get("start", w_curr_end))

                prev_beat = int(round(w_curr_end / beat_dur_sec))
                next_beat = int(round(w_next_start / beat_dur_sec))

                if next_beat > prev_beat + 1:
                    clamped_break_beat = max(prev_beat + 1, min(next_beat - 1, mid_beat))
                else:
                    clamped_break_beat = prev_beat + 1

                w_curr["line_break_after"] = True
                w_curr["pause_beat"] = clamped_break_beat

    # 2. For any words that have line_break_after=True but no pause_beat, compute safe midpoint beat
    for j in range(len(updated_words) - 1):
        if updated_words[j].get("line_break_after") and updated_words[j].get("pause_beat") is None:
            w_curr_end = float(updated_words[j].get("end", 0.0))
            w_next_start = float(updated_words[j + 1].get("start", w_curr_end))
            prev_beat = int(round(w_curr_end / beat_dur_sec))
            next_beat = int(round(w_next_start / beat_dur_sec))

            mid_sec = (w_curr_end + w_next_start) / 2.0
            mid_beat = int(round(mid_sec / beat_dur_sec))

            if next_beat > prev_beat + 1:
                clamped_beat = max(prev_beat + 1, min(next_beat - 1, mid_beat))
            else:
                clamped_beat = prev_beat + 1

            updated_words[j]["pause_beat"] = clamped_beat

    return updated_words


def apply_vad_mask(
    audio_path: Path | str | torch.Tensor | np.ndarray,
    output_path: Optional[Path | str] = None,
    threshold: float = 0.35,
    min_speech_duration_ms: int = 250,
    min_silence_duration_ms: int = 400,
    pad_ms: int = 150,
    silence_threshold: Optional[float] = None,
    return_waveform: bool = False,
    return_intervals: bool = False,
) -> Path | np.ndarray | Tuple[Path | np.ndarray, List[Dict[str, float]]]:
    """
    Pre-filters vocal audio to eliminate non-vocal sections (guitar solos, synth leads, drum breaks)
    before Whisper transcription (Phase 4.1):
    1. Detects voiced speech intervals via Silero VAD v5 (or RMS energy fallback).
    2. Keeps the entire duration and time coordinates 100% intact.
    3. Smoothly silences unvoiced regions outside vocal intervals with 15ms raised-cosine crossfade.
    4. If no vocal intervals are found (e.g. pure guitar solo / instrumental), zeroes out the waveform.
    5. Saves the masked audio and returns its Path, or returns the masked numpy array if return_waveform=True.
    """
    if silence_threshold is not None:
        threshold = float(silence_threshold)

    is_array_input = isinstance(audio_path, (np.ndarray, torch.Tensor if torch is not None else ()))

    if is_array_input:
        input_stem = "in_memory_vocals"
    else:
        path_obj = Path(audio_path)
        if not path_obj.exists():
            if return_intervals:
                return path_obj, []
            return path_obj
        input_stem = path_obj.stem

    try:
        wav_tensor, sr = _load_audio_tensor_16k(audio_path)
        data = wav_tensor.numpy()
        total_samples = len(data)

        intervals = detect_vocal_intervals(
            wav_tensor if is_array_input else audio_path,
            threshold=threshold,
            min_speech_duration_ms=min_speech_duration_ms,
            min_silence_duration_ms=min_silence_duration_ms,
        )

        if not intervals:
            # Phase 4.1 Zero Hallucinations: Zero out completely during non-vocal sections
            masked_audio = np.zeros_like(data)
        else:
            # Build soft mask with pad_ms margin and crossfade
            mask = np.zeros(total_samples, dtype=np.float32)
            pad_samples = int(sr * (pad_ms / 1000.0))
            fade_samples = int(sr * 0.015)  # 15ms raised-cosine fade

            for item in intervals:
                s_sec = float(item["start"])
                e_sec = float(item["end"])
                s_idx = max(0, int(s_sec * sr) - pad_samples)
                e_idx = min(total_samples, int(e_sec * sr) + pad_samples)

                # Mark core voiced region
                mask[s_idx:e_idx] = 1.0

                # Fade-in
                if s_idx > 0 and fade_samples > 0:
                    f_start = max(0, s_idx - fade_samples)
                    fade_len = s_idx - f_start
                    if fade_len > 0:
                        fade_curve = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, fade_len)))
                        mask[f_start:s_idx] = np.maximum(mask[f_start:s_idx], fade_curve)

                # Fade-out
                if e_idx < total_samples and fade_samples > 0:
                    f_end = min(total_samples, e_idx + fade_samples)
                    fade_len = f_end - e_idx
                    if fade_len > 0:
                        fade_curve = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, fade_len)))
                        mask[e_idx:f_end] = np.maximum(mask[e_idx:f_end], fade_curve)

            masked_audio = data * mask

        if return_waveform or (is_array_input and output_path is None):
            result: Path | np.ndarray = masked_audio
        else:
            if output_path is None:
                tmp_dir = Path(tempfile.gettempdir()) / "sing_vad"
                tmp_dir.mkdir(parents=True, exist_ok=True)
                out_file = tmp_dir / f"{input_stem}_vad_clean.wav"
            else:
                out_file = Path(output_path)
                out_file.parent.mkdir(parents=True, exist_ok=True)

            if sf is not None:
                sf.write(str(out_file), masked_audio, sr)
            else:
                raise RuntimeError("soundfile required to save masked VAD audio")

            result = out_file

        if return_intervals:
            return result, intervals
        return result

    except Exception as e:
        print(f"⚠️ apply_vad_mask failed ({e}). Using raw audio without VAD mask.")
        ret = audio_path
        if return_intervals:
            return ret, []
        return ret


def _detect_intervals_rms(
    audio_path: Path | str,
    threshold_db: float = -38.0,
    min_speech_sec: float = 0.25,
    min_silence_sec: float = 0.40,
) -> List[Dict[str, float]]:
    """
    Fallback RMS energy voice activity detector when Silero VAD is unavailable.
    """
    if librosa is None and sf is None:
        return []

    try:
        wav_tensor, sr = _load_audio_tensor_16k(audio_path)
        y = wav_tensor.numpy()
        hop_length = int(sr * 0.02)  # 20ms
        frame_length = int(sr * 0.04)

        if librosa is not None:
            rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
        else:
            # Simple numpy sliding RMS
            n_frames = (len(y) - frame_length) // hop_length + 1
            if n_frames <= 0:
                return []
            rms = np.array([
                np.sqrt(np.mean(y[i * hop_length:i * hop_length + frame_length] ** 2))
                for i in range(n_frames)
            ])

        rms_db = 20.0 * np.log10(np.maximum(rms, 1e-6))
        is_speech = rms_db > threshold_db

        intervals: List[Dict[str, float]] = []
        in_speech = False
        start_t = 0.0

        for frame_idx, val in enumerate(is_speech):
            t = (frame_idx * hop_length) / sr
            if val and not in_speech:
                in_speech = True
                start_t = t
            elif not val and in_speech:
                in_speech = False
                if (t - start_t) >= min_speech_sec:
                    intervals.append({"start": round(start_t, 3), "end": round(t, 3)})

        if in_speech and (len(y) / sr - start_t) >= min_speech_sec:
            intervals.append({"start": round(start_t, 3), "end": round(len(y) / sr, 3)})

        return intervals
    except Exception:
        return []
