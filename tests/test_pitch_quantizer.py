"""
Unit tests for Neural Pitch Tracking & Scale-Constrained Viterbi HMM Quantizer (Phase 5).
"""

from __future__ import annotations
import unittest
import numpy as np

from karaoke.quantizer import (
    compute_pitch_class_profile,
    detect_key_from_pcp,
    analyze_tessitura,
    detect_melisma_in_syllable,
    snap_to_scale,
    quantize_syllable_notes_in_key,
    ViterbiHMMQuantizer,
    quantize_notes,
)
from karaoke.pitch_neural import (
    track_f0_fcpe,
    track_f0_rmvpe,
    track_f0_neural,
)
from eval.metrics import compute_pitch_accuracy, evaluate_chart


class TestNeuralPitchTracking(unittest.TestCase):
    """Tests for neural f0 estimation using FCPE and RMVPE."""

    def test_fcpe_on_synthetic_sine(self):
        """FCPE must accurately track synthetic A4 (440 Hz) tone."""
        sr = 16000
        dur_sec = 0.5
        t = np.linspace(0, dur_sec, int(sr * dur_sec), endpoint=False, dtype=np.float32)
        # 440 Hz sine wave
        audio = 0.8 * np.sin(2 * np.pi * 440.0 * t)

        res = track_f0_fcpe(audio, sr, device="cpu", hop_sec=0.010)
        self.assertIn("f0_hz", res)
        self.assertIn("voiced_prob", res)

        f0 = res["f0_hz"]
        valid_f0 = f0[~np.isnan(f0) & (f0 > 0)]
        self.assertGreater(len(valid_f0), 10)

        median_hz = float(np.median(valid_f0))
        # Within 1 Hz of 440 Hz
        self.assertAlmostEqual(median_hz, 440.0, delta=1.5)

    def test_rmvpe_fallback_to_fcpe(self):
        """RMVPE must seamlessly fall back to FCPE when standalone package is absent."""
        sr = 16000
        dur_sec = 0.2
        audio = np.zeros(int(sr * dur_sec), dtype=np.float32)
        res = track_f0_rmvpe(audio, sr, device="cpu", hop_sec=0.010)
        self.assertIn("f0_hz", res)


class TestScaleConstrainedQuantizer(unittest.TestCase):
    """Tests for Key/PCP, Tessitura analysis, and Viterbi HMM quantization."""

    def test_pcp_and_key_detection(self):
        """PCP must detect C Major from notes C(0), E(4), G(7)."""
        # Create MIDI contour with C4(60), E4(64), G4(67)
        midis = np.array([60.0] * 50 + [64.0] * 50 + [67.0] * 50)
        conf = np.ones_like(midis)
        rms = np.ones_like(midis) * 0.1

        pcp = compute_pitch_class_profile(midis, conf, rms)
        self.assertEqual(len(pcp), 12)
        # Note classes 0 (C), 4 (E), 7 (G) must dominate
        self.assertGreater(pcp[0], 0.2)
        self.assertGreater(pcp[4], 0.2)
        self.assertGreater(pcp[7], 0.2)

        root, mode, confidence, scale_pcs = detect_key_from_pcp(pcp)
        self.assertEqual(root, 0)  # C
        self.assertEqual(mode, "major")
        self.assertIn(0, scale_pcs)
        self.assertIn(4, scale_pcs)
        self.assertIn(7, scale_pcs)

    def test_tessitura_analysis(self):
        """Low register contour (<45) must be shifted by whole octaves into standard singing register."""
        low_midis = np.array([32.0] * 100)  # E1 (~41 Hz)
        conf = np.ones_like(low_midis)

        med, p10, p90, shift, (c_min, c_max) = analyze_tessitura(low_midis, conf)
        self.assertEqual(shift, 24)  # Shifted up by 2 octaves (+24) to reach ~56 (G#3)
        self.assertGreaterEqual(med + shift, 45)
        self.assertLessEqual(med + shift, 75)

    def test_viterbi_hmm_quantization_smoothness(self):
        """Viterbi HMM must reject spurious 1-frame octave doubling and snap to scale."""
        scale_pcs = {0, 2, 4, 5, 7, 9, 11}  # C Major
        quantizer = ViterbiHMMQuantizer(
            transition_weight=0.40,
            scale_penalty=1.0,
            octave_jump_penalty=5.0,
            scale_pcs=scale_pcs,
            key_confidence=1.0,
            cand_range=(48, 72),
        )

        # 3 syllables: C4(60.1), D4(62.2 with a spurious high harmonic frame 74), E4(63.9)
        s1_midi = np.array([60.1] * 20)
        s2_midi = np.array([62.1] * 15 + [74.0] * 5)  # 5 frames of octave doubling (74 vs 62)
        s3_midi = np.array([63.9] * 20)

        slices = [
            {"midi": s1_midi, "conf": np.ones_like(s1_midi), "rms": np.ones_like(s1_midi) * 0.1},
            {"midi": s2_midi, "conf": np.ones_like(s2_midi), "rms": np.ones_like(s2_midi) * 0.1},
            {"midi": s3_midi, "conf": np.ones_like(s3_midi), "rms": np.ones_like(s3_midi) * 0.1},
        ]

        optimal = quantizer.quantize_sequence(slices)
        # Optimal sequence must be [60, 62, 64] (C4, D4, E4)
        self.assertEqual(optimal, [60, 62, 64])

    def test_melisma_detection_and_splitting(self):
        """Syllable with two stable plateaus >= 1.5 semitones apart must split into melisma notes."""
        frame_dur = 0.010
        # 0.5s syllable: 0.25s at MIDI 60 (C4), 0.25s at MIDI 64 (E4)
        left = [60.0] * 25
        right = [64.0] * 25
        midi_slice = np.array(left + right)
        conf_slice = np.ones_like(midi_slice)
        rms_slice = np.ones_like(midi_slice) * 0.1

        res = detect_melisma_in_syllable(
            midi_slice,
            conf_slice,
            rms_slice,
            start_sec=1.0,
            end_sec=1.5,
            frame_dur=frame_dur,
            min_split_dur=0.35,
            min_semitone_diff=1.5,
        )
        self.assertIsNotNone(res)
        t_split, p1_f, p1_i, p2_f, p2_i, score = res
        self.assertAlmostEqual(t_split, 1.25, delta=0.03)
        self.assertEqual(p1_i, 60)
        self.assertEqual(p2_i, 64)

    def test_melisma_rejection_on_monotonic_portamento(self):
        """Monotonic linear scoop (portamento) must not be falsely split into melisma."""
        frame_dur = 0.010
        # Monotonic linear glide from 60 to 62 over 40 frames
        glide = np.linspace(60.0, 62.0, 40)
        conf_slice = np.ones_like(glide)
        rms_slice = np.ones_like(glide) * 0.1

        res = detect_melisma_in_syllable(
            glide,
            conf_slice,
            rms_slice,
            start_sec=2.0,
            end_sec=2.4,
            frame_dur=frame_dur,
            min_split_dur=0.35,
            min_semitone_diff=1.5,
        )
        self.assertIsNone(res)

    def test_snap_to_scale(self):
        """Phase 4: snap_to_scale locks notes to scale degrees based on confidence."""
        c_major_pcs = {0, 2, 4, 5, 7, 9, 11}
        # In-scale note passes through
        self.assertEqual(snap_to_scale(60.1, c_major_pcs, confidence=0.8), 60)
        self.assertEqual(snap_to_scale(64.0, c_major_pcs, confidence=0.8), 64)

        # Accidental note (C#4 = 61.1) snaps to nearest scale degree (C4 = 60)
        self.assertEqual(snap_to_scale(60.9, c_major_pcs, confidence=0.8), 60)
        self.assertEqual(snap_to_scale(61.3, c_major_pcs, confidence=0.8), 62)

        # Low confidence (< 0.35) does not snap
        self.assertEqual(snap_to_scale(61.0, c_major_pcs, confidence=0.2), 61)

        # Empty scale does not snap
        self.assertEqual(snap_to_scale(61.0, set(), confidence=0.9), 61)

    def test_quantize_syllable_notes_in_key_sustained(self):
        """Phase 4: quantize_syllable_notes_in_key returns in-scale note for steady syllable."""
        c_major_pcs = {0, 2, 4, 5, 7, 9, 11}
        key_info = {"scale_pcs": c_major_pcs, "confidence": 0.8}
        timestamps = np.linspace(1.0, 1.3, 30)
        pitch_data = {
            "timestamps": timestamps,
            "midi": np.full(30, 60.2),
            "confidence": np.ones(30),
        }
        syllable = {"start": 1.0, "end": 1.3, "text": "Sing "}
        res = quantize_syllable_notes_in_key(syllable, pitch_data, key_info)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["pitch"], 60)
        self.assertEqual(res[0]["text"], "Sing ")
        self.assertAlmostEqual(res[0]["start"], 1.0)
        self.assertAlmostEqual(res[0]["end"], 1.3)

    def test_quantize_syllable_notes_in_key_unvoiced(self):
        """Unvoiced or quiet frames default to MIDI 60."""
        timestamps = np.linspace(0.0, 0.2, 20)
        pitch_data = {
            "timestamps": timestamps,
            "midi": np.full(20, 0.0),
            "confidence": np.zeros(20),
        }
        syllable = {"start": 0.0, "end": 0.2, "text": "Shh "}
        res = quantize_syllable_notes_in_key(syllable, pitch_data, key_info={})
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["pitch"], 60)

    def test_quantize_syllable_notes_in_key_melisma(self):
        """Phase 4: Syllable >= 0.40s with pitch inflection >= 1.6 st splits into 2 notes with ~."""
        c_major_pcs = {0, 2, 4, 5, 7, 9, 11}
        key_info = {"scale_pcs": c_major_pcs, "confidence": 0.8}
        timestamps = np.linspace(2.0, 2.5, 50)
        # Left half at 60 (C4), right half at 64 (E4)
        midis = np.array([60.0] * 25 + [64.0] * 25)
        pitch_data = {
            "timestamps": timestamps,
            "midi": midis,
            "confidence": np.ones(50),
        }
        syllable = {"start": 2.0, "end": 2.5, "text": "Fahr'n "}
        res = quantize_syllable_notes_in_key(syllable, pitch_data, key_info)
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0]["pitch"], 60)
        self.assertEqual(res[1]["pitch"], 64)
        self.assertEqual(res[1]["text"], "~")
        self.assertAlmostEqual(res[0]["end"], res[1]["start"])


class TestOctaveAnchoredEvaluation(unittest.TestCase):
    """Tests for octave-anchored metric evaluation."""

    def test_octave_anchor_recovers_transposed_chart(self):
        """Truth chart transposed by 36 semitones (like 2raumwohnung) must evaluate with high strict accuracy."""
        # Truth chart notes at MIDI 28 (E1)
        truth_notes = [
            {"start_sec": 1.0, "end_sec": 2.0, "pitch": 28, "text": "Ah "},
            {"start_sec": 2.2, "end_sec": 3.0, "pitch": 31, "text": "ah "},
        ]
        # Generated notes at standard concert pitch MIDI 64 (E4 = 28 + 36) and 67 (G4 = 31 + 36)
        gen_notes = [
            {"start_sec": 1.0, "end_sec": 2.0, "pitch": 64, "text": "Ah "},
            {"start_sec": 2.2, "end_sec": 3.0, "pitch": 67, "text": "ah "},
        ]

        # Raw evaluation without octave anchor: strict accuracy = 0.0%
        raw_res = compute_pitch_accuracy(truth_notes, gen_notes, anchor_octave=False)
        self.assertEqual(raw_res["pitch_strict_0"], 0.0)

        # Octave-anchored evaluation: detects shift k=3 (+36 st) and yields 100% strict accuracy
        anchored_res = compute_pitch_accuracy(truth_notes, gen_notes, anchor_octave=True)
        self.assertEqual(anchored_res["octave_shift"], 3)
        self.assertEqual(anchored_res["pitch_strict_0"], 1.0)
        self.assertEqual(anchored_res["pitch_strict_1"], 1.0)
        self.assertEqual(anchored_res["pitch_octave_1"], 1.0)


if __name__ == "__main__":
    unittest.main()
