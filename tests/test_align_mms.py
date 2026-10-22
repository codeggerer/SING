"""
Comprehensive Unit Tests for MMS CTC Trellis Forced Alignment Engine (Phase 4).
Tests:
1. Multilingual text normalization and number spelling (DE & EN)
2. MMSForcedAligner singleton, model loading, and tokenizer
3. CTC forced alignment with repeated characters and minimum frame requirements
4. Zero 4-second syllable overflow bug verification (silent gap truncation)
5. Acoustic energy pulse alignment (onset snapping)
6. Monosyllable protection in syllabification
7. Punctuation/symbol resilience without discarding line alignment
"""

import unittest
from types import SimpleNamespace
import numpy as np
import torch

from karaoke.align_mms import (
    spell_number,
    clean_word_for_mms,
    normalize_transcript_for_mms,
    MMSForcedAligner,
    distribute_word_syllables,
    snap_syllables_to_audio,
    prune_note_ends,
    align_lyrics_doc_mms,
    align_whisper_words_mms,
    MMS_VALID_CHARS,
)


class TestAlignMMS(unittest.TestCase):

    def test_spell_number(self):
        # German
        self.assertEqual(spell_number(0, "de"), "null")
        self.assertEqual(spell_number(1, "de"), "eins")
        self.assertEqual(spell_number(12, "de"), "zwoelf")
        self.assertEqual(spell_number(36, "de"), "sechsunddreissig")
        self.assertEqual(spell_number(100, "de"), "einhundert")
        self.assertEqual(spell_number(105, "de"), "einhundertfuenf")
        self.assertTrue(spell_number(1999, "de").startswith("eintausend"))

        # English
        self.assertEqual(spell_number(0, "en"), "zero")
        self.assertEqual(spell_number(1, "en"), "one")
        self.assertEqual(spell_number(12, "en"), "twelve")
        self.assertEqual(spell_number(36, "en"), "thirty six")
        self.assertEqual(spell_number(100, "en"), "one hundred")

    def test_clean_word_for_mms_numbers(self):
        # Numbers converted to words for MMS
        self.assertEqual(clean_word_for_mms("36", "de"), "sechsunddreissig")
        self.assertEqual(clean_word_for_mms("36", "en"), "thirtysix")
        self.assertEqual(clean_word_for_mms("100%", "de"), "einhundert")
        self.assertEqual(clean_word_for_mms("2raumwohnung", "de"), "zweiraumwohnung")

    def test_clean_word_for_mms_diacritics_and_punctuation(self):
        # German umlauts and ß
        self.assertEqual(clean_word_for_mms("schön", "de"), "schoen")
        self.assertEqual(clean_word_for_mms("Mädchen", "de"), "maedchen")
        self.assertEqual(clean_word_for_mms("süß", "de"), "suess")

        # Apostrophes preserved, other punctuation removed
        self.assertEqual(clean_word_for_mms("don't", "en"), "don't")
        self.assertEqual(clean_word_for_mms("it's", "en"), "it's")
        self.assertEqual(clean_word_for_mms("seh'n", "de"), "seh'n")
        self.assertEqual(clean_word_for_mms("...hello, world!...", "en"), "helloworld")

        # Accented characters
        self.assertEqual(clean_word_for_mms("café", "en"), "cafe")
        self.assertEqual(clean_word_for_mms("señor", "en"), "senor")

        # Output contains only MMS valid chars
        cleaned = clean_word_for_mms("¿Qué tal, 123 Schönheiten?!", "de")
        for ch in cleaned:
            self.assertIn(ch, MMS_VALID_CHARS)

    def test_mms_aligner_singleton_and_device(self):
        aligner1 = MMSForcedAligner.get_instance()
        aligner2 = MMSForcedAligner.get_instance()
        self.assertIs(aligner1, aligner2)
        self.assertIsNotNone(aligner1.model)
        self.assertIsNotNone(aligner1.tokenizer)
        self.assertIsNotNone(aligner1.aligner)
        self.assertEqual(aligner1.sample_rate, 16000)

    def test_mms_align_repeated_characters_and_padding(self):
        # Repeated letters: "free" ('ee'), "good" ('oo'), "alles" ('ll')
        aligner = MMSForcedAligner.get_instance()
        sr = 16000
        # Create a short chunk of audio (e.g. 0.5s = 8000 samples)
        t = np.linspace(0, 0.5, 8000, endpoint=False, dtype=np.float32)
        sine = 0.5 * np.sin(2 * np.pi * 220 * t)
        chunk = torch.from_numpy(sine).unsqueeze(0)

        words = ["free", "good", "alles"]
        spans, ratio = aligner.align_chunk(chunk, words)
        self.assertIsNotNone(spans)
        self.assertEqual(len(spans), 3)
        self.assertGreater(ratio, 0.0)

    def test_mms_minimum_frame_padding_short_chunk(self):
        # A tiny chunk of audio (100 samples < 1 frame) must be auto-padded without CTC crash
        aligner = MMSForcedAligner.get_instance()
        chunk = torch.randn(1, 100)
        spans, ratio = aligner.align_chunk(chunk, ["sing", "song"])
        self.assertIsNotNone(spans)
        self.assertEqual(len(spans), 2)

    def test_zero_4s_syllable_overflow_bug(self):
        """
        Verification Criteria: Zero word stretching or 4-second syllable overflow bugs.
        A word spanning across a 3.5s silent gap must be pruned to the active vocal tail.
        """
        total_frames = 450  # 4.5 seconds at 10ms/frame
        hop_sec = 0.010
        pitches = np.full(total_frames, np.nan)
        # Singer is voiced only from 0.0s to 1.0s (frames 0..99), followed by 3.5s of silence
        pitches[0:100] = 60.0

        pitch_data = {"midi": pitches, "frame_dur_sec": hop_sec}
        # Naive or stretched syllable covering 0.0s to 4.5s
        syllables = [
            {"word": "heart ", "start": 0.0, "end": 4.5, "is_syllable": True}
        ]

        pruned = prune_note_ends(syllables, pitch_data=pitch_data)
        # End must be clamped to ~1.0s + 0.040s tail margin (<= 1.10s), NOT 4.5s!
        self.assertLessEqual(pruned[0]["end"], 1.10)
        self.assertGreaterEqual(pruned[0]["end"], 0.95)
        # Never extends across silence gap >= 120ms
        self.assertLess(pruned[0]["end"] - pruned[0]["start"], 1.5)

    def test_acoustic_energy_snapping(self):
        """
        Verification Criteria: Syllable boundaries align to vocal acoustic energy pulses.
        """
        sr = 16000
        dur_sec = 2.0
        audio = np.zeros(int(dur_sec * sr), dtype=np.float32)
        # Synthesize an acoustic pulse at t = 0.55s
        pulse_idx = int(0.55 * sr)
        audio[pulse_idx:pulse_idx + 200] = 0.9

        syllables = [
            {"word": "sun ", "start": 0.50, "end": 0.90, "is_syllable": True}
        ]
        snapped = snap_syllables_to_audio(syllables, audio, sr=sr, window_sec=0.120)
        # The syllable onset should snap closer to the energy pulse at 0.55s
        self.assertAlmostEqual(snapped[0]["start"], 0.55, delta=0.03)

    def test_monosyllable_protection(self):
        # Monosyllable words with silent-e, diphthongs, or duration < 0.28s must never be split
        res_dance = distribute_word_syllables("dance", 0.0, 0.40, lang="en")
        self.assertEqual(len(res_dance), 1)
        self.assertTrue(res_dance[0]["word"].startswith("dance"))

        res_breathe = distribute_word_syllables("breathe", 0.0, 0.35, lang="en")
        self.assertEqual(len(res_breathe), 1)

        res_short = distribute_word_syllables("forever", 0.0, 0.25, lang="en")
        self.assertEqual(len(res_short), 1)  # Duration < 0.28s prevents splitting

    def test_align_lyrics_doc_mms_number_preservation(self):
        # Mock LyricsDoc containing a number ("36 Grad und es wird noch heisser")
        import tempfile
        import soundfile as sf

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            temp_wav = f.name

        sr = 16000
        # Synthesize 4 seconds of audio with singing frequencies
        t = np.linspace(0, 4.0, int(4.0 * sr), endpoint=False, dtype=np.float32)
        audio = 0.5 * np.sin(2 * np.pi * 220 * t)
        sf.write(temp_wav, audio, sr)

        try:
            line = SimpleNamespace(
                words="36 Grad und es wird noch heisser",
                start=0.5,
                end=3.5,
            )
            doc = SimpleNamespace(
                syncType="line",
                lyricsOffsetSec=0.0,
                language="de",
                lines=[line],
            )

            pitches = np.full(400, 60.0)
            pitch_data = {"midi": pitches, "frame_dur_sec": 0.010}

            sylls = align_lyrics_doc_mms(temp_wav, doc, pitch_data=pitch_data)
            self.assertGreaterEqual(len(sylls), 7)
            # First word must be 36
            self.assertTrue(sylls[0]["word"].startswith("36"))
            # Monotonicity
            for i in range(len(sylls) - 1):
                self.assertLessEqual(sylls[i]["start"], sylls[i+1]["start"])
        finally:
            import os
            if os.path.exists(temp_wav):
                os.remove(temp_wav)


if __name__ == "__main__":
    unittest.main()
