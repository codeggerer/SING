"""
Unit tests for Pipeline Refactoring, Stage Caching & Progress Callbacks (Phase 3).
"""

import unittest
import os
import json
import tempfile
import numpy as np
from pathlib import Path
from unittest.mock import patch, MagicMock

import karaoke
from karaoke.cache import StageCache, compute_audio_sha1
from karaoke.pipeline import KaraokeJob, run


class TestSeparateModuleImports(unittest.TestCase):

    def test_imports(self):
        import karaoke.separate
        import karaoke.lyrics_io
        import karaoke.pitch
        import karaoke.notes
        import karaoke.chart
        import karaoke.pipeline
        import karaoke.hardware
        import karaoke.cache
        import karaoke.config
        self.assertTrue(hasattr(karaoke.separate, "separate_stems"))
        self.assertTrue(hasattr(karaoke.lyrics_io, "transcribe_lyrics"))
        self.assertTrue(hasattr(karaoke.pitch, "analyze_vocal_pitch"))
        self.assertTrue(hasattr(karaoke.chart, "generate_ultrastar_chart"))
        self.assertTrue(hasattr(karaoke.pipeline, "run"))


class TestStageCache(unittest.TestCase):

    def test_cache_f0_and_words(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            fake_audio = base_dir / "test_song.wav"
            fake_audio.write_bytes(b"RIFF....WAVEfmt ....data....test audio content")

            sha1 = compute_audio_sha1(fake_audio)
            self.assertEqual(len(sha1), 40)

            cache = StageCache(base_dir, fake_audio)
            self.assertEqual(cache.audio_hash, sha1)

            # Test f0 cache
            sample_f0 = {
                "type": "contour",
                "frame_dur_sec": 0.010,
                "midi": np.array([60.0, 62.0, 64.0]),
                "conf": np.array([0.9, 0.95, 0.99]),
                "rms": np.array([0.5, 0.6, 0.7]),
                "total_frames": 3,
                "sr": 16000
            }
            cache.save_f0(sample_f0, pitch_engine="pyin")
            loaded_f0 = cache.load_f0(pitch_engine="pyin")
            self.assertIsNotNone(loaded_f0)
            self.assertEqual(loaded_f0["total_frames"], 3)
            np.testing.assert_allclose(loaded_f0["midi"], sample_f0["midi"])

            # Test words cache
            sample_words = [{"word": "hello", "start": 1.0, "end": 1.5, "probability": 0.99}]
            cache.save_words(sample_words, lang="en")
            loaded = cache.load_words()
            self.assertIsNotNone(loaded)
            loaded_words, loaded_lang = loaded
            self.assertEqual(len(loaded_words), 1)
            self.assertEqual(loaded_words[0]["word"], "hello")
            self.assertEqual(loaded_lang, "en")


class TestPipelineRunWithProgress(unittest.TestCase):

    @patch("karaoke.pipeline.separate_stems")
    @patch("karaoke.pipeline.transcribe_lyrics")
    @patch("karaoke.pipeline.analyze_vocal_pitch")
    @patch("karaoke.pipeline.detect_song_key")
    @patch("karaoke.pipeline.detect_display_bpm")
    def test_pipeline_run_flow(
        self, mock_bpm, mock_key, mock_pitch, mock_lyrics, mock_sep
    ):
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir)
            fake_audio = out_dir / "artist - title.wav"
            fake_audio.write_bytes(b"dummy audio data")

            fake_vocals = out_dir / "vocals.wav"
            fake_vocals.write_bytes(b"dummy vocals")
            fake_inst = out_dir / "no_vocals.wav"
            fake_inst.write_bytes(b"dummy instrumental")

            mock_sep.return_value = (fake_vocals, fake_inst)
            mock_bpm.return_value = 125
            mock_lyrics.return_value = (
                [{"word": "sing", "start": 1.0, "end": 1.8, "probability": 0.98}],
                "en"
            )
            mock_key.return_value = {"key": "C Major", "root": 0, "mode": "major", "scale_pcs": {0, 2, 4, 5, 7, 9, 11}}
            mock_pitch.return_value = {
                "type": "contour",
                "frame_dur_sec": 0.010,
                "midi": np.ones(200) * 60.0,
                "conf": np.ones(200) * 0.9,
                "rms": np.ones(200) * 0.5,
                "total_frames": 200,
                "sr": 16000
            }

            progress_events = []
            def on_progress(stage, frac, msg):
                progress_events.append((stage, frac, msg))

            job = KaraokeJob(
                input_audio=fake_audio,
                artist="Artist",
                title="Title",
                output_dir=out_dir,
                use_cache=False,
            )

            result = run(job, progress_cb=on_progress)
            self.assertEqual(result["status"], "done")
            self.assertTrue(Path(result["output_txt"]).exists())
            self.assertTrue(Path(result["meta_json"]).exists())

            # Verify meta.json content
            with open(result["meta_json"], "r", encoding="utf-8") as f:
                meta = json.load(f)
            self.assertEqual(meta["artist"], "Artist")
            self.assertEqual(meta["title"], "Title")
            self.assertIn("hardware", meta)
            self.assertIn("models_used", meta)

            # Verify progress events monotonic
            self.assertGreater(len(progress_events), 0)
            stages = [e[0] for e in progress_events]
            self.assertIn("init", stages)
            self.assertIn("chart", stages)
            self.assertIn("done", stages)
            self.assertEqual(progress_events[-1][1], 1.0)


if __name__ == "__main__":
    unittest.main()
