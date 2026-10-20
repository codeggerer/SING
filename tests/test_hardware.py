"""
Unit tests for Hardware Detection & Model Selection (Phase 3).
"""

import unittest
import os
from unittest.mock import patch

from karaoke.hardware import (
    HardwareProfile, ModelSelection, detect_hardware, select_models
)
from karaoke.config import QUALITY_FAST, QUALITY_BALANCED, QUALITY_BEST


class TestHardwareDetection(unittest.TestCase):

    def test_detect_hardware_default(self):
        hw = detect_hardware()
        self.assertIn(hw.backend, ["mps", "cuda", "cpu"])
        self.assertGreater(hw.vram_or_ram_gb, 0.0)
        self.assertGreater(hw.cpu_cores, 0)
        d = hw.to_dict()
        self.assertEqual(d["backend"], hw.backend)
        self.assertEqual(d["device"], hw.device)

    def test_override_cpu(self):
        hw = detect_hardware(override_device="cpu")
        self.assertEqual(hw.backend, "cpu")
        self.assertEqual(hw.device, "cpu")
        self.assertIn("Manual override", hw.notes)

    def test_env_var_override(self):
        with patch.dict(os.environ, {"KARAOKE_DEVICE": "cpu"}):
            hw = detect_hardware()
            self.assertEqual(hw.backend, "cpu")
            self.assertEqual(hw.device, "cpu")


class TestModelSelection(unittest.TestCase):

    def test_mps_profile_16gb_balanced(self):
        hw = HardwareProfile(backend="mps", device="mps", vram_or_ram_gb=16.0, cpu_cores=8)
        models = select_models(hw, quality=QUALITY_BALANCED)
        self.assertEqual(models.whisper_model, "large-v3-turbo")
        self.assertEqual(models.separator_device, "mps")
        self.assertEqual(models.pitch_device, "mps")

    def test_mps_profile_16gb_best(self):
        hw = HardwareProfile(backend="mps", device="mps", vram_or_ram_gb=16.0, cpu_cores=8)
        models = select_models(hw, quality=QUALITY_BEST)
        self.assertEqual(models.whisper_model, "large-v3")
        self.assertEqual(models.crepe_model, "full")

    def test_mps_profile_16gb_fast(self):
        hw = HardwareProfile(backend="mps", device="mps", vram_or_ram_gb=16.0, cpu_cores=8)
        models = select_models(hw, quality=QUALITY_FAST)
        self.assertEqual(models.whisper_model, "small")
        self.assertEqual(models.crepe_model, "tiny")

    def test_mps_profile_low_ram(self):
        hw = HardwareProfile(backend="mps", device="mps", vram_or_ram_gb=8.0, cpu_cores=8)
        models = select_models(hw, quality=QUALITY_BALANCED)
        # Should drop tier from large-v3-turbo to medium
        self.assertEqual(models.whisper_model, "medium")

    def test_cuda_profile_large_vram(self):
        hw = HardwareProfile(backend="cuda", device="cuda:0", vram_or_ram_gb=16.0, cpu_cores=12)
        models = select_models(hw, quality=QUALITY_BALANCED)
        self.assertEqual(models.whisper_backend, "faster-whisper")
        self.assertEqual(models.whisper_compute, "fp16")
        self.assertEqual(models.whisper_device, "cuda")
        self.assertEqual(models.whisper_model, "large-v3")
        self.assertIsNone(models.separator_segment)

    def test_cuda_profile_low_vram(self):
        hw = HardwareProfile(backend="cuda", device="cuda:0", vram_or_ram_gb=6.0, cpu_cores=8)
        models = select_models(hw, quality=QUALITY_BALANCED)
        self.assertEqual(models.whisper_backend, "faster-whisper")
        self.assertEqual(models.whisper_compute, "int8_float16")
        self.assertEqual(models.whisper_device, "cuda")
        self.assertEqual(models.whisper_model, "large-v3-turbo")
        self.assertIsNotNone(models.separator_segment)

    def test_cpu_profile(self):
        hw = HardwareProfile(backend="cpu", device="cpu", vram_or_ram_gb=16.0, cpu_cores=4)
        models = select_models(hw, quality=QUALITY_BALANCED)
        self.assertEqual(models.whisper_backend, "faster-whisper")
        self.assertEqual(models.whisper_compute, "int8")
        self.assertEqual(models.whisper_device, "cpu")
        self.assertEqual(models.whisper_model, "small")
        self.assertEqual(models.crepe_model, "tiny")
        self.assertEqual(models.separator_segment, 7)

    def test_cpu_profile_best_quality(self):
        hw = HardwareProfile(backend="cpu", device="cpu", vram_or_ram_gb=16.0, cpu_cores=4)
        models = select_models(hw, quality=QUALITY_BEST)
        self.assertEqual(models.whisper_model, "medium")

    def test_cpu_profile_fast_quality(self):
        hw = HardwareProfile(backend="cpu", device="cpu", vram_or_ram_gb=8.0, cpu_cores=4)
        models = select_models(hw, quality=QUALITY_FAST)
        self.assertEqual(models.whisper_model, "tiny")
        self.assertEqual(models.crepe_model, "tiny")


if __name__ == "__main__":
    unittest.main()
