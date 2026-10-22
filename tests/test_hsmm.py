"""
Unit test suite for Hidden Semi-Markov Model (HSMM) / Viterbi Note Decoding (Issue #2).
"""

from __future__ import annotations
import unittest
import numpy as np

from karaoke.hsmm import (
    viterbi_decode_notes_hsmm,
    detect_syllable_split_hsmm,
)
from karaoke.pitch import detect_syllable_split


class TestHSMMNoteDecoding(unittest.TestCase):
    """Tests for HSMM / Viterbi discrete-time note optimization."""

    def test_vibrato_suppression(self):
        """5-6 Hz vibrato cycles must NOT trigger state transitions."""
        t = np.arange(0, 0.8, 0.010)
        # 800 ms with strong 5.5 Hz vibrato (+/- 0.8 st oscillation) around MIDI 65 (F4)
        midis = 65.0 + 0.8 * np.sin(2 * np.pi * 5.5 * t)
        confs = np.ones_like(t) * 0.95
        rms = np.ones_like(t) * 0.2

        segs = viterbi_decode_notes_hsmm(
            midis=midis,
            confs=confs,
            rms=rms,
            frame_dur_sec=0.010,
            min_dwell_sec=0.080,
            switch_cost=10.0,
        )
        self.assertEqual(len(segs), 1, f"Vibrato triggered false splits: {segs}")
        self.assertEqual(segs[0][3], 65)

    def test_two_note_melisma(self):
        """Sustained 2-note pitch change must split into 2 distinct notes."""
        frame_dur = 0.010
        # 500 ms: 250 ms at 60.0, 250 ms at 64.0
        left = [60.0] * 25
        right = [64.0] * 25
        midis = np.array(left + right)
        confs = np.ones_like(midis) * 0.95
        rms = np.ones_like(midis) * 0.2

        segs = viterbi_decode_notes_hsmm(
            midis=midis,
            confs=confs,
            rms=rms,
            frame_dur_sec=frame_dur,
            min_dwell_sec=0.080,
            switch_cost=10.0,
        )
        self.assertEqual(len(segs), 2, f"Expected 2 segments, got {len(segs)}: {segs}")
        self.assertEqual(segs[0][3], 60)
        self.assertEqual(segs[1][3], 64)
        self.assertEqual(segs[0][1], 25)
        self.assertEqual(segs[1][0], 25)

    def test_three_note_rapid_run(self):
        """Rapid 300 ms vocal run across 3 notes (100 ms each) must decode to 3 distinct notes."""
        frame_dur = 0.010
        # 300 ms: 10 frames at 60, 10 frames at 62, 10 frames at 64
        midis = np.concatenate([np.full(10, 60.0), np.full(10, 62.0), np.full(10, 64.0)])
        confs = np.ones_like(midis) * 0.95
        rms = np.ones_like(midis) * 0.2

        segs = viterbi_decode_notes_hsmm(
            midis=midis,
            confs=confs,
            rms=rms,
            frame_dur_sec=frame_dur,
            min_dwell_sec=0.080,
            switch_cost=8.0,
        )
        self.assertEqual(len(segs), 3, f"Expected 3-note melisma run, got {len(segs)}: {segs}")
        self.assertEqual([s[3] for s in segs], [60, 62, 64])

    def test_scoop_filtering(self):
        """Initial vocal scoop into a sustained note must be merged into the target note."""
        frame_dur = 0.010
        # 80 ms scoop (62 to 64) entering a 500 ms sustained note at 64
        t_scoop = np.linspace(62.0, 64.0, 8)
        t_sustain = np.full(50, 64.0)
        midis = np.concatenate([t_scoop, t_sustain])
        confs = np.ones_like(midis) * 0.95
        rms = np.ones_like(midis) * 0.2

        segs = viterbi_decode_notes_hsmm(
            midis=midis,
            confs=confs,
            rms=rms,
            frame_dur_sec=frame_dur,
            min_dwell_sec=0.080,
            switch_cost=10.0,
            filter_scoops=True,
        )
        self.assertEqual(len(segs), 1, f"Scoop was falsely split into separate notes: {segs}")
        self.assertEqual(segs[0][3], 64)

    def test_scale_prior_penalization(self):
        """Out-of-scale accidental notes receive soft penalty."""
        frame_dur = 0.010
        # Ambiguous pitch at 61.2 (between C#4=61 and D4=62)
        midis = np.full(30, 61.2)
        confs = np.ones_like(midis) * 0.90
        # C Major scale: {0, 2, 4, 5, 7, 9, 11}. 61 % 12 == 1 (C# - out of scale). 62 % 12 == 2 (D - in scale).
        c_major_scale = {0, 2, 4, 5, 7, 9, 11}

        segs = viterbi_decode_notes_hsmm(
            midis=midis,
            confs=confs,
            frame_dur_sec=frame_dur,
            min_dwell_sec=0.080,
            scale_pcs=c_major_scale,
            scale_penalty=1.0,
        )
        self.assertEqual(len(segs), 1)
        # Should snap to in-scale D4 (62) rather than out-of-scale C#4 (61)
        self.assertEqual(segs[0][3], 62)

    def test_unvoiced_fallback(self):
        """Unvoiced frames fall back gracefully to fallback_pitch."""
        midis = np.full(30, np.nan)
        confs = np.zeros(30)

        segs = viterbi_decode_notes_hsmm(
            midis=midis,
            confs=confs,
            fallback_pitch=55.0,
        )
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0][3], 55)

    def test_detect_syllable_split_hsmm_integration(self):
        """detect_syllable_split_hsmm returns (start, end, p_float, p_int) tuples."""
        total_frames = 100
        midis = np.full(total_frames, 60.0)
        midis[50:] = 65.0  # jump to 65 at 0.5s
        confs = np.ones(total_frames) * 0.95
        pitch_data = {
            "midi": midis,
            "conf": confs,
            "frame_dur_sec": 0.010,
            "total_frames": total_frames,
        }

        res = detect_syllable_split_hsmm(
            pitch_data=pitch_data,
            start_sec=0.0,
            end_sec=1.0,
            fallback_pitch=60.0,
        )
        self.assertIsNotNone(res)
        self.assertEqual(len(res), 2)
        s0, e0, pf0, pi0 = res[0]
        s1, e1, pf1, pi1 = res[1]
        self.assertEqual(s0, 0.0)
        self.assertAlmostEqual(e0, 0.5, delta=0.02)
        self.assertAlmostEqual(s1, 0.5, delta=0.02)
        self.assertEqual(e1, 1.0)
        self.assertEqual(pi0, 60)
        self.assertEqual(pi1, 65)

    def test_detect_syllable_split_hsmm_single_note_returns_none(self):
        """Single steady note returns None (no split needed)."""
        total_frames = 60
        midis = np.full(total_frames, 62.0)
        confs = np.ones(total_frames) * 0.95
        pitch_data = {
            "midi": midis,
            "conf": confs,
            "frame_dur_sec": 0.010,
            "total_frames": total_frames,
        }

        res = detect_syllable_split_hsmm(
            pitch_data=pitch_data,
            start_sec=0.0,
            end_sec=0.6,
        )
        self.assertIsNone(res)


if __name__ == "__main__":
    unittest.main()
