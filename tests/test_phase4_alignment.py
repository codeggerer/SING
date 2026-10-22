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

    def test_distribute_word_syllables_acoustic_held_vowel(self):
        # Synthesize audio with held vowel (1.1s) and short second syllable (0.3s)
        sr = 16000
        dur_sec = 1.4
        t1 = np.linspace(0, 1.1, int(1.1 * sr), endpoint=False)
        v1 = 0.8 * np.sin(2 * np.pi * 220 * t1).astype(np.float32)
        t_gap = np.linspace(0, 0.04, int(0.04 * sr), endpoint=False)
        gap = 0.01 * np.random.randn(len(t_gap)).astype(np.float32)
        t2 = np.linspace(0, 0.26, int(0.26 * sr), endpoint=False)
        v2 = 0.5 * np.sin(2 * np.pi * 330 * t2).astype(np.float32)
        audio = np.concatenate([v1, gap, v2])

        res = distribute_word_syllables(
            "freedom",
            0.0,
            dur_sec,
            lang="en",
            vocal_audio=audio,
            sr=sr,
        )
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0]["start"], 0.0)
        self.assertEqual(res[1]["end"], dur_sec)
        # Held vowel should capture ~1.1s (between 1.00s and 1.20s), not 0.70s!
        self.assertGreater(res[0]["end"], 0.95)
        self.assertAlmostEqual(res[0]["end"], res[1]["start"])

    def test_distribute_word_syllables_acoustic_short_unstressed(self):
        # Synthesize audio with short unstressed first syllable (0.25s) and held second (1.0s)
        sr = 16000
        dur_sec = 1.25
        t1 = np.linspace(0, 0.22, int(0.22 * sr), endpoint=False)
        v1 = 0.4 * np.sin(2 * np.pi * 330 * t1).astype(np.float32)
        t_gap = np.linspace(0, 0.03, int(0.03 * sr), endpoint=False)
        gap = 0.01 * np.random.randn(len(t_gap)).astype(np.float32)
        t2 = np.linspace(0, 1.00, int(1.00 * sr), endpoint=False)
        v2 = 0.8 * np.sin(2 * np.pi * 220 * t2).astype(np.float32)
        audio = np.concatenate([v1, gap, v2])

        res = distribute_word_syllables(
            "belong",
            0.0,
            dur_sec,
            lang="en",
            vocal_audio=audio,
            sr=sr,
        )
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0]["start"], 0.0)
        self.assertEqual(res[1]["end"], dur_sec)
        # Short syllable should end around 0.22s - 0.35s, not equal split 0.625s!
        self.assertLess(res[0]["end"], 0.40)
        self.assertAlmostEqual(res[0]["end"], res[1]["start"])

    def test_distribute_word_syllables_acoustic_silence_fallback(self):
        # Pure silence should fall back to vowel nucleus weighting without error
        sr = 16000
        dur_sec = 1.0
        audio = np.zeros(int(dur_sec * sr), dtype=np.float32)
        res = distribute_word_syllables(
            "strawberry",
            0.0,
            dur_sec,
            lang="en",
            vocal_audio=audio,
            sr=sr,
        )
        self.assertGreaterEqual(len(res), 2)
        self.assertEqual(res[0]["start"], 0.0)
        self.assertEqual(res[-1]["end"], dur_sec)

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

        # Test with 'pitches' key
        pitch_data_pitches = {"pitches": pitches}
        syllables = [
            {"word": "sing ", "start": 0.0, "end": 0.8, "is_syllable": True}
        ]
        pruned = prune_note_ends(syllables, pitch_data=pitch_data_pitches)
        # Note should end around 0.39s + 0.040s = 0.43s, not 0.8s
        self.assertLess(pruned[0]["end"], 0.50)
        self.assertGreaterEqual(pruned[0]["end"], 0.40)

        # Test with 'midi' key (Phase 3 standardization)
        pitch_data_midi = {"midi": pitches, "frame_dur_sec": hop_sec}
        pruned_midi = prune_note_ends(syllables, pitch_data=pitch_data_midi)
        self.assertLess(pruned_midi[0]["end"], 0.50)
        self.assertGreaterEqual(pruned_midi[0]["end"], 0.40)

        # Test internal silent gap >= 120ms truncating note
        # Voiced 0.0 to 0.20s (frames 0..19), silent gap 0.20 to 0.35s (15 frames = 150ms), voiced 0.35 to 0.50s
        pitches_gap = np.full(total_frames, np.nan)
        pitches_gap[0:20] = 62.0
        pitches_gap[35:50] = 62.0
        pitch_data_gap = {"midi": pitches_gap, "frame_dur_sec": hop_sec}
        s_gap = [{"word": "long ", "start": 0.0, "end": 0.6, "is_syllable": True}]
        pruned_gap = prune_note_ends(s_gap, pitch_data=pitch_data_gap)
        # Note should truncate at start of silent gap + 40ms: frame 19 * 0.010 + 0.040 = 0.230s
        self.assertLessEqual(pruned_gap[0]["end"], 0.260)
        self.assertGreaterEqual(pruned_gap[0]["end"], 0.200)

        # Test unvoiced consonant at start: unvoiced 0.0 to 0.15s, voiced 0.15 to 0.40s
        pitches_consonant = np.full(total_frames, np.nan)
        pitches_consonant[15:40] = 65.0
        pitch_data_consonant = {"midi": pitches_consonant, "frame_dur_sec": hop_sec}
        s_cons = [{"word": "stay ", "start": 0.0, "end": 0.7, "is_syllable": True}]
        pruned_cons = prune_note_ends(s_cons, pitch_data=pitch_data_consonant)
        # Should NOT truncate prematurely before voicing; note should end at ~0.39s + 0.040s = 0.430s
        self.assertGreaterEqual(pruned_cons[0]["end"], 0.400)
        self.assertLess(pruned_cons[0]["end"], 0.500)

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
