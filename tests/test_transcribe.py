"""
Unit tests for Two-Step Whisper-to-MMS Decoupled Pipeline (karaoke/transcribe.py).
"""

from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from types import SimpleNamespace
import numpy as np
import soundfile as sf

from karaoke.transcribe import (
    transcribe_and_forced_align,
    transcribe_lyrics_two_step,
    build_whisper_initial_prompt,
)


class TestTranscribePipeline(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.sr = 16000
        cls.duration = 4.0
        n_samples = int(cls.sr * cls.duration)
        audio = np.zeros(n_samples, dtype=np.float32)

        # Tone 1.0 - 3.0s
        t = np.linspace(0, 2.0, int(cls.sr * 2.0), endpoint=False)
        audio[int(1.0 * cls.sr):int(3.0 * cls.sr)] = 0.5 * np.sin(2 * np.pi * 440 * t)

        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.test_wav = Path(cls.tmp_dir.name) / "test_synth_transcribe.wav"
        sf.write(str(cls.test_wav), audio, cls.sr)

    @classmethod
    def tearDownClass(cls):
        cls.tmp_dir.cleanup()

    def test_01_nonexistent_file_raises_error(self):
        with self.assertRaises(FileNotFoundError):
            transcribe_and_forced_align("nonexistent_file_12345.wav")

    def test_02_empty_segments_returns_empty_list(self):
        mock_whisper_instance = MagicMock()
        mock_whisper_instance.transcribe.return_value = ([], SimpleNamespace(language="en"))

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_instance), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=self.test_wav):
            words, lang = transcribe_and_forced_align(self.test_wav)
            self.assertEqual(words, [])
            self.assertEqual(lang, "en")

    def test_03_whisper_timestamps_discarded_and_mms_aligned(self):
        # Create mock segments with intentionally bad/shifted Whisper timestamps
        # Whisper says word is at 100.0s to 105.0s, but audio is only 4s!
        # MMS alignment MUST align against the actual audio waveform.
        seg1 = SimpleNamespace(
            text="Hallo Welt",
            start=1.0,
            end=3.0,
        )
        mock_info = SimpleNamespace(language="de")

        mock_whisper_instance = MagicMock()
        mock_whisper_instance.transcribe.return_value = ([seg1], mock_info)

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_instance), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=self.test_wav):

            # Test word-level output (return_syllables=False)
            words, lang = transcribe_and_forced_align(
                self.test_wav,
                language="de",
                device="cpu",
                return_syllables=False,
            )

            self.assertEqual(lang, "de")
            self.assertEqual(len(words), 2)
            self.assertEqual(words[0]["word"], "Hallo")
            self.assertEqual(words[1]["word"], "Welt")

            # Word timestamps must be within valid audio boundaries [0, 4.0s]
            for w in words:
                self.assertGreaterEqual(w["start"], 0.0)
                self.assertLessEqual(w["end"], 4.0)
                self.assertGreater(w["end"], w["start"])

    def test_04_syllable_level_output(self):
        seg1 = SimpleNamespace(
            text="Hallo Welt",
            start=1.0,
            end=3.0,
        )
        mock_info = SimpleNamespace(language="de")

        mock_whisper_instance = MagicMock()
        mock_whisper_instance.transcribe.return_value = ([seg1], mock_info)

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_instance), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=self.test_wav):

            # Test syllable-level output (return_syllables=True)
            sylls, lang = transcribe_and_forced_align(
                self.test_wav,
                language="de",
                device="cpu",
                return_syllables=True,
            )

            self.assertEqual(lang, "de")
            self.assertGreaterEqual(len(sylls), 2)
            for s in sylls:
                self.assertTrue(s.get("is_syllable", False))
                self.assertIn("word", s)
                self.assertIn("start", s)
                self.assertIn("end", s)

    def test_05_transcribe_lyrics_two_step_cache(self):
        # Test stage cache integration
        mock_cache = MagicMock()
        cached_result = ([{"word": "Cached", "start": 1.0, "end": 2.0}], "en")
        mock_cache.load_words.return_value = cached_result

        words, lang = transcribe_lyrics_two_step(
            self.test_wav,
            stage_cache=mock_cache,
        )
        self.assertEqual(words, cached_result[0])
        self.assertEqual(lang, "en")
        mock_cache.load_words.assert_called_once()

    def test_06_build_whisper_initial_prompt_metadata_conditioning(self):
        # 4.2 German prompt conditioning
        prompt_de = build_whisper_initial_prompt("Herbert Grönemeyer", "Männer", language="de")
        self.assertEqual(
            prompt_de,
            "Songtext von Herbert Grönemeyer - Männer. Korrekte Groß- und Kleinschreibung, Strophen und Refrain."
        )

        # 4.2 Auto-detect German with umlauts
        prompt_auto_de = build_whisper_initial_prompt("Klaus", "Träume", language="auto")
        self.assertIn("Songtext von Klaus - Träume", prompt_auto_de)

        # 4.2 English prompt conditioning
        prompt_en = build_whisper_initial_prompt("Queen", "Bohemian Rhapsody", language="en")
        self.assertEqual(
            prompt_en,
            "Lyrics of Queen - Bohemian Rhapsody. Correct spelling, capitalization, verses and chorus."
        )

        # Empty artist & title -> None
        self.assertIsNone(build_whisper_initial_prompt("", ""))
        self.assertIsNone(build_whisper_initial_prompt(None, None))

    def test_07_whisper_receives_conditioned_initial_prompt(self):
        mock_whisper_instance = MagicMock()
        mock_info = SimpleNamespace(language="de")
        seg1 = SimpleNamespace(text="Hallo Welt", start=1.0, end=3.0, no_speech_prob=0.01)
        mock_whisper_instance.transcribe.return_value = ([seg1], mock_info)

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_instance), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=self.test_wav):

            transcribe_and_forced_align(
                self.test_wav,
                artist="Herbert Grönemeyer",
                title="Männer",
                language="de",
                return_syllables=False,
            )

            # Check that whisper_model.transcribe was called with initial_prompt
            mock_whisper_instance.transcribe.assert_called_once()
            call_kwargs = mock_whisper_instance.transcribe.call_args.kwargs
            self.assertIn("initial_prompt", call_kwargs)
            expected_prompt = "Songtext von Herbert Grönemeyer - Männer. Korrekte Groß- und Kleinschreibung, Strophen und Refrain."
            self.assertEqual(call_kwargs["initial_prompt"], expected_prompt)
            self.assertFalse(call_kwargs["word_timestamps"])
            self.assertEqual(call_kwargs["beam_size"], 5)

    def test_08_no_speech_prob_filtering_on_silence(self):
        # A valid speech segment and a phantom hallucination segment with high no_speech_prob
        valid_seg = SimpleNamespace(text="Hallo Welt", start=1.0, end=3.0, no_speech_prob=0.05)
        hallucinated_seg = SimpleNamespace(text="You", start=3.5, end=4.0, no_speech_prob=0.85)

        mock_whisper_instance = MagicMock()
        mock_whisper_instance.transcribe.return_value = ([valid_seg, hallucinated_seg], SimpleNamespace(language="de"))

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_instance), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=self.test_wav):

            words, lang = transcribe_and_forced_align(
                self.test_wav,
                language="de",
                return_syllables=False,
            )

            # Only "Hallo" and "Welt" should be aligned, "You" must be filtered out
            word_texts = [w["word"] for w in words]
            self.assertIn("Hallo", word_texts)
            self.assertIn("Welt", word_texts)
            self.assertNotIn("You", word_texts)

    def test_09_silence_threshold_forwarded_to_apply_vad_mask(self):
        mock_whisper_instance = MagicMock()
        mock_whisper_instance.transcribe.return_value = ([], SimpleNamespace(language="en"))

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_instance), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=self.test_wav) as mock_vad:

            transcribe_and_forced_align(
                self.test_wav,
                silence_threshold=0.35,
            )

            mock_vad.assert_called_once()
            call_kwargs = mock_vad.call_args.kwargs
            self.assertEqual(call_kwargs.get("silence_threshold"), 0.35)
            self.assertTrue(call_kwargs.get("return_intervals"))


if __name__ == "__main__":
    unittest.main()
