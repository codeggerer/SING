"""
Unit tests for Note Onset Alignment to Vowel Nuclei instead of Initial Consonants (Issue #1).

Tests:
1. find_vowel_nucleus_from_char_spans:
   - Unvoiced consonant clusters (st-, pl-, ch-, f-, k-) aligning to vowel onset
   - Voiced plosives/nasals/liquids (m-, n-, b-, etc.) retaining 20-30ms pre-voicing buffer
   - Syllables starting with vowels (onset = start)
   - Fallback when no vowels exist
2. compute_vowel_nucleus_onset:
   - Character spans decomposition
   - Pitch-data silence / unvoiced pruning
   - Invariant constraints (start <= note_start <= end - 0.030)
3. Dual-boundary representation:
   - distribute_word_syllables produces both start (phonetic lyrics) and note_start (vocal tone)
4. UltraStar chart generation:
   - Scored note rectangles align to vowel nucleus beat while keeping syllable text intact
"""

import unittest
import numpy as np

from karaoke.align_mms import (
    find_vowel_nucleus_from_char_spans,
    compute_vowel_nucleus_onset,
    distribute_word_syllables,
)
from karaoke.notes import build_word_notes, sec_to_beat
from karaoke.chart import generate_ultrastar_chart
from eval.ultrastar_parser import parse_ultrastar_txt
import tempfile
from pathlib import Path


class TestVowelNucleusOnset(unittest.TestCase):

    def test_find_vowel_nucleus_unvoiced_cluster(self):
        # "star" starting with unvoiced cluster "st-"
        char_spans = [
            ("s", 1.00, 1.08),
            ("t", 1.08, 1.15),
            ("a", 1.15, 1.35),
            ("r", 1.35, 1.45),
        ]
        onset = find_vowel_nucleus_from_char_spans(char_spans, fallback_start=1.00)
        # Should align to 'a' onset at 1.15s, skipping the 150ms unvoiced "st-"
        self.assertEqual(onset, 1.15)

    def test_find_vowel_nucleus_single_unvoiced(self):
        # "Fen-" starting with unvoiced fricative 'f'
        char_spans = [
            ("f", 2.00, 2.08),
            ("e", 2.08, 2.22),
            ("n", 2.22, 2.30),
        ]
        onset = find_vowel_nucleus_from_char_spans(char_spans, fallback_start=2.00)
        self.assertEqual(onset, 2.08)

    def test_find_vowel_nucleus_voiced_nasal_prevoicing_buffer(self):
        # "man" starting with voiced nasal 'm'
        char_spans = [
            ("m", 3.00, 3.10),
            ("a", 3.10, 3.35),
            ("n", 3.35, 3.45),
        ]
        onset = find_vowel_nucleus_from_char_spans(char_spans, fallback_start=3.00, max_prevoicing_sec=0.030)
        # 'm' is voiced: 3.10 - 0.030 = 3.07
        self.assertEqual(onset, 3.07)

    def test_find_vowel_nucleus_cluster_with_voiced_liquid(self):
        # "play" starting with unvoiced 'p' followed by voiced liquid 'l'
        char_spans = [
            ("p", 4.00, 4.08),
            ("l", 4.08, 4.16),
            ("a", 4.16, 4.35),
            ("y", 4.35, 4.45),
        ]
        onset = find_vowel_nucleus_from_char_spans(char_spans, fallback_start=4.00, max_prevoicing_sec=0.030)
        # 'l' is voiced: 4.16 - 0.030 = 4.13
        self.assertEqual(onset, 4.13)

    def test_find_vowel_nucleus_initial_vowel(self):
        # "all" starting directly with a vowel
        char_spans = [
            ("a", 5.00, 5.20),
            ("l", 5.20, 5.30),
            ("l", 5.30, 5.40),
        ]
        onset = find_vowel_nucleus_from_char_spans(char_spans, fallback_start=5.00)
        self.assertEqual(onset, 5.00)

    def test_find_vowel_nucleus_no_vowels_fallback(self):
        # Interjection without vowels
        char_spans = [
            ("s", 6.00, 6.10),
            ("h", 6.10, 6.20),
            ("h", 6.20, 6.30),
        ]
        onset = find_vowel_nucleus_from_char_spans(char_spans, fallback_start=6.00)
        self.assertEqual(onset, 6.00)

    def test_compute_vowel_nucleus_onset_silence_pruning(self):
        # Whisper word without char_spans: text "stay", 0.00s to 0.50s
        # Unvoiced frames 0.00 to 0.12s, voiced frames from 0.12s onwards
        hop_sec = 0.010
        total_frames = 60
        pitches = np.full(total_frames, np.nan)
        pitches[12:50] = 62.0  # voiced at 0.12s
        conf = np.zeros(total_frames)
        conf[12:50] = 0.95

        pitch_data = {
            "midi": pitches,
            "conf": conf,
            "frame_dur_sec": hop_sec,
        }

        onset = compute_vowel_nucleus_onset(
            "stay",
            start=0.00,
            end=0.50,
            char_spans=None,
            pitch_data=pitch_data,
        )
        # Should prune initial 120ms unvoiced consonant region
        self.assertAlmostEqual(onset, 0.12, delta=0.01)

    def test_distribute_word_syllables_dual_boundary(self):
        # Verify dual-boundary output in distribute_word_syllables
        char_spans = [
            ("s", 1.00, 1.08),
            ("t", 1.08, 1.15),
            ("a", 1.15, 1.35),
            ("r", 1.35, 1.45),
        ]
        sylls = distribute_word_syllables(
            word="star",
            start=1.00,
            end=1.45,
            lang="en",
            char_spans=char_spans,
        )
        self.assertEqual(len(sylls), 1)
        s = sylls[0]
        # Phonetic lyric start remains 1.00s
        self.assertEqual(s["start"], 1.00)
        # Scored note start moves to vowel nucleus at 1.15s
        self.assertEqual(s["note_start"], 1.15)
        self.assertEqual(s["end"], 1.45)
        self.assertTrue(s["word"].startswith("star"))

    def test_ultrastar_chart_vowel_alignment(self):
        # Full integration test: generate UltraStar chart with dual-boundary syllable
        words = [
            {
                "word": "star ",
                "start": 1.00,
                "note_start": 1.15,
                "end": 1.60,
                "is_syllable": True,
            }
        ]
        total_frames = 200
        pitch_data = {
            "midi": np.array([64.0] * total_frames),
            "pitches": np.array([64.0] * total_frames),
            "conf": np.array([0.95] * total_frames),
            "rms": np.array([0.5] * total_frames),
            "frame_dur_sec": 0.010,
            "total_frames": total_frames,
        }

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
            self.assertEqual(len(chart.notes), 1)
            n = chart.notes[0]
            # Note start beat should correspond to note_start 1.15s (115 beats), not 1.00s (100 beats)
            self.assertEqual(n.start_beat, 115)
            # Text on the note should still retain the full syllable "star "
            self.assertEqual(n.text.strip(), "star")
        finally:
            if temp_path.exists():
                temp_path.unlink()


if __name__ == "__main__":
    unittest.main()
