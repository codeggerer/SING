"""
Unit tests for Phase 4 Alignment & Timing (PLAN.md Phase 4).
Tests:
- clean_word_for_mms text normalization
- distribute_word_syllables (character spans & vowel nucleus weighting)
- snap_syllables_to_audio (onset snapping & monotonicity)
- prune_note_ends (voiced tail & silent gap protection)
- UltraStar note building with clamp removal & line breaks
"""

import unittest
import numpy as np

from karaoke.align import (
    clean_word_for_mms,
    distribute_word_syllables,
    snap_syllables_to_audio,
    prune_note_ends,
)
from karaoke.notes import build_word_notes, sec_to_beat
from karaoke.chart import generate_ultrastar_chart
from karaoke.config import MIN_NOTE_DUR_BEATS, MIN_NOTE_GAP_BEATS


class TestPhase4Alignment(unittest.TestCase):

    def test_clean_word_for_mms(self):
        # German umlauts
        self.assertEqual(clean_word_for_mms("schön"), "schoen")
        self.assertEqual(clean_word_for_mms("Mädchen"), "maedchen")
        self.assertEqual(clean_word_for_mms("süß"), "suess")
        # Punctuation & apostrophes
        self.assertEqual(clean_word_for_mms("don't"), "don't")
        self.assertEqual(clean_word_for_mms("hello, world!"), "helloworld")
        self.assertEqual(clean_word_for_mms("...wait..."), "wait")

    def test_distribute_word_syllables_monosyllable(self):
        # Monosyllable protection
        res = distribute_word_syllables("dance", 1.0, 1.4, lang="en")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["start"], 1.0)
        self.assertEqual(res[0]["end"], 1.4)
        self.assertTrue(res[0]["word"].startswith("dance"))

    def test_distribute_word_syllables_vowel_nucleus_weighting(self):
        # Multi-syllable word without character spans
        res = distribute_word_syllables("strawberry", 2.0, 3.0, lang="en")
        self.assertGreaterEqual(len(res), 2)
        # Total duration preserved
        self.assertAlmostEqual(res[0]["start"], 2.0)
        self.assertAlmostEqual(res[-1]["end"], 3.0)
        # Monotonicity
        for i in range(len(res) - 1):
            self.assertAlmostEqual(res[i]["end"], res[i+1]["start"])

    def test_distribute_word_syllables_with_char_spans(self):
        # Multi-syllable word with character spans
        # "bloody" -> clean "bloody" (6 chars)
        char_spans = [
            ("b", 10.0, 10.1),
            ("l", 10.1, 10.2),
            ("o", 10.2, 10.3),
            ("o", 10.3, 10.4),
            ("d", 10.4, 10.5),
            ("y", 10.5, 10.8),
        ]
        res = distribute_word_syllables("bloody", 10.0, 10.8, lang="en", char_spans=char_spans)
        self.assertEqual(len(res), 2)  # blood- y
        self.assertAlmostEqual(res[0]["start"], 10.0)
        self.assertAlmostEqual(res[1]["end"], 10.8)

    def test_snap_syllables_to_audio(self):
        # Synthesize audio with an onset peak at t = 1.05s
        sr = 16000
        dur_sec = 2.0
        audio = np.zeros(int(dur_sec * sr), dtype=np.float32)
        # Pulse at 1.05s
        pulse_idx = int(1.05 * sr)
        audio[pulse_idx:pulse_idx + 100] = 0.9

        syllables = [
            {"word": "test ", "start": 1.00, "end": 1.40, "is_syllable": True}
        ]
        snapped = snap_syllables_to_audio(syllables, audio, sr=sr, window_sec=0.120)
        # Syllable start should move closer to 1.05s
        self.assertAlmostEqual(snapped[0]["start"], 1.05, delta=0.03)

    def test_snap_syllables_monotonicity(self):
        # Two syllables very close together
        sr = 16000
        audio = np.random.randn(int(2.0 * sr)).astype(np.float32) * 0.1
        syllables = [
            {"word": "one ", "start": 0.50, "end": 0.55, "is_syllable": True},
            {"word": "two ", "start": 0.56, "end": 0.65, "is_syllable": True},
        ]
        snapped = snap_syllables_to_audio(syllables, audio, sr=sr)
        self.assertLessEqual(snapped[0]["start"] + 0.030, snapped[1]["start"])

    def test_prune_note_ends(self):
        # Pitch data: voiced from 0.0s to 0.40s, then unvoiced/silent
        hop_sec = 0.010
        total_frames = 100  # 1.0s
        pitches = np.full(total_frames, np.nan)
        pitches[:40] = 60.0  # voiced 0.00 to 0.39s

        pitch_data = {"pitches": pitches}
        syllables = [
            {"word": "sing ", "start": 0.0, "end": 0.8, "is_syllable": True}
        ]
        pruned = prune_note_ends(syllables, pitch_data=pitch_data)
        # Note should end around 0.39s + 0.040s = 0.43s, not 0.8s
        self.assertLess(pruned[0]["end"], 0.50)
        self.assertGreaterEqual(pruned[0]["end"], 0.40)

    def test_clamp_removal_in_chart_generation(self):
        # Verify notes with short duration (30ms = 3 beats) and 1-beat gap are preserved
        words = [
            {"word": "quick", "start": 1.00, "end": 1.04, "is_syllable": True},
            {"word": "shot", "start": 1.05, "end": 1.09, "is_syllable": True},
        ]
        pitch_data = {
            "pitches": np.array([60.0] * 200),
            "midi": np.array([60.0] * 200),
            "conf": np.array([1.0] * 200),
            "rms": np.array([0.5] * 200),
            "frame_dur_sec": 0.010,
            "total_frames": 200,
        }
        import tempfile
        from pathlib import Path
        from eval.ultrastar_parser import parse_ultrastar_txt

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
            temp_path = Path(f.name)

        try:
            generate_ultrastar_chart(
                words,
                pitch_data,
                120,
                "Test Title",
                "Test Artist",
                temp_path,
                lang="en",
            )
            chart = parse_ultrastar_txt(temp_path)
            self.assertEqual(len(chart.notes), 2)
            n1 = chart.notes[0]
            n2 = chart.notes[1]
            # Duration should be close to 30-40ms (3-4 beats), NOT clamped to 8 or 10 beats!
            self.assertLessEqual(n1.duration_beats, 5)
            # Gap between n1 and n2 should be at least 1 beat
            self.assertGreaterEqual(n2.start_beat, n1.start_beat + n1.duration_beats + 1)
        finally:
            if temp_path.exists():
                temp_path.unlink()


if __name__ == "__main__":
    unittest.main()
