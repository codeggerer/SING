"""
Master Unit & Integration Test Suite for Phase 4: Tier 4 Pure AI Fallback Consistency.
Spec from TIER_CONSISTENCY_AND_QUALITY_PLAN.md:
- Phase 4.1: Pre-ASR Audio Waveform Masking (Zero Hallucinations)
  clean_waveform = apply_vad_mask(raw_vocals, silence_threshold=0.35)
  Whisper receives pure zero-amplitude silence during solos, making text hallucination physically impossible.
- Phase 4.2: Whisper initial_prompt Metadata Conditioning
  prompt = f"Songtext von {artist} - {title}. Korrekte Groß- und Kleinschreibung, Strophen und Refrain."
  segments, info = whisper_model.transcribe(clean_waveform, initial_prompt=prompt, beam_size=5, word_timestamps=False)
- Synthetic/instrumental audio model verifying zero hallucinations during non-vocal sections.
"""

from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from types import SimpleNamespace
import numpy as np
import soundfile as sf
import torch

from karaoke.vad import (
    apply_vad_mask,
    detect_vocal_intervals,
    filter_hallucinations_vad,
)
from karaoke.transcribe import (
    build_whisper_initial_prompt,
    transcribe_and_forced_align,
    transcribe_lyrics_two_step,
)
from karaoke.lyrics_io import transcribe_lyrics
from karaoke.pipeline import KaraokeJob


class TestPhase4Tier4Consistency(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.sr = 16000
        # 10 second audio file:
        # 0.0 - 3.0s: Non-vocal section (synthetic guitar solo / dissonant harmonics)
        # 3.0 - 6.0s: Vocal singing tone (A4 = 440 Hz)
        # 6.0 - 10.0s: Non-vocal section (silence / instrumental outro)
        cls.duration = 10.0
        n_samples = int(cls.sr * cls.duration)
        cls.synth_audio = np.zeros(n_samples, dtype=np.float32)

        # 0.0 - 3.0s: Non-vocal sawtooth harmonics (guitar solo simulation)
        t_solo = np.linspace(0, 3.0, int(cls.sr * 3.0), endpoint=False)
        solo_signal = 0.3 * (2 * (t_solo * 220 - np.floor(0.5 + t_solo * 220)))
        cls.synth_audio[0:int(3.0 * cls.sr)] = solo_signal

        # 3.0 - 6.0s: Sung vocal tone (pure 440 Hz sinusoidal singing)
        t_vocal = np.linspace(0, 3.0, int(cls.sr * 3.0), endpoint=False)
        vocal_signal = 0.6 * np.sin(2 * np.pi * 440 * t_vocal)
        cls.synth_audio[int(3.0 * cls.sr):int(6.0 * cls.sr)] = vocal_signal

        # 6.0 - 10.0s is pure zero silence

        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.test_wav = Path(cls.tmp_dir.name) / "test_synth_phase4.wav"
        sf.write(str(cls.test_wav), cls.synth_audio, cls.sr)

    @classmethod
    def tearDownClass(cls):
        cls.tmp_dir.cleanup()

    def test_01_apply_vad_mask_silence_threshold_parameter(self):
        """Phase 4.1: apply_vad_mask accepts silence_threshold=0.35 and zeroes unvoiced regions."""
        mock_intervals = [{"start": 3.0, "end": 6.0}]
        with patch("karaoke.vad.detect_vocal_intervals", return_value=mock_intervals):
            # Test returning Path
            masked_wav = apply_vad_mask(self.test_wav, silence_threshold=0.35)
            self.assertIsInstance(masked_wav, Path)
            self.assertTrue(masked_wav.exists())

            data, sr = sf.read(str(masked_wav), dtype="float32")
            self.assertEqual(sr, 16000)

            # 0.5s - 2.5s (guitar solo section) must be zeroed out
            guitar_slice = data[int(0.5 * sr):int(2.5 * sr)]
            self.assertLess(np.max(np.abs(guitar_slice)), 1e-4)

            # 3.5s - 5.5s (voiced singing section) must remain fully intact (> 0.4)
            vocal_slice = data[int(3.5 * sr):int(5.5 * sr)]
            self.assertGreater(np.max(np.abs(vocal_slice)), 0.4)

            # 7.0s - 9.0s (silence / outro) must remain zeroed
            outro_slice = data[int(7.0 * sr):int(9.0 * sr)]
            self.assertLess(np.max(np.abs(outro_slice)), 1e-4)

    def test_02_apply_vad_mask_numpy_in_memory_and_return_waveform(self):
        """Phase 4.1: In-memory numpy array input returns masked array without requiring disk write."""
        mock_intervals = [{"start": 3.0, "end": 6.0}]
        with patch("karaoke.vad.detect_vocal_intervals", return_value=mock_intervals):
            # Pass numpy array directly
            masked_array = apply_vad_mask(self.synth_audio, silence_threshold=0.35)
            self.assertIsInstance(masked_array, np.ndarray)
            self.assertEqual(len(masked_array), len(self.synth_audio))

            # Non-vocal section zeroed out
            self.assertLess(np.max(np.abs(masked_array[int(0.5 * 16000):int(2.5 * 16000)])), 1e-4)
            # Voiced section active
            self.assertGreater(np.max(np.abs(masked_array[int(3.5 * 16000):int(5.5 * 16000)])), 0.4)

    def test_03_apply_vad_mask_return_intervals(self):
        """Phase 4.1: return_intervals=True returns tuple (masked_output, intervals)."""
        mock_intervals = [{"start": 3.0, "end": 6.0}]
        with patch("karaoke.vad.detect_vocal_intervals", return_value=mock_intervals):
            out, intervals = apply_vad_mask(self.test_wav, return_intervals=True, silence_threshold=0.35)
            self.assertEqual(intervals, mock_intervals)
            self.assertTrue(out.exists())

    def test_04_apply_vad_mask_pure_instrumental_zeroes_waveform(self):
        """Phase 4.1 Zero Hallucinations: If no vocal intervals are detected, audio is zeroed out completely."""
        with patch("karaoke.vad.detect_vocal_intervals", return_value=[]):
            masked_arr = apply_vad_mask(self.synth_audio, silence_threshold=0.35)
            self.assertIsInstance(masked_arr, np.ndarray)
            self.assertEqual(np.max(np.abs(masked_arr)), 0.0)

    def test_05_build_whisper_initial_prompt(self):
        """Phase 4.2: Whisper initial_prompt metadata conditioning."""
        # German context
        p_de = build_whisper_initial_prompt("Herbert Grönemeyer", "Männer", language="de")
        self.assertEqual(p_de, "Songtext von Herbert Grönemeyer - Männer. Korrekte Groß- und Kleinschreibung, Strophen und Refrain.")

        # German context auto
        p_auto = build_whisper_initial_prompt("Rammstein", "Engel", language="auto")
        self.assertEqual(p_auto, "Songtext von Rammstein - Engel. Korrekte Groß- und Kleinschreibung, Strophen und Refrain.")

        # English context
        p_en = build_whisper_initial_prompt("Coldplay", "The Scientist", language="en")
        self.assertEqual(p_en, "Lyrics of Coldplay - The Scientist. Correct spelling, capitalization, verses and chorus.")

        # Artist only
        p_artist = build_whisper_initial_prompt("Adele", "", language="en")
        self.assertEqual(p_artist, "Lyrics of Adele. Correct spelling, capitalization, verses and chorus.")

        # Title only
        p_title = build_whisper_initial_prompt("", "Wonderwall", language="en")
        self.assertEqual(p_title, "Lyrics of Wonderwall. Correct spelling, capitalization, verses and chorus.")

        # None on empty
        self.assertIsNone(build_whisper_initial_prompt("", ""))

    def test_06_transcribe_and_forced_align_tier4_prompt_injection(self):
        """Phase 4.2: Whisper receives conditioned prompt and beam_size=5."""
        mock_whisper = MagicMock()
        mock_whisper.transcribe.return_value = (
            [SimpleNamespace(text="Männer weinen heimlich", start=3.0, end=5.5, no_speech_prob=0.01)],
            SimpleNamespace(language="de"),
        )
        mock_intervals = [{"start": 3.0, "end": 6.0}]

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=(self.test_wav, mock_intervals)):

            words, lang = transcribe_and_forced_align(
                self.test_wav,
                artist="Herbert Grönemeyer",
                title="Männer",
                language="de",
                return_syllables=False,
            )

            self.assertEqual(lang, "de")
            self.assertEqual(len(words), 3)
            self.assertEqual([w["word"] for w in words], ["Männer", "weinen", "heimlich"])

            # Verify transcribe call arguments
            mock_whisper.transcribe.assert_called_once()
            kwargs = mock_whisper.transcribe.call_args.kwargs
            self.assertEqual(
                kwargs["initial_prompt"],
                "Songtext von Herbert Grönemeyer - Männer. Korrekte Groß- und Kleinschreibung, Strophen und Refrain."
            )
            self.assertEqual(kwargs["beam_size"], 5)
            self.assertFalse(kwargs["word_timestamps"])
            self.assertFalse(kwargs["vad_filter"])

    def test_07_zero_hallucinations_during_guitar_solo_and_outro(self):
        """
        Phase 4.1 & Live Track Verification:
        Synthetic audio model verifying zero hallucinations during non-vocal sections.
        Even if Whisper hypothetically emits hallucinated phrases during the guitar solo (0.0-3.0s)
        or outro (6.0-10.0s), they MUST be completely eliminated.
        """
        # Voiced interval only at 3.0 - 6.0s
        mock_intervals = [{"start": 3.0, "end": 6.0}]

        # Whisper hallucinates a phrase during guitar solo (1.0 - 2.5s) and outro (7.0 - 8.5s)
        guitar_solo_hallucination = SimpleNamespace(
            text="Guitar solo hallucinated lyrics",
            start=1.0,
            end=2.5,
            no_speech_prob=0.02,
        )
        valid_singing = SimpleNamespace(
            text="Real sung vocal phrase",
            start=3.2,
            end=5.8,
            no_speech_prob=0.01,
        )
        outro_hallucination = SimpleNamespace(
            text="Thanks for watching like and subscribe",
            start=7.0,
            end=8.5,
            no_speech_prob=0.85,  # High no_speech_prob on silence
        )

        mock_whisper = MagicMock()
        mock_whisper.transcribe.return_value = (
            [guitar_solo_hallucination, valid_singing, outro_hallucination],
            SimpleNamespace(language="en"),
        )

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper), \
             patch("karaoke.transcribe.apply_vad_mask", return_value=(self.test_wav, mock_intervals)):

            words, lang = transcribe_and_forced_align(
                self.test_wav,
                artist="Rock Band",
                title="Guitar Solo Song",
                language="en",
                return_syllables=False,
            )

            # Outro hallucination was discarded due to no_speech_prob >= 0.60
            # Guitar solo words (at 1.0 - 2.5s) are eliminated by filter_hallucinations_vad
            word_texts = [w["word"] for w in words]
            self.assertNotIn("Guitar", word_texts)
            self.assertNotIn("solo", word_texts)
            self.assertNotIn("hallucinated", word_texts)
            self.assertNotIn("Thanks", word_texts)
            self.assertNotIn("subscribe", word_texts)

            # Valid singing words MUST remain
            self.assertIn("Real", word_texts)
            self.assertIn("sung", word_texts)
            self.assertIn("vocal", word_texts)
            self.assertIn("phrase", word_texts)

    def test_08_karaoke_job_and_pipeline_tier4_metadata_propagation(self):
        """Verifies that KaraokeJob passes metadata and silence_threshold to transcribe_lyrics."""
        job = KaraokeJob(
            input_audio=self.test_wav,
            artist="Aura",
            title="Lea",
            silence_threshold=0.35,
            initial_prompt="Custom prompt override",
        )
        self.assertEqual(job.silence_threshold, 0.35)
        self.assertEqual(job.initial_prompt, "Custom prompt override")

        with patch("karaoke.transcribe.transcribe_lyrics_two_step") as mock_two_step:
            mock_two_step.return_value = ([{"word": "Aura", "start": 3.0, "end": 4.0}], "en")

            words, lang = transcribe_lyrics(
                self.test_wav,
                artist=job.artist,
                title=job.title,
                silence_threshold=job.silence_threshold,
                initial_prompt=job.initial_prompt,
            )

            mock_two_step.assert_called_once()
            call_kwargs = mock_two_step.call_args.kwargs
            self.assertEqual(call_kwargs.get("artist"), "Aura")
            self.assertEqual(call_kwargs.get("title"), "Lea")
            self.assertEqual(call_kwargs.get("silence_threshold"), 0.35)
            self.assertEqual(call_kwargs.get("initial_prompt"), "Custom prompt override")


if __name__ == "__main__":
    unittest.main()
