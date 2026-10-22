"""
tests/test_syllables_acoustic.py - Precision Unit Tests for Acoustic Syllable Nuclei Slicing (Phase 3).
Validates:
1. Monosyllable protection invariant: duration < 0.28s, phonetic count <= 1, or in MONOSYLLABLE_WORDS.
2. Syllabification and display formatting (syllabify_word).
3. Acoustic energy valley splitting between vowel nuclei using RMS and spectral flux.
4. Graceful fallback on missing, short, or silent audio segments.
5. Melisma (~) inflection detection on sustained syllables with pitch glides >= 1.5 st.
6. Full track vs sliced audio compatibility.
7. Sequence slicing across multiple words (slice_words_acoustically).
"""

import unittest
import numpy as np

from karaoke.syllables_acoustic import (
    slice_word_syllables_acoustically,
    slice_words_acoustically,
    detect_melisma_in_syllable_slice,
    is_monosyllable,
    syllabify_word,
)
from karaoke.notes import (
    is_monosyllable as notes_is_monosyllable,
    syllabify_word as notes_syllabify_word,
)


class TestAcousticSyllablesPhase3(unittest.TestCase):

    def test_monosyllable_protection(self):
        """Monosyllables must never be split regardless of duration."""
        # English monosyllables
        en_monos = ["dance", "breathe", "taste", "space", "night", "voice", "please", "life", "straight"]
        for w in en_monos:
            self.assertTrue(is_monosyllable(w, lang="en", duration=1.0), f"'{w}' should be monosyllabic")
            self.assertTrue(notes_is_monosyllable(w, lang="en", duration=1.0))

        # German monosyllables
        de_monos = ["ein", "traum", "glück", "sehn", "stehn", "nacht", "zeit", "nicht", "schon", "schön"]
        for w in de_monos:
            self.assertTrue(is_monosyllable(w, lang="de", duration=1.0), f"'{w}' should be monosyllabic")
            self.assertTrue(notes_is_monosyllable(w, lang="de", duration=1.0))

        # Words with duration < 0.28s are always protected
        self.assertTrue(is_monosyllable("einfach", lang="de", duration=0.20))
        self.assertTrue(is_monosyllable("together", lang="en", duration=0.25))

        # Multi-syllable words with duration >= 0.28s are not monosyllabic
        self.assertFalse(is_monosyllable("einfach", lang="de", duration=0.60))
        self.assertFalse(is_monosyllable("Fenster", lang="de", duration=0.80))
        self.assertFalse(is_monosyllable("together", lang="en", duration=0.70))

    def test_syllabify_word_formatting(self):
        """syllabify_word must provide 'display', 'text', 'word', and 'raw' attributes."""
        # Monosyllable
        mono_res = syllabify_word("traum", lang="de")
        self.assertEqual(len(mono_res), 1)
        self.assertEqual(mono_res[0]["display"], "traum ")
        self.assertEqual(mono_res[0]["raw"], "traum")
        self.assertTrue(mono_res[0]["is_last"])

        # 2-syllable word
        res2 = syllabify_word("Fenster", lang="de")
        self.assertEqual(len(res2), 2)
        self.assertEqual(res2[0]["display"], "Fens-")
        self.assertFalse(res2[0]["is_last"])
        self.assertEqual(res2[1]["display"], "ter ")
        self.assertTrue(res2[1]["is_last"])

        # Identical behavior through notes re-export
        res2_notes = notes_syllabify_word("Fenster", lang="de")
        self.assertEqual(len(res2_notes), 2)
        self.assertEqual(res2_notes[0]["display"], "Fens-")
        self.assertEqual(res2_notes[1]["display"], "ter ")

    def test_acoustic_slicing_two_peaks_synthetic_audio(self):
        """
        Synthesizes a 2-syllable vocal audio signal ('Fen-ster') with two energy pulses
        separated by an acoustic energy valley (consonant 'st').
        Verifies slice_word_syllables_acoustically splits at the valley.
        """
        sr = 16000
        total_dur = 0.80  # 800ms
        n_samples = int(total_dur * sr)
        audio = np.zeros(n_samples, dtype=np.float32)

        t = np.linspace(0, total_dur, n_samples, endpoint=False, dtype=np.float32)

        # Pulse 1 (vowel nucleus 1 'Fen'): 0.05s to 0.32s
        p1_mask = (t >= 0.05) & (t <= 0.32)
        t1 = t[p1_mask] - 0.05
        env1 = np.sin(np.pi * (t1 / (0.32 - 0.05)))
        audio[p1_mask] = 0.8 * env1 * np.sin(2 * np.pi * 220 * t[p1_mask])

        # Valley (consonant 'st'): 0.32s to 0.44s has very low energy (10% noise)
        valley_mask = (t > 0.32) & (t < 0.44)
        audio[valley_mask] = 0.02 * np.sin(2 * np.pi * 500 * t[valley_mask])

        # Pulse 2 (vowel nucleus 2 'ster'): 0.44s to 0.75s
        p2_mask = (t >= 0.44) & (t <= 0.75)
        t2 = t[p2_mask] - 0.44
        env2 = np.sin(np.pi * (t2 / (0.75 - 0.44)))
        audio[p2_mask] = 0.7 * env2 * np.sin(2 * np.pi * 220 * t[p2_mask])

        word_item = {
            "word": "Fenster",
            "start": 1.0,
            "end": 1.8,
            "line_break_after": False,
        }

        # Test with word audio slice
        slices = slice_word_syllables_acoustically(
            word_item=word_item,
            vocal_audio_segment=audio,
            sr=sr,
            lang="de",
            detect_melisma=False,
        )

        self.assertEqual(len(slices), 2, f"Expected 2 syllables for 'Fenster', got {len(slices)}")
        self.assertEqual(slices[0]["text"], "Fens-")
        self.assertEqual(slices[1]["text"], "ter ")

        # Onset of syllable 1 should be word start (1.0)
        self.assertAlmostEqual(slices[0]["start"], 1.0, places=2)
        # End of syllable 2 should be word end (1.8)
        self.assertAlmostEqual(slices[1]["end"], 1.8, places=2)

        # Boundary split point should fall inside the acoustic valley [1.32, 1.44]
        split_time = slices[0]["end"]
        self.assertEqual(slices[1]["start"], split_time)
        self.assertGreaterEqual(split_time, 1.28)
        self.assertLessEqual(split_time, 1.48)

    def test_full_track_audio_windowing(self):
        """Pass full-length audio track (e.g. 10s) and verify word window extraction."""
        sr = 16000
        full_audio = np.zeros(10 * sr, dtype=np.float32)
        # Place pulses at 3.05..3.32s and 3.44..3.75s
        w_start, w_end = 3.0, 3.8
        t_sub = np.linspace(0, 0.8, int(0.8 * sr), endpoint=False, dtype=np.float32)
        env = np.sin(np.pi * t_sub / 0.8)
        full_audio[int(3.0 * sr):int(3.8 * sr)] = 0.6 * env * np.sin(2 * np.pi * 300 * t_sub)

        word_item = {"word": "Fenster", "start": w_start, "end": w_end}
        slices = slice_word_syllables_acoustically(
            word_item=word_item,
            vocal_audio_segment=full_audio,
            sr=sr,
            lang="de",
        )
        self.assertEqual(len(slices), 2)
        self.assertAlmostEqual(slices[0]["start"], 3.0, places=2)
        self.assertAlmostEqual(slices[1]["end"], 3.8, places=2)

    def test_monosyllable_and_short_word_never_split_in_acoustic_slicer(self):
        """1-syllable words and short words must return exactly 1 item."""
        sr = 16000
        audio = np.ones(int(0.5 * sr), dtype=np.float32) * 0.5

        # Protected monosyllable with longer duration
        res = slice_word_syllables_acoustically(
            {"word": "traum", "start": 0.0, "end": 0.5},
            vocal_audio_segment=audio,
            sr=sr,
            lang="de",
        )
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "traum ")
        self.assertEqual(res[0]["start"], 0.0)
        self.assertEqual(res[0]["end"], 0.5)

        # Multi-syllable word but duration < 0.28s
        res_short = slice_word_syllables_acoustically(
            {"word": "Fenster", "start": 0.0, "end": 0.22},
            vocal_audio_segment=audio[:int(0.22 * sr)],
            sr=sr,
            lang="de",
        )
        self.assertEqual(len(res_short), 1)
        self.assertEqual(res_short[0]["text"], "Fenster ")

    def test_silent_or_missing_audio_fallback(self):
        """When audio is None or silent, fallback to valid proportional/vowel split."""
        word_item = {"word": "Fenster", "start": 2.0, "end": 2.8, "line_break_after": True}

        # None audio
        res_none = slice_word_syllables_acoustically(word_item, vocal_audio_segment=None)
        self.assertEqual(len(res_none), 2)
        self.assertEqual(res_none[0]["text"], "Fens-")
        self.assertEqual(res_none[1]["text"], "ter ")
        self.assertEqual(res_none[0]["start"], 2.0)
        self.assertEqual(res_none[1]["end"], 2.8)
        self.assertTrue(res_none[1]["line_break_after"])

        # Silent audio
        silent = np.zeros(16000, dtype=np.float32)
        res_silent = slice_word_syllables_acoustically(word_item, vocal_audio_segment=silent)
        self.assertEqual(len(res_silent), 2)
        self.assertEqual(res_silent[0]["start"], 2.0)
        self.assertEqual(res_silent[1]["end"], 2.8)

    def test_melisma_pitch_inflection_detection(self):
        """Sustained note with >= 1.5 semitones pitch glide splits into base note and '~'."""
        total_frames = 60
        frame_dur = 0.010
        midis = np.zeros(total_frames, dtype=np.float32)
        # 0.0 to 0.3s (30 frames): MIDI 60 (C4)
        midis[:30] = 60.0
        # 0.3 to 0.6s (30 frames): MIDI 64 (E4) -> 4 semitones shift
        midis[30:] = 64.0
        conf = np.ones(total_frames, dtype=np.float32) * 0.90
        rms = np.ones(total_frames, dtype=np.float32) * 0.50

        pitch_data = {
            "type": "contour",
            "frame_dur_sec": frame_dur,
            "midi": midis,
            "conf": conf,
            "rms": rms,
            "total_frames": total_frames,
        }

        syllable = {
            "text": "traum ",
            "word": "traum ",
            "start": 0.0,
            "end": 0.60,
            "is_syllable": True,
            "line_break_after": True,
        }

        res = detect_melisma_in_syllable_slice(syllable, pitch_data, min_dur=0.40, min_st_diff=1.5)
        self.assertIsNotNone(res)
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0]["text"], "traum-")
        self.assertEqual(res[1]["text"], "~ ")
        self.assertAlmostEqual(res[0]["start"], 0.0, places=2)
        self.assertAlmostEqual(res[1]["end"], 0.60, places=2)
        self.assertTrue(res[1]["line_break_after"])

    def test_slice_words_acoustically_chain(self):
        """Processes multiple words into flattened acoustic syllable sequence."""
        sr = 16000
        audio = np.zeros(4 * sr, dtype=np.float32)

        words = [
            {"word": "Fenster", "start": 1.0, "end": 1.8},
            {"word": "runter", "start": 2.0, "end": 2.6, "line_break_after": True},
        ]

        sylls = slice_words_acoustically(words, vocal_audio=audio, sr=sr, lang="de", detect_melisma=False)
        self.assertEqual(len(sylls), 4)
        self.assertEqual([s["text"] for s in sylls], ["Fens-", "ter ", "run-", "ter "])
        self.assertAlmostEqual(sylls[0]["start"], 1.0, places=2)
        self.assertAlmostEqual(sylls[1]["end"], 1.8, places=2)
        self.assertAlmostEqual(sylls[2]["start"], 2.0, places=2)
        self.assertAlmostEqual(sylls[3]["end"], 2.6, places=2)
        self.assertTrue(sylls[3]["line_break_after"])


if __name__ == "__main__":
    unittest.main()
