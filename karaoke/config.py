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

# Note & Syllable Timing Thresholds (PLAN.md Phase 4)
MIN_WORD_DUR_FOR_SPLIT: float = 0.28   # Words shorter than 0.28s are never split
MIN_MELISMA_DUR: float = 0.45          # Minimum duration for melisma check
MELISMA_SEMITONE_DIFF: float = 1.0     # Semitone difference to trigger melisma
MIN_NOTE_DUR_BEATS: int = 3            # Minimum note duration: 3 beats (30 ms)
MIN_NOTE_GAP_BEATS: int = 1            # Minimum gap between notes: 1 beat (10 ms)
PAUSE_BREAK_THRESHOLD_SEC: float = 0.6 # Silence before phrase line break (>= 0.6s)
LINE_MAX_WORDS: int = 8                # Max words per line before line break
ONSET_SNAP_WINDOW_SEC: float = 0.120   # Syllable onset snap search window (±120 ms)
SILENT_GAP_NOTE_END_SEC: float = 0.120 # Silent gap threshold to cut note end (120 ms)
VOICED_TAIL_MARGIN_SEC: float = 0.040  # Margin added after last voiced frame (40 ms)

# Octave & Subharmonic Bounds (Legacy & Phase 5)
SUBHARMONIC_P75_THRESHOLD: float = 64.0  # (Legacy, superseded by contour continuity repair)
SUBHARMONIC_NOTE_THRESHOLD: float = 59.0 # (Legacy)

# Phase 5 Pitch Tracking & Cleanup Constants
PITCH_ENGINE_FCPE: str = "fcpe"
PITCH_ENGINE_CREPE: str = "crepe"
PITCH_ENGINE_PYIN: str = "pyin"
PITCH_ENGINE_RMVPE: str = "rmvpe"
DEFAULT_PITCH_ENGINE: str = PITCH_ENGINE_FCPE

VOICED_PROB_THRESHOLD: float = 0.50     # Voiced frame threshold
RMS_FLOOR_DBFS: float = -45.0           # Relative to file peak RMS
F0_MEDIAN_FILTER_SIZE: int = 5          # 5-frame median filter
MIN_VOICED_RUN_FRAMES: int = 5          # Isolated voiced runs < 5 frames masked
OCTAVE_JUMP_TOLERANCE_ST: float = 1.0   # Semitone tolerance around 12 st for jump repair
OCTAVE_NEIGHBOR_WINDOW_FRAMES: int = 15 # ±15 frames neighbor window
TUNING_MAX_CORRECTION_CENTS: float = 15.0 # Clamp global tuning estimate to +/- 15 cents max
TUNING_MIN_CONFIDENCE: float = 0.85       # Minimum circular mode confidence to apply tuning shift
VIBRATO_LPF_CUTOFF_HZ: float = 5.0      # Low-pass filter for vibrato suppression

# Phase 5 Note Building & Melisma Split (P2 Fix)
SPLIT_MIN_SYLLABLE_DUR_SEC: float = 0.70 # Syllable duration >= 700 ms for split (unless explicit tilde/hyphen)
SPLIT_MIN_PLATEAU_DUR_SEC: float = 0.25  # Both plateaus >= 250 ms (up from 150 ms)
SPLIT_MIN_SEMITONE_DIFF: float = 2.5     # Plateau medians differ by >= 2.5 st (not 2.0)
SPLIT_MAX_PLATEAU_STD_ST: float = 0.6    # Each plateau std-dev < 0.6 st
SPLIT_TILDE_MIN_SEMITONE_DIFF: float = 1.0 # If tilde marker present, >= 1 st
MIN_CORE_VOICED_FRAMES: int = 3          # Minimum voiced frames in core region

# Phase 5 Scale Prior & Global Song Octave
KEY_MIN_CONFIDENCE_FOR_SNAP: float = 0.60 # No snap when confidence < 0.6
SCALE_SNAP_MAX_DEV_ST: float = 0.35      # Snap only if <= 0.35 st from scale tone
SONG_MEDIAN_MIN_MIDI: float = 45.0       # Global song octave shift lower bound (A2)
SONG_MEDIAN_MAX_MIDI: float = 84.0       # Global song octave shift upper bound (C6)

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
