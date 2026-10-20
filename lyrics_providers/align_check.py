"""
lyrics_providers/align_check.py - Sanity Checking & Audio Offset Alignment
(PLAN.md Phase 2.3 Task 4)

- Sanity-checks lyrics against audio by running fast Whisper windows (CER check).
- Drops mismatched lyrics docs (e.g. wrong song version or remix).
- Estimates global sync offset by cross-correlating lyrics onsets with vocal RMS envelope.
"""

from __future__ import annotations
import math
import re
from pathlib import Path
from typing import Tuple, Optional, List
import numpy as np

from lyrics_providers.models import LyricsDoc


def normalize_text(text: str) -> str:
    """Lowercase and remove non-alphanumeric chars for CER computation."""
    text = text.lower()
    return re.sub(r"[^a-z0-9äöüß]", "", text)


def compute_cer(reference: str, hypothesis: str) -> float:
    """Computes Character Error Rate via Levenshtein edit distance."""
    ref = normalize_text(reference)
    hyp = normalize_text(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0

    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,       # deletion
                dp[i][j - 1] + 1,       # insertion
                dp[i - 1][j - 1] + cost # substitution
            )

    return dp[n][m] / max(1, n)


def estimate_audio_offset(vocal_path: Path, doc: LyricsDoc, max_lag_sec: float = 30.0) -> float:
    """
    Estimates global timing offset by cross-correlating lyrics onsets
    with vocal audio onset strength envelope.
    Returns offset in seconds to add to lyricsDoc (doc.start + offset).
    """
    try:
        import librosa
    except ImportError:
        return 0.0

    try:
        y, sr = librosa.load(str(vocal_path), sr=16000, mono=True)
        hop_length = int(0.020 * sr)  # 20ms frames
        try:
            audio_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
        except Exception:
            audio_env = librosa.feature.rms(y=y, frame_length=hop_length * 2, hop_length=hop_length)[0]

        num_frames = len(audio_env)
        total_dur = num_frames * 0.020

        # Build lyrics onset impulse train
        lyrics_signal = np.zeros(num_frames)
        for line in doc.lines:
            if line.syllables and doc.syncType == "syllable":
                for s in line.syllables:
                    idx = int(s.start / 0.020)
                    if 0 <= idx < num_frames:
                        lyrics_signal[idx] = 1.0
            else:
                idx = int(line.start / 0.020)
                if 0 <= idx < num_frames:
                    lyrics_signal[idx] = 1.0

        # Gaussian smoothing of impulses
        window = np.exp(-0.5 * (np.linspace(-3, 3, 7) ** 2))
        window /= window.sum()
        lyrics_signal = np.convolve(lyrics_signal, window, mode="same")

        # Normalize signals
        env_norm = (audio_env - np.mean(audio_env)) / (np.std(audio_env) + 1e-8)
        lyr_norm = (lyrics_signal - np.mean(lyrics_signal)) / (np.std(lyrics_signal) + 1e-8)

        # Cross-correlate within [-min_lag, +max_lag_sec]
        min_lag_frames = int(-5.0 / 0.020)
        max_lag_frames = int(max_lag_sec / 0.020)
        corr = np.correlate(env_norm, lyr_norm, mode="full")
        zero_lag = len(lyr_norm) - 1

        valid_start = max(0, zero_lag + min_lag_frames)
        valid_end = min(len(corr), zero_lag + max_lag_frames + 1)
        sub_corr = corr[valid_start:valid_end]

        best_idx = np.argmax(sub_corr)
        best_lag_frames = (valid_start + best_idx) - zero_lag
        best_lag_sec = best_lag_frames * 0.020

        # Compensate for acoustic onset energy centroid delay relative to attack (~140ms)
        if best_lag_sec > 0.2:
            best_lag_sec = max(0.0, best_lag_sec - 0.14)

        return float(round(best_lag_sec, 3))
    except Exception as e:
        return 0.0


def verify_lyrics_against_audio(
    vocal_path: Path,
    doc: LyricsDoc,
    whisper_model_name: str = "tiny"
) -> Tuple[bool, str]:
    """
    Sanity checks doc lyrics against vocal audio via 3 spot-check Whisper windows.
    Returns (is_valid, reason).
    """
    if not vocal_path.exists():
        return True, "Vocal file does not exist, skipping audio sanity check"

    try:
        from faster_whisper import WhisperModel
        import librosa
    except ImportError:
        return True, "Faster-whisper or librosa not available for sanity check"

    try:
        duration = librosa.get_duration(path=str(vocal_path))
    except Exception:
        return True, "Could not determine audio duration"

    if duration < 30.0:
        return True, "Audio too short for 3-window validation"

    # Select 3 x 15-second windows at 25%, 50%, 75%
    window_centers = [duration * 0.25, duration * 0.50, duration * 0.75]
    window_len = 15.0

    try:
        model = WhisperModel(whisper_model_name, device="cpu", compute_type="int8")
    except Exception as e:
        return True, f"Could not initialize Whisper sanity checker: {e}"

    high_cer_count = 0
    windows_evaluated = 0

    for center in window_centers:
        start_sec = max(0.0, center - window_len / 2)
        end_sec = min(duration, center + window_len / 2)

        # Gather doc text in this window
        doc_words_in_window = []
        for line in doc.lines:
            if start_sec <= line.start <= end_sec or start_sec <= line.end <= end_sec:
                doc_words_in_window.append(line.words)

        doc_text = " ".join(doc_words_in_window).strip()
        if not doc_text:
            continue

        # Transcribe slice with Whisper
        try:
            y, sr = librosa.load(str(vocal_path), sr=16000, offset=start_sec, duration=window_len)
            import tempfile
            import soundfile as sf
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
                sf.write(tmp.name, y, sr)
                segments, _ = model.transcribe(tmp.name, beam_size=1)
                transcribed_text = " ".join(s.text.strip() for s in segments)

            if transcribed_text.strip():
                cer = compute_cer(doc_text, transcribed_text)
                windows_evaluated += 1
                if cer > 0.60:
                    high_cer_count += 1
        except Exception:
            continue

    if windows_evaluated >= 2 and (high_cer_count / windows_evaluated) > 0.5:
        return False, f"High lyrics mismatch: {high_cer_count}/{windows_evaluated} windows had CER > 0.60"

    return True, "OK"
