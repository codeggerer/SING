"""
Configuration constants and parameters for the AI Karaoke Pipeline.
"""

from pathlib import Path

# UltraStar Beat Math
# 1 beat = 15 / BPM seconds = 15 / 1500 = 0.01s = 10ms
USTAR_BPM: float = 1500.0
BEAT_DUR_SEC: float = 0.01
GAP: int = 0
DEFAULT_GENRE: str = "Karaoke AI"

# Audio & DSP settings
SAMPLE_RATE_CREPE: int = 16000
SAMPLE_RATE_PYIN: int = 22050
SAMPLE_RATE_KEY: int = 22050
CREPE_HOP_LENGTH: int = 160       # 10 ms at 16 kHz
PYIN_HOP_SEC: float = 0.010       # 10 ms

# Vocal Frequency Bounds
VOCAL_FMIN_MALE: float = 80.0
VOCAL_FMIN_FEMALE: float = 115.0
VOCAL_FMAX: float = 1050.0

# Note & Syllable Timing Thresholds
MIN_WORD_DUR_FOR_SPLIT: float = 0.28   # Words shorter than 0.28s are never split
MIN_WORD_DUR_CLAMP: float = 0.16       # Word end clamp margin
MIN_MELISMA_DUR: float = 0.45          # Minimum duration for melisma check
MELISMA_SEMITONE_DIFF: float = 1.0     # Semitone difference to trigger melisma
PAUSE_BEAT_THRESHOLD_SEC: float = 1.25 # Silence before line pause break
WORD_GAP_BEATS: int = 6                # Minimum visual gap beats between words
MIN_NOTE_BEATS: int = 8                # Minimum note duration in beats

# Octave & Subharmonic Bounds
SUBHARMONIC_P75_THRESHOLD: float = 64.0  # 75th percentile pitch for high voice
SUBHARMONIC_NOTE_THRESHOLD: float = 59.0 # Fold notes <= 59 up by 12 st

# Quality Modes
QUALITY_FAST: str = "fast"
QUALITY_BALANCED: str = "balanced"
QUALITY_BEST: str = "best"
DEFAULT_QUALITY: str = QUALITY_BALANCED

# Pitch Engines
PITCH_ENGINE_PYIN: str = "pyin"
PITCH_ENGINE_CREPE: str = "crepe"
DEFAULT_PITCH_ENGINE: str = PITCH_ENGINE_PYIN
DEFAULT_CREPE_MODEL: str = "tiny"
