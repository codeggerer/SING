"""
tests/test_sync.py - Unit & Verification Tests for FFT Acoustic Cross-Correlation Engine.
MASTER_OVERHAUL_PLAN Phase 2.

Verification Criteria:
- Test on a video with a 12.5s studio intro: detected tau* must be 12.50 s +- 0.02 s (+- 20ms).
- First sung note lands with sub-20ms accuracy on the playhead.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from karaoke.sync import (
    SyncResult,
    align_audio_gap,
    compute_audio_lag,
    synthesize_chart_melody,
    update_ultrastar_gap,
)


class TestAcousticCrossCorrelation(unittest.TestCase):
    """Tests the FFT acoustic cross-correlation algorithms and verification criteria."""

    def setUp(self):
        self.sr = 16000
        self.dur = 25.0
        # Create reproducible synthetic multi-tone reference audio (Public-domain synthetic tones)
        t = np.linspace(0, self.dur, int(self.sr * self.dur), endpoint=False)
        # Chord progression: A4 (440Hz), C#5 (554.37Hz), E5 (659.25Hz) with rhythmic pulse
        harmonic = (
            np.sin(2.0 * np.pi * 440.0 * t)
            + 0.5 * np.sin(2.0 * np.pi * 554.37 * t)
            + 0.3 * np.sin(2.0 * np.pi * 659.25 * t)
        )
        pulse = (np.sin(2.0 * np.pi * 2.5 * t) > 0.0).astype(np.float32)
        self.ref_audio = (harmonic * pulse).astype(np.float32)

    def test_criterion_12_5s_studio_intro(self):
        """
        Verification Criterion:
        Test on a video with a 12.5s studio intro: detected tau* must be 12.50 s +- 0.02 s.
        """
        intro_sec = 12.50
        intro_samples = int(round(intro_sec * self.sr))

        # Intro contains different sound effect (e.g. 180Hz logo drone) + subtle noise
        t_intro = np.linspace(0, intro_sec, intro_samples, endpoint=False)
        intro_sound = 0.4 * np.sin(2.0 * np.pi * 180.0 * t_intro) + 0.02 * np.random.randn(intro_samples)

        # YouTube video audio is intro + reference track
        yt_audio = np.concatenate([intro_sound.astype(np.float32), self.ref_audio])

        # Test both chroma and hybrid methods
        for method in ["chroma", "hybrid"]:
            with self.subTest(method=method):
                lag_sec, conf, details = compute_audio_lag(
                    yt_audio=yt_audio,
                    ref_audio=self.ref_audio,
                    sr=self.sr,
                    method=method,
                )
                err_sec = abs(lag_sec - intro_sec)
                err_ms = err_sec * 1000.0

                self.assertLessEqual(
                    err_sec,
                    0.020,  # Must be within +- 20ms (0.02s)
                    f"Method {method} exceeded 20ms threshold: detected {lag_sec:.4f}s, expected {intro_sec:.4f}s (err: {err_ms:.2f}ms)",
                )
                self.assertGreaterEqual(conf, 0.70, f"Confidence too low: {conf}")

    def test_sub_20ms_accuracy_diverse_offsets(self):
        """
        Verification Criterion:
        First sung note lands with sub-20ms accuracy across various offsets (positive and negative).
        """
        test_offsets = [0.0, 3.42, 7.82, -2.50, 0.45]

        for target_offset in test_offsets:
            with self.subTest(offset=target_offset):
                shift_samples = int(round(target_offset * self.sr))
                if shift_samples >= 0:
                    yt_sig = np.concatenate([np.zeros(shift_samples, dtype=np.float32), self.ref_audio])
                else:
                    yt_sig = self.ref_audio[-shift_samples:]

                # Add noise
                yt_sig = yt_sig + 0.01 * np.random.randn(len(yt_sig)).astype(np.float32)

                lag_sec, conf, _ = compute_audio_lag(
                    yt_audio=yt_sig,
                    ref_audio=self.ref_audio,
                    sr=self.sr,
                    method="chroma",
                )
                err_ms = abs(lag_sec - target_offset) * 1000.0
                self.assertLessEqual(
                    err_ms,
                    20.0,
                    f"Offset {target_offset}s had error of {err_ms:.2f}ms (> 20ms threshold)",
                )

    def test_align_audio_gap_calculation(self):
        """Tests that aligned #GAP equals chartGapMs + (tau* * 1000)."""
        offset_sec = 4.25
        shift_samples = int(round(offset_sec * self.sr))
        yt_audio = np.concatenate([np.zeros(shift_samples, dtype=np.float32), self.ref_audio])

        original_gap_ms = 1200.0
        result: SyncResult = align_audio_gap(
            yt_audio=yt_audio,
            ref_audio=self.ref_audio,
            chart_gap_ms=original_gap_ms,
            sr=self.sr,
            method="chroma",
        )

        expected_aligned = original_gap_ms + (offset_sec * 1000.0)
        self.assertAlmostEqual(result.lag_sec, offset_sec, delta=0.02)
        self.assertAlmostEqual(result.aligned_gap_ms, expected_aligned, delta=20.0)
        self.assertEqual(result.original_gap_ms, original_gap_ms)

    def test_update_ultrastar_gap(self):
        """Tests updating and inserting the #GAP header in an UltraStar score chart."""
        chart_text = (
            "#TITLE:Aura Lea\n"
            "#ARTIST:Public Domain\n"
            "#BPM:1500\n"
            "#GAP:1000\n"
            ": 0 4 60 Au \n"
            ": 4 4 62 ra \n"
            "E\n"
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            chart_path = Path(tmp_dir) / "test_song.txt"
            chart_path.write_text(chart_text, encoding="utf-8")

            # Update in place with 12500 ms
            updated = update_ultrastar_gap(chart_path, 12500)
            self.assertIn("#GAP:12500", updated)
            self.assertNotIn("#GAP:1000", updated)
            self.assertIn("#TITLE:Aura Lea", updated)
            self.assertIn(": 0 4 60 Au \n", updated)

            # Test chart with missing #GAP header
            no_gap_text = "#TITLE:Song\n#BPM:1200\n: 0 4 60 La\nE\n"
            chart_path2 = Path(tmp_dir) / "no_gap.txt"
            chart_path2.write_text(no_gap_text, encoding="utf-8")

            updated2 = update_ultrastar_gap(chart_path2, 3420)
            self.assertIn("#GAP:3420", updated2)
            self.assertIn("#BPM:1200", updated2)

    def test_synthesize_chart_melody(self):
        """Tests synthesizing acoustic melody from UltraStar notes for score alignment."""
        chart_content = (
            "#TITLE:Test Melody\n"
            "#BPM:1500\n"
            "#GAP:500\n"
            ": 0 100 69 La \n"    # A4 (440Hz), beat 0-100 (1.0s)
            ": 120 100 71 Da \n"   # B4 (493.88Hz), beat 120-220 (1.0s)
            "E\n"
        )
        audio, gap_ms = synthesize_chart_melody(chart_content, sr=self.sr, duration_sec=10.0)

        self.assertEqual(gap_ms, 500.0)
        self.assertIsInstance(audio, np.ndarray)
        self.assertGreater(len(audio), self.sr * 2)
        self.assertGreater(np.max(np.abs(audio)), 0.1)

    def test_cli_wrapper_execution(self):
        """Tests scripts/align_audio_gap.py via subprocess with JSON output."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            ref_path = tmp / "ref.wav"
            yt_path = tmp / "yt.wav"
            chart_path = tmp / "chart.txt"

            import soundfile as sf
            sf.write(str(ref_path), self.ref_audio, self.sr)

            shift_sec = 5.0
            shift_samples = int(round(shift_sec * self.sr))
            yt_sig = np.concatenate([np.zeros(shift_samples, dtype=np.float32), self.ref_audio])
            sf.write(str(yt_path), yt_sig, self.sr)

            chart_text = "#TITLE:Test\n#BPM:1500\n#GAP:1000\n: 0 4 60 Test \nE\n"
            chart_path.write_text(chart_text, encoding="utf-8")

            # Run CLI wrapper
            cmd = [
                sys.executable,
                str(PROJECT_ROOT / "scripts" / "align_audio_gap.py"),
                str(yt_path),
                str(ref_path),
                "--chart", str(chart_path),
                "--update-chart",
                "--output-json",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(res.stdout)

            self.assertEqual(data["status"], "success")
            self.assertAlmostEqual(data["lag_sec"], shift_sec, delta=0.02)
            self.assertAlmostEqual(data["aligned_gap_ms"], 1000.0 + (shift_sec * 1000.0), delta=20.0)
            self.assertTrue(data["chart_updated"])

            # Verify chart on disk was updated
            updated_chart = chart_path.read_text(encoding="utf-8")
            self.assertIn(f"#GAP:{int(round(data['aligned_gap_ms']))}", updated_chart)


if __name__ == "__main__":
    unittest.main()
