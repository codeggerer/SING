"""
Unit tests for Silero VAD v5 engine (karaoke/vad.py).
"""

from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import soundfile as sf

from karaoke.vad import (
    load_silero_vad,
    detect_vocal_intervals,
    extract_speech_timestamps,
    calculate_acoustic_line_breaks,
    apply_vad_mask,
    apply_acoustic_breath_breaks,
    filter_hallucinations_vad,
    _detect_intervals_rms,
)
from karaoke.chart import generate_ultrastar_chart


class TestSileroVAD(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Create a synthetic audio file
        cls.sr = 16000
        cls.duration = 5.0
        n_samples = int(cls.sr * cls.duration)
        audio = np.zeros(n_samples, dtype=np.float32)

        # Voiced tone 1.0 - 2.2s
        t1 = np.linspace(0, 1.2, int(cls.sr * 1.2), endpoint=False)
        audio[int(1.0 * cls.sr):int(2.2 * cls.sr)] = 0.5 * np.sin(2 * np.pi * 440 * t1)

        # Voiced tone 3.2 - 4.5s
        t2 = np.linspace(0, 1.3, int(cls.sr * 1.3), endpoint=False)
        audio[int(3.2 * cls.sr):int(4.5 * cls.sr)] = 0.5 * np.sin(2 * np.pi * 520 * t2)

        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.test_wav = Path(cls.tmp_dir.name) / "test_synth_vad.wav"
        sf.write(str(cls.test_wav), audio, cls.sr)

    @classmethod
    def tearDownClass(cls):
        cls.tmp_dir.cleanup()

    def test_01_load_silero_vad(self):
        model, utils = load_silero_vad()
        self.assertIsNotNone(model)
        self.assertIsNotNone(utils)
        self.assertEqual(len(utils), 5)

    def test_02_detect_vocal_intervals_rms_fallback(self):
        intervals = _detect_intervals_rms(self.test_wav)
        self.assertIsInstance(intervals, list)
        self.assertGreaterEqual(len(intervals), 1)
        for item in intervals:
            self.assertIn("start", item)
            self.assertIn("end", item)
            self.assertGreater(item["end"], item["start"])

    def test_03_detect_vocal_intervals_real_or_mock(self):
        real_vocals = Path("output/eval/cro-easy/htdemucs/audio/vocals.wav")
        if real_vocals.exists():
            intervals = detect_vocal_intervals(real_vocals)
            self.assertIsInstance(intervals, list)
            self.assertGreater(len(intervals), 0)
        else:
            mock_intervals = [{"start": 1.0, "end": 2.2}, {"start": 3.2, "end": 4.5}]
            with patch("karaoke.vad.detect_vocal_intervals", return_value=mock_intervals):
                intervals = detect_vocal_intervals(self.test_wav)
                self.assertEqual(len(intervals), 2)

    def test_04_calculate_acoustic_line_breaks(self):
        # Provide two speech timestamps separated by 1.0s silence (2.2s to 3.2s)
        speech_ts = [
            {"start": 1.0, "end": 2.2},
            {"start": 3.2, "end": 4.5},
        ]
        line_breaks = calculate_acoustic_line_breaks(speech_ts, bpm=1500.0)
        self.assertEqual(len(line_breaks), 1)
        # Midpoint of 2.2 and 3.2 is 2.7s. At BPM 1500, beat_dur is 0.01s -> beat 270
        self.assertEqual(line_breaks[0], 270)

    def test_05_apply_vad_mask_with_mock_intervals(self):
        mock_intervals = [{"start": 1.0, "end": 2.2}, {"start": 3.2, "end": 4.5}]
        with patch("karaoke.vad.detect_vocal_intervals", return_value=mock_intervals):
            masked_wav = apply_vad_mask(self.test_wav)
            self.assertTrue(masked_wav.exists())
            self.assertTrue(masked_wav.stat().st_size > 0)

            # Verify that samples in unvoiced region (e.g., 0.2s) are silenced (< 1e-4)
            data, sr = sf.read(str(masked_wav), dtype="float32")
            self.assertEqual(sr, 16000)
            unvoiced_slice = data[int(0.1 * sr):int(0.5 * sr)]
            self.assertTrue(np.max(np.abs(unvoiced_slice)) < 1e-4)
            # Voiced region should remain active
            voiced_slice = data[int(1.2 * sr):int(1.8 * sr)]
            self.assertTrue(np.max(np.abs(voiced_slice)) > 0.1)

    def test_06_filter_hallucinations_vad(self):
        # Speech intervals at 1.0-2.5s and 5.0-7.0s
        speech_intervals = [
            {"start": 1.0, "end": 2.5},
            {"start": 5.0, "end": 7.0},
        ]
        # Candidate words: 2 valid words, 1 guitar solo hallucination at 15.0s
        words = [
            {"word": "Sing", "start": 1.2, "end": 2.0},
            {"word": "song", "start": 5.2, "end": 6.0},
            {"word": "guitar_solo_hallucination", "start": 15.0, "end": 16.0},
        ]
        filtered = filter_hallucinations_vad(words, speech_intervals)
        self.assertEqual(len(filtered), 2)
        words_text = [w["word"] for w in filtered]
        self.assertIn("Sing", words_text)
        self.assertIn("song", words_text)
        self.assertNotIn("guitar_solo_hallucination", words_text)

    def test_07_apply_acoustic_breath_breaks(self):
        speech_intervals = [
            {"start": 1.0, "end": 2.5},
            {"start": 3.5, "end": 5.0}, # 1.0s silence between 2.5 and 3.5
        ]
        words = [
            {"word": "First", "start": 1.0, "end": 1.6},
            {"word": "line", "start": 1.8, "end": 2.4},
            {"word": "Second", "start": 3.6, "end": 4.2},
            {"word": "phrase", "start": 4.4, "end": 4.9},
        ]
        updated = apply_acoustic_breath_breaks(words, speech_timestamps=speech_intervals, bpm=1500.0)
        self.assertEqual(len(updated), 4)

        # "line" should have line_break_after = True and pause_beat at midpoint of silence (3.0s -> beat 300)
        self.assertTrue(updated[1].get("line_break_after", False))
        self.assertEqual(updated[1].get("pause_beat"), 300)

        # "phrase" at the end should not have break beat
        self.assertFalse(updated[0].get("line_break_after", False))

    def test_08_acoustic_line_breaks_in_ultrastar_chart(self):
        speech_intervals = [
            {"start": 1.0, "end": 2.5},
            {"start": 3.5, "end": 5.0},
        ]
        words = [
            {"word": "First", "start": 1.0, "end": 1.6},
            {"word": "line", "start": 1.8, "end": 2.4},
            {"word": "Second", "start": 3.6, "end": 4.2},
            {"word": "phrase", "start": 4.4, "end": 4.9},
        ]
        # Dummy pitch data: 6.0 seconds
        n_frames = 600
        pitch_data = {
            "timestamps": np.linspace(0, 6.0, n_frames),
            "midi": np.full(n_frames, 60.0),
            "confidence": np.ones(n_frames),
            "rms": np.ones(n_frames) * 0.5,
        }
        out_txt = Path(self.tmp_dir.name) / "test_chart_breaks.txt"
        generate_ultrastar_chart(
            words=words,
            pitch_data=pitch_data,
            display_bpm=120,
            title="Acoustic Break Song",
            artist="AI Artist",
            output_txt_path=out_txt,
            speech_timestamps=speech_intervals,
        )

        self.assertTrue(out_txt.exists())
        content = out_txt.read_text(encoding="utf-8")
        lines = [line.strip() for line in content.splitlines()]

        # Check for presence of phrase break directive '-'
        break_lines = [l for l in lines if l.startswith("- ")]
        self.assertGreaterEqual(len(break_lines), 1)
        # Verify the break beat is at 300 (midpoint of 2.5 and 3.5s)
        self.assertIn("- 300", break_lines)


if __name__ == "__main__":
    unittest.main()
