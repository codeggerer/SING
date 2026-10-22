"""
Unit tests for Phase 5 of TIER_CONSISTENCY_AND_QUALITY_PLAN.md:
Phase 5: Cross-Tier Musicality & Live Stage Polishing
5.1 Harmonic Key & Scale Snapping (Auto-Tonleiter)
- Krumhansl-Schmuckler Key-Finding Algorithm on detected pitch histogram
- Soft-snap ambiguous microtonal notes: P_snapped = argmin_{k in Scale} |P_raw - k| if |P_raw - k| <= 0.35 st
- Preservation of intentional blue notes while eliminating vibrato jitter
"""

import unittest
import numpy as np

from karaoke.pitch import (
    MAJOR_PROFILE,
    MINOR_PROFILE,
    detect_key_from_pitch_histogram,
    detect_key_from_pitches,
    soft_snap_to_scale,
)
from karaoke.notes import apply_scale_snapping


class TestPhase5TierConsistency(unittest.TestCase):
    def test_krumhansl_schmuckler_histogram_ab_major(self):
        """Phase 5.1: Krumhansl-Schmuckler detects Ab Major (root 8) from pitch histogram."""
        # Roll MAJOR_PROFILE to root 8 (Ab)
        ab_major_histogram = np.roll(MAJOR_PROFILE, 8)
        # Add slight natural variation
        ab_major_histogram = ab_major_histogram + np.random.normal(0, 0.05, 12)

        key_info = detect_key_from_pitch_histogram(ab_major_histogram)
        self.assertEqual(key_info["root"], 8)
        self.assertEqual(key_info["mode"], "major")
        self.assertEqual(key_info["key"], "Ab Major")
        self.assertGreater(key_info["confidence"], 0.90)

        # Scale degrees of Ab Major: Ab(8), Bb(10), C(0), Db(1), Eb(3), F(5), G(7)
        expected_scale = {8, 10, 0, 1, 3, 5, 7}
        self.assertEqual(key_info["scale_pcs"], expected_scale)

    def test_krumhansl_schmuckler_histogram_a_minor(self):
        """Phase 5.1: Krumhansl-Schmuckler detects A Minor (root 9) from pitch histogram."""
        # Roll MINOR_PROFILE to root 9 (A)
        a_minor_histogram = np.roll(MINOR_PROFILE, 9)
        key_info = detect_key_from_pitch_histogram(a_minor_histogram)

        self.assertEqual(key_info["root"], 9)
        self.assertEqual(key_info["mode"], "minor")
        self.assertEqual(key_info["key"], "A Minor")
        self.assertGreater(key_info["confidence"], 0.95)

    def test_detect_key_from_pitches_continuous_and_hz(self):
        """Phase 5.1: detect_key_from_pitches converts continuous MIDI or Hz to pitch histogram."""
        # Ab Major chords: Ab4(68), C5(72), Eb5(75), Bb4(70), F4(65)
        # Repeat with slight continuous microtonal jitter
        pitches_midi = []
        for base in [68.1, 72.2, 75.05, 70.15, 65.0]:
            pitches_midi.extend([base + np.sin(i) * 0.15 for i in range(25)])

        key_info_midi = detect_key_from_pitches(pitches_midi)
        self.assertEqual(key_info_midi["key"], "Ab Major")
        self.assertIn(8, key_info_midi["scale_pcs"])

        # Also test conversion from Hz frequencies
        pitches_hz = [440.0 * (2.0 ** ((m - 69.0) / 12.0)) for m in pitches_midi]
        key_info_hz = detect_key_from_pitches(pitches_hz)
        self.assertEqual(key_info_hz["key"], "Ab Major")

    def test_soft_scale_snapping_ab_major(self):
        """
        Phase 5.1: Soft-snap formula P_snapped = argmin_{k in Scale} |P_raw - k| if <= 0.35 st.
        Preserves intentional blue notes while eliminating vibrato jitter.
        """
        ab_major_pcs = {8, 10, 0, 1, 3, 5, 7}  # Ab, Bb, C, Db, Eb, F, G

        # 1. Microtonal jitter on Bb (58.3 -> 58): |58.3 - 58| = 0.30 <= 0.35, snaps to 58
        self.assertEqual(soft_snap_to_scale(58.3, ab_major_pcs, confidence=0.85), 58)

        # 2. Microtonal flat on Bb (57.7 -> 58): |57.7 - 58| = 0.30 <= 0.35, snaps to 58
        self.assertEqual(soft_snap_to_scale(57.7, ab_major_pcs, confidence=0.85), 58)

        # 3. Intentional blue note: B (59.0):
        # B is 11 % 12 (out of Ab Major scale).
        # Nearest scale tones are Bb (58) and C (60), both 1.0 st away > 0.35 st.
        # Blue note 59 MUST be preserved!
        self.assertEqual(soft_snap_to_scale(59.0, ab_major_pcs, confidence=0.85), 59)

        # 4. Microtonal jitter on C (59.8 -> 60): |59.8 - 60| = 0.20 <= 0.35, snaps to 60
        self.assertEqual(soft_snap_to_scale(59.8, ab_major_pcs, confidence=0.85), 60)

        # 5. Low key confidence (< 0.60): does not snap, keeps round(midi_float)
        self.assertEqual(soft_snap_to_scale(58.3, ab_major_pcs, confidence=0.45), 58)

        # 6. NaN or empty scale handling
        self.assertEqual(soft_snap_to_scale(float('nan'), ab_major_pcs), 60)
        self.assertEqual(soft_snap_to_scale(58.3, set()), 58)

    def test_apply_scale_snapping_integration(self):
        """Phase 5.1: apply_scale_snapping updates notes in word_notes_list in-place."""
        ab_major_pcs = {8, 10, 0, 1, 3, 5, 7}
        word_notes_list = [
            {
                "pause_beat": None,
                "notes": [
                    {"start": 1.0, "end": 1.5, "pitch": 58, "pitch_float": 58.28, "text": "Hel-"},
                    {"start": 1.5, "end": 2.0, "pitch": 59, "pitch_float": 59.02, "text": "lo "},  # blue note
                    {"start": 2.0, "end": 2.5, "pitch": 60, "pitch_float": 59.82, "text": "world "},
                ],
                "num_sylls": 3,
            }
        ]

        apply_scale_snapping(word_notes_list, ab_major_pcs, confidence=0.85)
        notes = word_notes_list[0]["notes"]
        self.assertEqual(notes[0]["pitch"], 58)  # Snapped to Bb
        self.assertEqual(notes[1]["pitch"], 59)  # Preserved blue note B
        self.assertEqual(notes[2]["pitch"], 60)  # Snapped to C


if __name__ == "__main__":
    unittest.main()
