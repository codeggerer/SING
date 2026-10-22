"""
Unit tests for Breakthrough 4: Spectral Novelty Onset Peak Snapping (karaoke/transients.py).
Tests sub-frame transient attack precision (<= 8 ms error), prominence gating,
parabolic interpolation, boundary handling, and batch syllable monotonicity.
"""

from __future__ import annotations
import inspect
import tempfile
import unittest
from pathlib import Path
import numpy as np
import soundfile as sf

from karaoke.transients import (
    snap_onset_to_spectral_transient,
    snap_word_onsets_to_transients,
    snap_syllables_to_transients,
    compute_transient_onset_envelope,
    refine_peak_parabolic,
    load_audio_mono,
)
from karaoke.align_mms import snap_syllables_to_audio


class TestTransientsEngine(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.sr = 16000
        cls.tmp_dir = tempfile.TemporaryDirectory()

        # Synthesize a realistic vocal attack:
        # 1.0s total: silence until 0.400s
        # At 0.400s: 8ms high-frequency plosive attack spike (2500 Hz) + 440 Hz singing tone
        duration = 1.0
        n_samples = int(cls.sr * duration)
        cls.synth_audio = np.zeros(n_samples, dtype=np.float32)

        attack_idx = int(0.400 * cls.sr)
        plosive_len = int(0.008 * cls.sr)  # 8ms plosive attack
        tone_len = int(0.350 * cls.sr)     # 350ms sustained tone

        t_plosive = np.linspace(0, 0.008, plosive_len, endpoint=False, dtype=np.float32)
        cls.synth_audio[attack_idx : attack_idx + plosive_len] += 0.85 * np.sin(2 * np.pi * 2800 * t_plosive)

        t_tone = np.linspace(0, 0.350, tone_len, endpoint=False, dtype=np.float32)
        cls.synth_audio[attack_idx : attack_idx + tone_len] += 0.50 * np.sin(2 * np.pi * 440 * t_tone)

        # Write to temporary WAV file
        cls.synth_wav = Path(cls.tmp_dir.name) / "test_synth_transient.wav"
        sf.write(str(cls.synth_wav), cls.synth_audio, cls.sr)

    @classmethod
    def tearDownClass(cls):
        cls.tmp_dir.cleanup()

    def test_01_signature_and_exports(self):
        """Verifies functions are exported and have correct signatures."""
        sig = inspect.signature(snap_onset_to_spectral_transient)
        self.assertIn("rough_onset_sec", sig.parameters)
        self.assertIn("y", sig.parameters)
        self.assertIn("sr", sig.parameters)
        self.assertIn("search_window_ms", sig.parameters)
        self.assertIn("prominence_ratio", sig.parameters)
        self.assertIn("hop_ms", sig.parameters)

        self.assertIs(snap_syllables_to_transients, snap_word_onsets_to_transients)

    def test_02_precision_sub_8ms_invariant(self):
        """
        Verification Criteria from TIER3_TIER4_NEURAL_OVERHAUL_PLAN.md:
        Word onsets align to the exact physical audio transient attack with <= 8 ms error.
        Tests rough onsets leading and trailing the true attack (0.400s).
        """
        true_attack_sec = 0.400
        # MMS-FA rough onsets typically jitter by ±15-25ms
        test_rough_onsets = [0.380, 0.385, 0.390, 0.410, 0.415, 0.420]

        for rough in test_rough_onsets:
            snapped = snap_onset_to_spectral_transient(
                rough_onset_sec=rough,
                y=self.synth_audio,
                sr=self.sr,
                search_window_ms=35.0,
            )
            err_ms = abs(snapped - true_attack_sec) * 1000.0
            self.assertLessEqual(
                err_ms,
                8.0,
                f"Rough {rough:.3f}s -> Snapped {snapped:.3f}s: Error {err_ms:.2f}ms exceeds 8ms threshold!",
            )

    def test_03_parabolic_subframe_refinement(self):
        """Tests that 3-point parabolic peak interpolation refines discrete peak index."""
        env = np.array([0.1, 0.3, 0.85, 0.5, 0.15], dtype=np.float32)
        discrete_peak = int(np.argmax(env))  # Index 2
        refined_peak = refine_peak_parabolic(env, discrete_peak)

        self.assertIsInstance(refined_peak, float)
        # Because env[1]=0.3 < env[3]=0.5, the true peak is shifted slightly towards index 3
        self.assertGreater(refined_peak, 2.0)
        self.assertLess(refined_peak, 2.5)

    def test_04_flat_tone_prominence_gating(self):
        """
        Steady-state tone without sudden transient attack should NOT trigger spurious snapping.
        Must preserve rough_onset_sec.
        """
        t = np.linspace(0, 1.0, self.sr, endpoint=False, dtype=np.float32)
        flat_audio = 0.5 * np.sin(2 * np.pi * 440 * t)

        rough_onset = 0.500
        snapped = snap_onset_to_spectral_transient(
            rough_onset_sec=rough_onset,
            y=flat_audio,
            sr=self.sr,
            search_window_ms=35.0,
            prominence_ratio=1.4,
        )
        self.assertEqual(snapped, rough_onset)

    def test_05_silence_and_micro_noise(self):
        """Near-silence or pure room tone must not snap to micro-noise."""
        silence = np.zeros(self.sr, dtype=np.float32)
        snapped_sil = snap_onset_to_spectral_transient(0.300, silence, sr=self.sr)
        self.assertEqual(snapped_sil, 0.300)

        micro_noise = np.random.randn(self.sr).astype(np.float32) * 1e-5
        snapped_noise = snap_onset_to_spectral_transient(0.300, micro_noise, sr=self.sr)
        self.assertEqual(snapped_noise, 0.300)

    def test_06_edge_and_boundary_conditions(self):
        """Tests boundaries: start of track, end of track, short clips, negative onsets."""
        # Negative onset
        self.assertEqual(snap_onset_to_spectral_transient(-0.5, self.synth_audio, sr=self.sr), -0.5)

        # Onset near very start (t = 0.010s)
        near_start = snap_onset_to_spectral_transient(0.010, self.synth_audio, sr=self.sr)
        self.assertIsInstance(near_start, float)

        # Onset near end (t = 0.990s)
        near_end = snap_onset_to_spectral_transient(0.990, self.synth_audio, sr=self.sr)
        self.assertIsInstance(near_end, float)

        # Short slice (50 samples)
        short_audio = np.ones(50, dtype=np.float32) * 0.1
        self.assertEqual(snap_onset_to_spectral_transient(0.002, short_audio, sr=self.sr), 0.002)

        # Empty audio
        self.assertEqual(snap_onset_to_spectral_transient(0.5, np.zeros(0, dtype=np.float32)), 0.5)

    def test_07_load_audio_mono_from_file_path(self):
        """Tests that snap_onset_to_spectral_transient accepts Path and str."""
        # Using Path
        snapped_path = snap_onset_to_spectral_transient(
            rough_onset_sec=0.415,
            y=self.synth_wav,
            sr=self.sr,
        )
        self.assertLessEqual(abs(snapped_path - 0.400) * 1000.0, 8.0)

        # Using str
        snapped_str = snap_onset_to_spectral_transient(
            rough_onset_sec=0.415,
            y=str(self.synth_wav),
            sr=self.sr,
        )
        self.assertEqual(snapped_path, snapped_str)

        # Non-existent file raises FileNotFoundError
        with self.assertRaises(FileNotFoundError):
            load_audio_mono("non_existent_audio_path_xyz.wav")

    def test_08_batch_snap_syllables_to_transients(self):
        """Tests batch syllable snapping with monotonicity and duration guarantees."""
        # Create audio with two plosive attack spikes: at 0.300s and 0.650s
        audio = np.zeros(self.sr * 2, dtype=np.float32)
        for t_atk in [0.300, 0.650]:
            idx = int(t_atk * self.sr)
            audio[idx : idx + 80] = 0.9 * np.sin(2 * np.pi * 2500 * np.linspace(0, 0.005, 80))
            audio[idx : idx + 2000] += 0.5 * np.sin(2 * np.pi * 440 * np.linspace(0, 0.125, 2000))

        syllables = [
            {"word": "hel-", "start": 0.320, "end": 0.500},
            {"word": "lo ", "start": 0.635, "end": 0.850},
        ]

        snapped_sylls = snap_syllables_to_transients(syllables, audio, sr=self.sr)
        self.assertEqual(len(snapped_sylls), 2)

        # First syllable start snapped to ~0.300s (error <= 8ms)
        self.assertLessEqual(abs(snapped_sylls[0]["start"] - 0.300) * 1000.0, 8.0)
        # Second syllable start snapped to ~0.650s (error <= 8ms)
        self.assertLessEqual(abs(snapped_sylls[1]["start"] - 0.650) * 1000.0, 8.0)

        # Monotonicity check
        self.assertLess(snapped_sylls[0]["start"], snapped_sylls[1]["start"])
        self.assertGreaterEqual(snapped_sylls[0]["end"], snapped_sylls[0]["start"] + 0.030)
        self.assertGreaterEqual(snapped_sylls[1]["end"], snapped_sylls[1]["start"] + 0.030)

    def test_09_align_mms_integration(self):
        """Tests that snap_syllables_to_audio in align_mms.py integrates transient snapping."""
        syllables = [
            {"word": "star ", "start": 0.415, "end": 0.750, "is_syllable": True}
        ]
        snapped = snap_syllables_to_audio(
            syllables=syllables,
            vocal_audio=self.synth_audio,
            sr=self.sr,
        )
        self.assertEqual(len(snapped), 1)
        err_ms = abs(snapped[0]["start"] - 0.400) * 1000.0
        self.assertLessEqual(err_ms, 8.0)


if __name__ == "__main__":
    unittest.main()
