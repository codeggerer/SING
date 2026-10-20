"""
Unit tests for ultrastar_parser.py
"""

import unittest
from pathlib import Path
from eval.ultrastar_parser import (
    beat_to_seconds,
    seconds_to_beat,
    parse_ultrastar_txt,
    UltraStarChart,
    UltraStarNote,
)


class TestUltraStarParser(unittest.TestCase):

    def test_beat_to_seconds_standard_1500_bpm(self):
        """At BPM 1500 and GAP 0, 1 beat = 0.010 s (10 ms)."""
        bpm = 1500.0
        gap_ms = 0.0
        self.assertAlmostEqual(beat_to_seconds(0, bpm, gap_ms), 0.0)
        self.assertAlmostEqual(beat_to_seconds(100, bpm, gap_ms), 1.0)
        self.assertAlmostEqual(beat_to_seconds(709, bpm, gap_ms), 7.09)

    def test_seconds_to_beat_inversion(self):
        """seconds_to_beat must invert beat_to_seconds."""
        bpm = 242.0
        gap_ms = 12500.0
        for b in [0, 10, 55, 120.5, 999]:
            sec = beat_to_seconds(b, bpm, gap_ms)
            b_inv = seconds_to_beat(sec, bpm, gap_ms)
            self.assertAlmostEqual(b, b_inv, places=5)

    def test_comma_decimal_parsing(self):
        """BPM and GAP with European comma decimal notation must parse correctly."""
        txt = (
            "#TITLE:Test Song\n"
            "#ARTIST:Test Artist\n"
            "#BPM:210,56\n"
            "#GAP:46728,26\n"
            ": 16 38 8 I \n"
            "* 54 10 10 Yeah \n"
            "- 70\n"
            "F 75 15 0 Freestyle\n"
            "E\n"
        )
        chart = parse_ultrastar_txt(txt)
        self.assertEqual(chart.title, "Test Song")
        self.assertEqual(chart.artist, "Test Artist")
        self.assertAlmostEqual(chart.bpm, 210.56)
        self.assertAlmostEqual(chart.gap_ms, 46728.26)
        self.assertEqual(len(chart.notes), 3)

        # Check first note
        n1 = chart.notes[0]
        self.assertEqual(n1.type, ":")
        self.assertEqual(n1.pitch, 8)
        self.assertEqual(n1.text, "I ")
        # 46.72826 + 16 * (15 / 210.56) = 46.72826 + 1.1398176 = 47.868077
        expected_start = 46.72826 + 16 * (15.0 / 210.56)
        self.assertAlmostEqual(n1.start_sec, expected_start, places=3)
        expected_end = 46.72826 + (16 + 38) * (15.0 / 210.56)
        self.assertAlmostEqual(n1.end_sec, expected_end, places=3)

        # Check line break
        self.assertEqual(chart.line_breaks, [70.0])

        # Check freestyle note
        n3 = chart.notes[2]
        self.assertEqual(n3.type, "F")
        self.assertEqual(n3.pitch, 0)
        self.assertEqual(n3.text, "Freestyle")

    def test_notes_dict_format(self):
        """notes_dict must return standard list of dicts with start_sec, end_sec, pitch, text, type."""
        txt = (
            "#BPM:1500\n"
            "#GAP:0\n"
            ": 0 100 60 Hello \n"
            ": 100 100 62 World\n"
            "E\n"
        )
        chart = parse_ultrastar_txt(txt)
        dict_list = chart.notes_dict
        self.assertEqual(len(dict_list), 2)
        self.assertEqual(dict_list[0], {
            "start_sec": 0.0,
            "end_sec": 1.0,
            "pitch": 60,
            "text": "Hello ",
            "type": ":",
        })
        self.assertEqual(dict_list[1], {
            "start_sec": 1.0,
            "end_sec": 2.0,
            "pitch": 62,
            "text": "World",
            "type": ":",
        })

    def test_duet_tracks(self):
        """Duet charts with P1 and P2 should be separable."""
        txt = (
            "#TITLE:Duet\n"
            "#BPM:1500\n"
            "#GAP:0\n"
            "P1\n"
            ": 0 50 60 Lead \n"
            "P2\n"
            ": 50 50 67 Second \n"
            "E\n"
        )
        chart_p1 = parse_ultrastar_txt(txt, track=0)
        self.assertEqual(len(chart_p1.notes), 1)
        self.assertEqual(chart_p1.notes[0].text, "Lead ")

        chart_p2 = parse_ultrastar_txt(txt, track=1)
        self.assertEqual(len(chart_p2.notes), 1)
        self.assertEqual(chart_p2.notes[0].text, "Second ")


if __name__ == "__main__":
    unittest.main()
