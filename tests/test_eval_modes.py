#!/usr/bin/env python3
"""
Unit tests for eval/eval.py Multi-Mode Evaluation and Chart Cache Invalidation (Phase 6).
"""

import os
import sys
import json
import time
import shutil
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from eval.eval import (
    get_source_code_mtime,
    is_chart_cache_valid,
)


class TestEvalMultiModeAndCache(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_eval_cache_"))
        self.txt_path = self.temp_dir / "audio_canonical.txt"
        self.meta_path = self.temp_dir / "audio_canonical.meta.json"

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_get_source_code_mtime_detects_sources(self):
        mtime = get_source_code_mtime()
        self.assertIsInstance(mtime, float)
        self.assertGreater(mtime, 1700000000.0)

    def test_is_chart_cache_valid_matching(self):
        source_mtime = 1000.0
        # Create valid chart and meta
        self.txt_path.write_text("#TITLE:Test\n: 0 10 60 test\nE\n", encoding="utf-8")
        os.utime(self.txt_path, (1500.0, 1500.0))

        meta_data = {
            "mode": "canonical",
            "pitch_engine": "fcpe",
            "separator": "demucs",
            "use_basic_pitch": False,
            "source_mtime": 1200.0,
            "generated_at": "2026-10-21T00:00:00",
        }
        with open(self.meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_data, f)

        valid = is_chart_cache_valid(
            self.txt_path,
            self.meta_path,
            mode="canonical",
            pitch_engine="fcpe",
            separator="demucs",
            use_basic_pitch=False,
            source_mtime=source_mtime,
        )
        self.assertTrue(valid)

    def test_is_chart_cache_invalid_when_source_modified_after_chart(self):
        # Chart generated at t=1000, source touched at t=1200
        source_mtime = 1200.0
        self.txt_path.write_text("#TITLE:Test\nE\n", encoding="utf-8")
        os.utime(self.txt_path, (1000.0, 1000.0))

        meta_data = {
            "mode": "canonical",
            "pitch_engine": "fcpe",
            "separator": "demucs",
            "use_basic_pitch": False,
            "source_mtime": 900.0,
        }
        with open(self.meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_data, f)

        valid = is_chart_cache_valid(
            self.txt_path,
            self.meta_path,
            mode="canonical",
            pitch_engine="fcpe",
            separator="demucs",
            use_basic_pitch=False,
            source_mtime=source_mtime,
        )
        self.assertFalse(valid)

    def test_is_chart_cache_invalid_on_mode_mismatch(self):
        source_mtime = 1000.0
        self.txt_path.write_text("#TITLE:Test\nE\n", encoding="utf-8")
        os.utime(self.txt_path, (1500.0, 1500.0))

        # Cached as 'canonical'
        meta_data = {
            "mode": "canonical",
            "pitch_engine": "fcpe",
            "separator": "demucs",
            "use_basic_pitch": False,
            "source_mtime": 1200.0,
        }
        with open(self.meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_data, f)

        # Evaluated as 'whisper'
        valid = is_chart_cache_valid(
            self.txt_path,
            self.meta_path,
            mode="whisper",
            pitch_engine="fcpe",
            separator="demucs",
            use_basic_pitch=False,
            source_mtime=source_mtime,
        )
        self.assertFalse(valid)

    def test_is_chart_cache_invalid_on_engine_mismatch(self):
        source_mtime = 1000.0
        self.txt_path.write_text("#TITLE:Test\nE\n", encoding="utf-8")
        os.utime(self.txt_path, (1500.0, 1500.0))

        meta_data = {
            "mode": "canonical",
            "pitch_engine": "fcpe",
            "separator": "demucs",
            "use_basic_pitch": False,
            "source_mtime": 1200.0,
        }
        with open(self.meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_data, f)

        # Evaluated with pyin
        valid = is_chart_cache_valid(
            self.txt_path,
            self.meta_path,
            mode="canonical",
            pitch_engine="pyin",
            separator="demucs",
            use_basic_pitch=False,
            source_mtime=source_mtime,
        )
        self.assertFalse(valid)

    def test_is_chart_cache_invalid_when_missing_files(self):
        # Missing txt file
        valid = is_chart_cache_valid(
            self.temp_dir / "nonexistent.txt",
            self.meta_path,
            mode="canonical",
            pitch_engine="fcpe",
            separator="demucs",
            use_basic_pitch=False,
            source_mtime=1000.0,
        )
        self.assertFalse(valid)

        # Missing meta file
        self.txt_path.write_text("#TITLE:Test\nE\n", encoding="utf-8")
        valid = is_chart_cache_valid(
            self.txt_path,
            self.temp_dir / "nonexistent.meta.json",
            mode="canonical",
            pitch_engine="fcpe",
            separator="demucs",
            use_basic_pitch=False,
            source_mtime=1000.0,
        )
        self.assertFalse(valid)


if __name__ == "__main__":
    unittest.main()
