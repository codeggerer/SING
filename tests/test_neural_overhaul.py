"""
Master Validation Test Suite for TIER3_TIER4_NEURAL_OVERHAUL_PLAN.
Validates:
- Breakthrough 5: Harmonic Octave Continuity Filter (HOCF)
- Breakthrough 2: Silero VAD v5 Acoustic Breath Line Breaks
- Breakthrough 4: Transient Spectral Onset Snapping
"""

from __future__ import annotations
import unittest
import numpy as np

from karaoke.pitch import (
    apply_harmonic_octave_continuity_filter,
    analyze_vocal_pitch,
)
from karaoke.pitch_neural import (
    apply_harmonic_octave_continuity_filter as hocf_from_neural,
)
import karaoke
from karaoke.vad import (
    calculate_acoustic_line_breaks,
)
from karaoke.transients import (
    snap_onset_to_spectral_transient,
)


class TestHarmonicOctaveContinuityFilter(unittest.TestCase):
    """
    Validation for Breakthrough 5: Harmonic Octave Continuity Filter (HOCF).
    Eliminates octave doubling, falsetto halving, and double octave tracker errors
    while preserving genuine musical octave leaps across phrase boundaries.
    """

    def test_hocf_octave_doubling(self):
        """Octave doubling errors (+12 st) within continuous singing must be corrected down by 12 st."""
        n_frames = 60
        hop_sec = 0.010
        timestamps = np.arange(n_frames) * hop_sec
        # Base pitch: C4 (MIDI 60.0)
        midi = np.full(n_frames, 60.0, dtype=np.float32)
        confidence = np.full(n_frames, 0.95, dtype=np.float32)

        # Inject octave doubling (+12 st = 72.0) on frames 25..29
        midi[25:30] = 72.0

        pitch_data = {
            "midi": midi,
            "timestamps": timestamps,
            "confidence": confidence,
            "frame_dur_sec": hop_sec,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)

        self.assertTrue(filtered.get("hocf_applied", False))
        self.assertEqual(filtered.get("hocf_corrections"), 5)

        # All frames must be restored to 60.0
        np.testing.assert_allclose(filtered["midi"], 60.0, atol=1e-3)
        np.testing.assert_allclose(filtered["pitches"], 60.0, atol=1e-3)

    def test_hocf_octave_halving_queen_falsetto(self):
        """Queen / falsetto subharmonic halving (-12 st) must be corrected up by 12 st."""
        n_frames = 80
        hop_sec = 0.010
        timestamps = np.arange(n_frames) * hop_sec
        # High tenor / falsetto note: D5 (MIDI 74.0)
        midi = np.full(n_frames, 74.0, dtype=np.float32)
        confidence = np.full(n_frames, 0.90, dtype=np.float32)

        # Inject subharmonic halving (-12 st = 62.0) on frames 30..37 (8 frames)
        midi[30:38] = 62.0

        pitch_data = {
            "midi": midi,
            "timestamps": timestamps,
            "confidence": confidence,
            "frame_dur_sec": hop_sec,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)

        self.assertTrue(filtered.get("hocf_applied", False))
        self.assertEqual(filtered.get("hocf_corrections"), 8)

        # All frames must be restored to D5 (74.0)
        np.testing.assert_allclose(filtered["midi"], 74.0, atol=1e-3)
        np.testing.assert_allclose(filtered["pitches"], 74.0, atol=1e-3)

    def test_hocf_double_octave_doubling(self):
        """Double octave doubling (+24 st) must be corrected down by 24 st."""
        n_frames = 50
        hop_sec = 0.010
        timestamps = np.arange(n_frames) * hop_sec
        midi = np.full(n_frames, 62.0, dtype=np.float32)
        confidence = np.full(n_frames, 0.92, dtype=np.float32)

        # Inject +24 st error (86.0) on frames 20..22
        midi[20:23] = 86.0

        pitch_data = {
            "midi": midi,
            "timestamps": timestamps,
            "confidence": confidence,
            "frame_dur_sec": hop_sec,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)
        self.assertEqual(filtered.get("hocf_corrections"), 3)
        np.testing.assert_allclose(filtered["midi"], 62.0, atol=1e-3)

    def test_hocf_double_octave_halving(self):
        """Double octave halving (-24 st) must be corrected up by 24 st."""
        n_frames = 50
        hop_sec = 0.010
        timestamps = np.arange(n_frames) * hop_sec
        midi = np.full(n_frames, 70.0, dtype=np.float32)
        confidence = np.full(n_frames, 0.92, dtype=np.float32)

        # Inject -24 st error (46.0) on frames 20..22
        midi[20:23] = 46.0

        pitch_data = {
            "midi": midi,
            "timestamps": timestamps,
            "confidence": confidence,
            "frame_dur_sec": hop_sec,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)
        self.assertEqual(filtered.get("hocf_corrections"), 3)
        np.testing.assert_allclose(filtered["midi"], 70.0, atol=1e-3)

    def test_hocf_preserves_legitimate_octave_leap_across_pause(self):
        """
        Legitimate musical octave leap across a phrase pause (> 60ms)
        must NOT be altered by HOCF.
        """
        hop_sec = 0.010
        # Phrase 1: 40 frames at MIDI 58 (Bb3) from 0.00s to 0.40s
        phrase1_midis = np.full(40, 58.0)
        phrase1_conf = np.full(40, 0.95)

        # Pause: 30 frames of silence / unvoiced (300ms pause)
        pause_midis = np.full(30, np.nan)
        pause_conf = np.zeros(30)

        # Phrase 2: 40 frames at MIDI 70 (Bb4 = 58 + 12) from 0.70s to 1.10s
        phrase2_midis = np.full(40, 70.0)
        phrase2_conf = np.full(40, 0.95)

        all_midi = np.concatenate([phrase1_midis, pause_midis, phrase2_midis])
        all_conf = np.concatenate([phrase1_conf, pause_conf, phrase2_conf])
        timestamps = np.arange(len(all_midi)) * hop_sec

        pitch_data = {
            "midi": all_midi,
            "timestamps": timestamps,
            "confidence": all_conf,
            "frame_dur_sec": hop_sec,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)

        # Zero false corrections: both phrases preserved
        self.assertEqual(filtered.get("hocf_corrections"), 0)
        np.testing.assert_allclose(filtered["midi"][:40], 58.0, atol=1e-3)
        np.testing.assert_allclose(filtered["midi"][70:], 70.0, atol=1e-3)

    def test_hocf_handles_unvoiced_and_nan_frames(self):
        """Unvoiced frames (NaN or <= 30) or low-confidence (< 0.45) frames must remain untouched."""
        midi = np.array([np.nan, 20.0, 60.0, np.nan, 60.0])
        conf = np.array([0.0, 0.2, 0.9, 0.0, 0.3])
        timestamps = np.arange(5) * 0.010

        pitch_data = {
            "midi": midi,
            "timestamps": timestamps,
            "confidence": conf,
            "frame_dur_sec": 0.010,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)
        self.assertTrue(np.isnan(filtered["midi"][0]))
        self.assertTrue(np.isnan(filtered["midi"][3]))
        self.assertEqual(filtered["midi"][1], 20.0)

    def test_hocf_dictionary_robustness(self):
        """Tests filter when pitch_data only contains 'pitches' without timestamps or confidence."""
        pitches = np.array([60.0, 60.0, 72.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0])
        pitch_data = {
            "pitches": pitches,
            "frame_dur_sec": 0.010,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)
        self.assertIn("midi", filtered)
        self.assertIn("timestamps", filtered)
        self.assertIn("confidence", filtered)
        self.assertTrue(filtered["hocf_applied"])
        # The single frame 72.0 should be corrected to 60.0
        self.assertEqual(filtered["midi"][2], 60.0)

    def test_hocf_raw_f0_hz_sync(self):
        """When raw_f0_hz is present, corrected MIDI values must sync raw_f0_hz."""
        n_frames = 40
        midi = np.full(n_frames, 69.0)  # A4 (440 Hz)
        midi[15:18] = 81.0             # A5 (880 Hz, +12 st doubling)
        raw_f0 = np.full(n_frames, 440.0)
        raw_f0[15:18] = 880.0

        pitch_data = {
            "midi": midi,
            "raw_f0_hz": raw_f0,
            "confidence": np.ones(n_frames),
            "frame_dur_sec": 0.010,
        }

        filtered = apply_harmonic_octave_continuity_filter(pitch_data)
        self.assertEqual(filtered.get("hocf_corrections"), 3)
        np.testing.assert_allclose(filtered["midi"], 69.0, atol=1e-3)
        np.testing.assert_allclose(filtered["raw_f0_hz"], 440.0, atol=1e-2)

    def test_hocf_reexports(self):
        """apply_harmonic_octave_continuity_filter must be accessible from pitch_neural and root package."""
        self.assertTrue(callable(hocf_from_neural))
        self.assertTrue(hasattr(karaoke, "apply_harmonic_octave_continuity_filter"))
        self.assertTrue(callable(karaoke.apply_harmonic_octave_continuity_filter))


class TestSileroVADBreathBreaks(unittest.TestCase):
    """Validation for Breakthrough 2: Silero VAD v5 Acoustic Breath Line Breaks."""

    def test_calculate_acoustic_line_breaks(self):
        """Pauses >= 400ms must generate UltraStar phrase break beats ('- <beat>')."""
        speech_intervals = [
            {"start": 1.0, "end": 3.0},   # 2s speech
            {"start": 3.5, "end": 5.0},   # 500ms silence (3.0 -> 3.5): breath pause!
            {"start": 5.2, "end": 7.0},   # 200ms silence (5.0 -> 5.2): short pause (no break)
            {"start": 7.8, "end": 9.0},   # 600ms silence (7.0 -> 7.8): breath pause!
        ]
        # At BPM 1500, 1 beat = 0.01s (10ms)
        breaks = calculate_acoustic_line_breaks(speech_intervals, bpm=1500.0)
        self.assertEqual(len(breaks), 2)
        # Midpoint of (3.0, 3.5) = 3.25s -> beat 325
        self.assertEqual(breaks[0], 325)
        # Midpoint of (7.0, 7.8) = 7.40s -> beat 740
        self.assertEqual(breaks[1], 740)


class TestTransientAttackSnapping(unittest.TestCase):
    """Validation for Breakthrough 4: Transient Spectral Onset Snapping."""

    def test_snap_onset_to_spectral_transient_spike(self):
        """Snaps rough onset to exact physical high-frequency attack spike within <= 8ms."""
        sr = 16000
        total_sec = 1.0
        y = np.zeros(int(sr * total_sec), dtype=np.float32)

        # Attack transient spike at exactly 0.500s (8ms high freq burst 3000 Hz)
        exact_attack_idx = int(0.500 * sr)
        spike_len = int(0.008 * sr)
        t_spike = np.linspace(0, 0.008, spike_len, endpoint=False, dtype=np.float32)
        y[exact_attack_idx : exact_attack_idx + spike_len] += 0.9 * np.sin(2 * np.pi * 3000.0 * t_spike)

        # Sustained singing tone after attack
        tone_len = int(0.300 * sr)
        t_tone = np.linspace(0, 0.300, tone_len, endpoint=False, dtype=np.float32)
        y[exact_attack_idx : exact_attack_idx + tone_len] += 0.5 * np.sin(2 * np.pi * 440.0 * t_tone)

        # Rough onset from MMS-FA is 25ms off at 0.525s
        rough_onset = 0.525
        snapped = snap_onset_to_spectral_transient(rough_onset, y, sr=sr, search_window_ms=35.0)

        # Snapped timestamp must be within 8ms of exact physical attack (0.500s)
        self.assertAlmostEqual(snapped, 0.500, delta=0.008)


if __name__ == "__main__":
    unittest.main()
