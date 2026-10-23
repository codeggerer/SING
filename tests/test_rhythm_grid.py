"""
tests/test_rhythm_grid.py - Unit Test Suite for Issue #4:
Musical Meter & Beat Grid Quantization (BPM Tracking & Grid Snapping)
"""

import math
import tempfile
import unittest
from pathlib import Path
import numpy as np

from karaoke.rhythm import (
    RhythmGrid,
    track_song_rhythm,
    snap_onset_to_grid,
    snap_notes_to_beat_grid,
)
from karaoke.chart import (
    detect_song_rhythm,
    detect_display_bpm,
    generate_ultrastar_chart,
)
from eval.ultrastar_parser import parse_ultrastar_txt


class TestRhythmGridTracking(unittest.TestCase):
    """Tests for RhythmGrid dataclass and librosa beat tracking."""

    def test_rhythm_grid_properties(self):
        # 120 BPM: quarter note = 0.5s, 8th = 0.25s, 16th = 0.125s
        grid = RhythmGrid(
            bpm=120.0,
            beat_interval_sec=0.5,
            phase_sec=0.05,
            gap_ms=50.0,
            confidence=0.95,
        )
        self.assertAlmostEqual(grid.quarter_step_sec, 0.5)
        self.assertAlmostEqual(grid.eighth_step_sec, 0.25)
        self.assertAlmostEqual(grid.sixteenth_step_sec, 0.125)

        d = grid.to_dict()
        self.assertEqual(d["bpm"], 120.0)
        self.assertEqual(d["gap_ms"], 50.0)
        self.assertEqual(d["confidence"], 0.95)

    def test_get_nearest_grid(self):
        # 120 BPM, phase = 0.0s. 1/16 notes at 0.0, 0.125, 0.250, 0.375, 0.500, etc.
        grid = RhythmGrid(
            bpm=120.0,
            beat_interval_sec=0.5,
            phase_sec=0.0,
            gap_ms=0.0,
            confidence=1.0,
        )

        # 0.135s is 10 ms from 0.125s (1/16th line)
        nearest, diff, subdiv = grid.get_nearest_grid(0.135, subdivisions=("1/16",))
        self.assertAlmostEqual(nearest, 0.125, places=3)
        self.assertAlmostEqual(diff, 0.010, places=3)

        # 0.490s is 10 ms from 0.500s (quarter note line)
        nearest, diff, subdiv = grid.get_nearest_grid(0.490, subdivisions=("1/16",))
        self.assertAlmostEqual(nearest, 0.500, places=3)
        self.assertAlmostEqual(diff, 0.010, places=3)

    def test_synthetic_audio_beat_tracking(self):
        # Generate 4 seconds of synthetic clicks at 120 BPM (2 clicks per second, interval = 0.5s)
        sr = 22050
        duration = 4.0
        audio = np.zeros(int(sr * duration), dtype=np.float32)

        # Clicks at 0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75
        click_times = np.arange(0.25, duration, 0.5)
        for t in click_times:
            idx = int(t * sr)
            click_len = min(400, len(audio) - idx)
            # 1 kHz burst
            audio[idx : idx + click_len] = np.sin(2 * np.pi * 1000 * np.arange(click_len) / sr)

        grid = track_song_rhythm(audio, sr=sr)
        self.assertGreater(grid.bpm, 60.0)
        self.assertLess(grid.bpm, 200.0)
        # Should be near 120 BPM
        self.assertTrue(abs(grid.bpm - 120.0) < 10.0 or abs(grid.bpm - 60.0) < 5.0)
        self.assertGreater(grid.confidence, 0.3)


class TestSoftBeatGridSnapping(unittest.TestCase):
    """Tests for soft beat grid quantization and off-grid rubato preservation."""

    def setUp(self):
        # 120 BPM grid: phase = 0.0s, 1/16 note step = 125 ms
        self.grid = RhythmGrid(
            bpm=120.0,
            beat_interval_sec=0.5,
            phase_sec=0.0,
            gap_ms=0.0,
            confidence=1.0,
        )

    def test_snap_onset_within_tolerance(self):
        # 0.140s is 15 ms from 0.125s (tolerance = 30 ms) -> snaps to 0.125s
        snapped, did_snap = snap_onset_to_grid(0.140, self.grid, tolerance_sec=0.030)
        self.assertTrue(did_snap)
        self.assertAlmostEqual(snapped, 0.125, places=3)

        # 0.985s is 15 ms from 1.000s -> snaps to 1.000s
        snapped, did_snap = snap_onset_to_grid(0.985, self.grid, tolerance_sec=0.030)
        self.assertTrue(did_snap)
        self.assertAlmostEqual(snapped, 1.000, places=3)

    def test_preserve_off_grid_rubato_and_syncopation(self):
        # 0.180s is 55 ms from 0.125s and 70 ms from 0.250s (dist > 30 ms) -> PRESERVED!
        snapped, did_snap = snap_onset_to_grid(0.180, self.grid, tolerance_sec=0.030)
        self.assertFalse(did_snap)
        self.assertAlmostEqual(snapped, 0.180, places=3)

        # Triplet at 166.7 ms (dist to 125ms is 41.7ms > 30ms) -> PRESERVED!
        snapped, did_snap = snap_onset_to_grid(0.1667, self.grid, tolerance_sec=0.030)
        self.assertFalse(did_snap)
        self.assertAlmostEqual(snapped, 0.1667, places=4)

    def test_snap_notes_to_beat_grid_in_place(self):
        word_notes_list = [
            {
                "pause_beat": None,
                "notes": [
                    # Near 0.250s (8th note) by 15 ms -> should snap to 0.250s
                    {"start": 0.265, "note_start": 0.265, "end": 0.485, "pitch": 60, "text": "Hel-"},
                    # Near 0.500s (quarter note) by 10 ms -> should snap to 0.500s
                    {"start": 0.510, "note_start": 0.510, "end": 0.740, "pitch": 62, "text": "lo "},
                ],
                "num_sylls": 2,
            }
        ]

        snap_notes_to_beat_grid(word_notes_list, self.grid, tolerance_sec=0.030)

        n1 = word_notes_list[0]["notes"][0]
        n2 = word_notes_list[0]["notes"][1]

        self.assertAlmostEqual(n1["note_start"], 0.250, places=3)
        self.assertAlmostEqual(n1["end"], 0.500, places=3)
        self.assertAlmostEqual(n2["note_start"], 0.510, places=3)  # Overlap resolution or snapped
        self.assertAlmostEqual(n2["end"], 0.750, places=3)
        self.assertTrue(n1["grid_snapped"])


class TestChartHeaderFormatting(unittest.TestCase):
    """Tests for chart generation with millisecond fallback and native BPM modes."""

    def setUp(self):
        self.words = [
            {"word": "Sing", "start": 1.015, "end": 1.485},
            {"word": "Star", "start": 1.510, "end": 1.990},
        ]
        self.pitch_data = {
            "time": np.linspace(0, 3, 300),
            "midi": np.full(300, 60.0),
            "conf": np.full(300, 0.9),
            "rms": np.full(300, 0.5),
        }
        self.grid = RhythmGrid(
            bpm=120.0,
            beat_interval_sec=0.5,
            phase_sec=0.0,
            gap_ms=0.0,
            confidence=1.0,
        )

    def test_millisecond_bpm_mode_output(self):
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tf:
            out_path = Path(tf.name)

        try:
            generate_ultrastar_chart(
                self.words,
                self.pitch_data,
                display_bpm=120,
                title="Test Song",
                artist="Test Artist",
                output_txt_path=out_path,
                rhythm_grid=self.grid,
                bpm_mode="millisecond",
                snap_grid=True,
            )

            chart_text = out_path.read_text(encoding="utf-8")
            self.assertIn("#BPM:1500", chart_text)
            self.assertIn("#REALBPM:120", chart_text)
            self.assertIn("#GAP:0", chart_text)

            # 1.015s snapped to 1.000s -> beat 100 at 1500 BPM
            self.assertIn(": 100 ", chart_text)

            # Test parser compatibility
            chart = parse_ultrastar_txt(out_path)
            self.assertEqual(chart.bpm, 1500)
            self.assertEqual(len(chart.notes), 2)
            self.assertAlmostEqual(chart.notes[0].start_sec, 1.0, places=2)
        finally:
            out_path.unlink(missing_ok=True)

    def test_native_bpm_mode_output(self):
        grid_with_gap = RhythmGrid(
            bpm=120.0,
            beat_interval_sec=0.5,
            phase_sec=0.05,
            gap_ms=50.0,
            confidence=1.0,
        )

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tf:
            out_path = Path(tf.name)

        try:
            generate_ultrastar_chart(
                self.words,
                self.pitch_data,
                display_bpm=120,
                title="Native Song",
                artist="Native Artist",
                output_txt_path=out_path,
                rhythm_grid=grid_with_gap,
                bpm_mode="native",
                snap_grid=True,
            )

            chart_text = out_path.read_text(encoding="utf-8")
            self.assertIn("#BPM:120", chart_text)
            self.assertIn("#REALBPM:120", chart_text)
            self.assertIn("#GAP:50", chart_text)

            # Test parser compatibility
            chart = parse_ultrastar_txt(out_path)
            self.assertEqual(chart.bpm, 120)
            self.assertEqual(chart.gap_ms, 50.0)
            self.assertEqual(len(chart.notes), 2)
            # Reconstructed time should match within musical subdivision
            self.assertAlmostEqual(chart.notes[0].start_sec, 1.0, delta=0.08)
        finally:
            out_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
