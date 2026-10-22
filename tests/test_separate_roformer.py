"""
tests/test_separate_roformer.py - Validation tests for Breakthrough 3: Mel-Band RoFormer Separation.
Tests caching, device resolution, model discovery, successful separation output formatting,
and graceful fallback to Demucs v4.
"""

import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from karaoke.separate_roformer import (
    separate_mel_band_roformer,
    resolve_roformer_device,
    find_cached_roformer_model,
    get_default_model_dir,
    ROFORMER_VOCAL_MODELS,
)
from karaoke.separate import separate_stems


class TestMelBandRoFormer(unittest.TestCase):
    """Test suite for Mel-Band RoFormer stem separation engine."""

    def test_import_and_signature(self):
        """Verify separate_mel_band_roformer is exported and has required signature."""
        from karaoke import separate_mel_band_roformer as sep_func
        import inspect

        sig = inspect.signature(sep_func)
        self.assertIn("audio_path", sig.parameters)
        self.assertIn("output_dir", sig.parameters)
        self.assertIn("device", sig.parameters)
        self.assertIn("model_filename", sig.parameters)
        self.assertIn("stage_cache", sig.parameters)
        self.assertIn("progress_cb", sig.parameters)

    def test_device_resolution(self):
        """Test compute device resolution for Apple Silicon MPS, CUDA, and CPU."""
        self.assertEqual(resolve_roformer_device("cpu"), "cpu")

        with patch("torch.backends.mps.is_available", return_value=True):
            self.assertEqual(resolve_roformer_device("auto"), "mps")
            self.assertEqual(resolve_roformer_device("mps"), "mps")

        with patch("torch.backends.mps.is_available", return_value=False):
            with patch("torch.cuda.is_available", return_value=True):
                self.assertEqual(resolve_roformer_device("auto"), "cuda")
                self.assertEqual(resolve_roformer_device("cuda"), "cuda")

        with patch("torch.backends.mps.is_available", return_value=False):
            with patch("torch.cuda.is_available", return_value=False):
                self.assertEqual(resolve_roformer_device("auto"), "cpu")
                self.assertEqual(resolve_roformer_device("mps"), "cpu")

    def test_cached_stems_fast_path(self):
        """When canonical stem files exist, separation is bypassed immediately."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir)
            dummy_audio = out_dir / "mysong.wav"
            dummy_audio.write_bytes(b"dummy_audio")

            canonical_vocals = out_dir / "mysong_vocals.wav"
            canonical_inst = out_dir / "mysong_instrumental.wav"
            canonical_vocals.write_bytes(b"vocals_data")
            canonical_inst.write_bytes(b"inst_data")

            # Calling separate_mel_band_roformer should not instantiate Separator
            with patch("audio_separator.separator.Separator") as mock_sep:
                voc, inst = separate_mel_band_roformer(dummy_audio, output_dir=out_dir)
                mock_sep.assert_not_called()

            self.assertEqual(voc.resolve(), canonical_vocals.resolve())
            self.assertEqual(inst.resolve(), canonical_inst.resolve())
            # Check legacy filenames were created
            self.assertTrue((out_dir / "vocals.wav").exists())
            self.assertTrue((out_dir / "no_vocals.wav").exists())
            self.assertTrue((out_dir / "instrumental.wav").exists())

    def test_stage_cache_fast_path(self):
        """When stage cache has stems, it returns them immediately."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir)
            dummy_audio = out_dir / "cached_song.wav"
            dummy_audio.write_bytes(b"dummy")

            mock_cache = MagicMock()
            mock_cache.has_stems.return_value = True
            mock_cache.vocals_path = out_dir / "cache_vocals.wav"
            mock_cache.instrumental_path = out_dir / "cache_inst.wav"

            with patch("audio_separator.separator.Separator") as mock_sep:
                voc, inst = separate_mel_band_roformer(
                    dummy_audio,
                    output_dir=out_dir,
                    stage_cache=mock_cache,
                )
                mock_sep.assert_not_called()

            self.assertEqual(voc, mock_cache.vocals_path)
            self.assertEqual(inst, mock_cache.instrumental_path)

    def test_find_cached_roformer_model(self):
        """Verifies local cache scanning detects roformer weights."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache_dir = Path(tmp_dir)
            self.assertIsNone(find_cached_roformer_model(cache_dir))

            test_model = cache_dir / "model_mel_band_roformer_vocals.onnx"
            test_model.write_bytes(b"model_weights")

            detected = find_cached_roformer_model(cache_dir)
            self.assertEqual(detected, "model_mel_band_roformer_vocals.onnx")

    def test_successful_mock_separation(self):
        """Simulate successful RoFormer separation and verify canonical file handling."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir)
            dummy_audio = out_dir / "queen_bohemian.wav"
            dummy_audio.write_bytes(b"sample_wave_data")

            # Mock Separator
            mock_sep_instance = MagicMock()
            stem1 = "queen_bohemian_(Vocals)_mel_band_roformer.wav"
            stem2 = "queen_bohemian_(Instrumental)_mel_band_roformer.wav"

            # Create mock outputs inside out_dir
            (out_dir / stem1).write_bytes(b"vocal_tensor_bytes")
            (out_dir / stem2).write_bytes(b"inst_tensor_bytes")

            mock_sep_instance.separate.return_value = [stem1, stem2]

            with patch("audio_separator.separator.Separator", return_value=mock_sep_instance):
                progress_events = []
                def prog_cb(stage, frac, msg):
                    progress_events.append((stage, frac, msg))

                voc, inst = separate_mel_band_roformer(
                    dummy_audio,
                    output_dir=out_dir,
                    progress_cb=prog_cb,
                )

            # Verification
            self.assertEqual(voc.name, "queen_bohemian_vocals.wav")
            self.assertEqual(inst.name, "queen_bohemian_instrumental.wav")
            self.assertTrue(voc.exists())
            self.assertTrue(inst.exists())
            self.assertEqual(voc.read_bytes(), b"vocal_tensor_bytes")
            self.assertEqual(inst.read_bytes(), b"inst_tensor_bytes")

            # Legacy mirrors
            self.assertTrue((out_dir / "vocals.wav").exists())
            self.assertTrue((out_dir / "no_vocals.wav").exists())
            self.assertTrue((out_dir / "instrumental.wav").exists())

            # Progress check
            stages = [e[0] for e in progress_events]
            self.assertIn("separate", stages)
            fractions = [e[1] for e in progress_events]
            self.assertIn(1.0, fractions)

    def test_fallback_to_demucs_on_exception(self):
        """When RoFormer fails or weights cannot be downloaded, falls back to Demucs v4."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir)
            dummy_audio = out_dir / "fallback_song.wav"
            dummy_audio.write_bytes(b"audio")

            mock_demucs_vocals = out_dir / "demucs_vocals.wav"
            mock_demucs_inst = out_dir / "demucs_inst.wav"
            mock_demucs_vocals.write_bytes(b"demucs_v")
            mock_demucs_inst.write_bytes(b"demucs_i")

            # Cause Separator to throw an error (e.g. weights missing / network error)
            mock_sep_instance = MagicMock()
            mock_sep_instance.load_model.side_effect = RuntimeError("Network 403 / No internet in sandbox")

            with patch("audio_separator.separator.Separator", return_value=mock_sep_instance):
                with patch("karaoke.separate.separate_stems") as mock_separate_stems:
                    mock_separate_stems.return_value = (mock_demucs_vocals, mock_demucs_inst)

                    voc, inst = separate_mel_band_roformer(dummy_audio, output_dir=out_dir)

                    mock_separate_stems.assert_called_once()
                    _, kwargs = mock_separate_stems.call_args
                    self.assertEqual(kwargs.get("separator"), "demucs")

            self.assertEqual(voc, mock_demucs_vocals)
            self.assertEqual(inst, mock_demucs_inst)

    def test_separate_stems_integration_with_roformer(self):
        """Verify calling separate_stems(separator='roformer') routes through separate_mel_band_roformer."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir)
            dummy_audio = out_dir / "song.wav"
            dummy_audio.write_bytes(b"audio")

            mock_voc = out_dir / "song_vocals.wav"
            mock_inst = out_dir / "song_instrumental.wav"
            mock_voc.write_bytes(b"v")
            mock_inst.write_bytes(b"i")

            with patch("karaoke.separate_roformer.separate_mel_band_roformer", return_value=(mock_voc, mock_inst)) as mock_roformer:
                v, i = separate_stems(dummy_audio, output_dir=out_dir, separator="roformer")
                mock_roformer.assert_called_once()
                self.assertEqual(v, mock_voc)
                self.assertEqual(i, mock_inst)


if __name__ == "__main__":
    unittest.main()
