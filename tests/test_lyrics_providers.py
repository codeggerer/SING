"""
Unit tests for Python lyrics_providers package (PLAN.md Phase 2)
"""

import json
import unittest
from pathlib import Path

from lyrics_providers.models import LyricsDoc, Line, Syllable
from lyrics_providers.align_check import compute_cer, normalize_text

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = PROJECT_ROOT / "tests" / "fixtures"


class TestLyricsProviders(unittest.TestCase):
    def test_canonical_model_serialization(self):
        doc = LyricsDoc(
            source="spicylyrics",
            syncType="syllable",
            language="de",
            lines=[
                Line(
                    start=10.0,
                    end=12.5,
                    agent="lead",
                    words="Hal-lo Welt",
                    syllables=[
                        Syllable(text="Hal-", start=10.0, end=11.0, joinNext=True),
                        Syllable(text="lo", start=11.0, end=11.5, joinNext=False),
                        Syllable(text="Welt", start=11.6, end=12.5, joinNext=False),
                    ],
                )
            ],
            lyricsOffsetSec=0.25,
        )

        d = doc.to_dict()
        self.assertEqual(d["source"], "spicylyrics")
        self.assertEqual(d["syncType"], "syllable")
        self.assertEqual(len(d["lines"]), 1)
        self.assertEqual(len(d["lines"][0]["syllables"]), 3)

        # Roundtrip
        doc2 = LyricsDoc.from_dict(d)
        self.assertEqual(doc2.source, doc.source)
        self.assertEqual(doc2.lyricsOffsetSec, 0.25)
        self.assertEqual(doc2.lines[0].syllables[0].text, "Hal-")
        self.assertTrue(doc2.lines[0].syllables[0].joinNext)

    def test_to_words_list_syllable_sync(self):
        doc = LyricsDoc(
            source="spicylyrics",
            syncType="syllable",
            language="de",
            lines=[
                Line(
                    start=1.0,
                    end=3.0,
                    agent="lead",
                    words="Sin-gen macht Spaß",
                    syllables=[
                        Syllable(text="Sin-", start=1.0, end=1.5, joinNext=True),
                        Syllable(text="gen", start=1.5, end=2.0, joinNext=False),
                        Syllable(text="macht", start=2.0, end=2.5, joinNext=False),
                        Syllable(text="Spaß", start=2.5, end=3.0, joinNext=False),
                    ],
                )
            ],
            lyricsOffsetSec=-0.1,
        )

        words = doc.to_words_list()
        self.assertEqual(len(words), 4)
        # Note: joinNext=True maintains hyphen without space
        self.assertEqual(words[0]["word"], "Sin-")
        self.assertAlmostEqual(words[0]["start"], 0.9, places=3)
        self.assertAlmostEqual(words[0]["end"], 1.4, places=3)
        # joinNext=False has trailing space
        self.assertEqual(words[1]["word"], "gen ")
        self.assertTrue(words[0]["is_syllable"])

    def test_to_words_list_line_sync(self):
        doc = LyricsDoc(
            source="lrclib",
            syncType="line",
            language="en",
            lines=[
                Line(start=5.0, end=7.0, words="Is this the real life"),
            ],
            lyricsOffsetSec=0.0,
        )
        words = doc.to_words_list()
        self.assertEqual(len(words), 5)
        self.assertEqual(words[0]["word"], "Is ")
        self.assertAlmostEqual(words[0]["start"], 5.0, places=2)
        self.assertAlmostEqual(words[4]["end"], 7.0, places=2)

    def test_compute_cer(self):
        # Identical
        self.assertEqual(compute_cer("Hello world", "hello world"), 0.0)
        # Small typo: 1 edit out of 10 chars = 0.1
        cer = compute_cer("abcdefghij", "abcdefghik")
        self.assertAlmostEqual(cer, 0.1, places=3)
        # Completely different
        cer_diff = compute_cer("Apple", "Zebra")
        self.assertGreater(cer_diff, 0.6)

    def test_verify_lyrics_trusted_syllable_bypass(self):
        from lyrics_providers.align_check import verify_lyrics_against_audio
        # Syllable-synced spicylyrics doc should be trusted without running Whisper
        doc_spicy = LyricsDoc(
            source="spicylyrics",
            syncType="syllable",
            language="en",
            lines=[Line(start=1.0, end=3.0, words="Don't stop me now")],
        )
        # Pass non-existent path to verify it does not touch the filesystem or Whisper
        is_valid, reason = verify_lyrics_against_audio(Path("/nonexistent/vocals.wav"), doc_spicy)
        self.assertTrue(is_valid)
        self.assertIn("Trusted provider", reason)

        # Syllable-synced spotify doc should also be trusted
        doc_spotify = LyricsDoc(
            source="spotify",
            syncType="syllable",
            language="en",
            lines=[Line(start=1.0, end=3.0, words="Tonight I'm gonna have myself a real good time")],
        )
        is_valid, reason = verify_lyrics_against_audio(Path("/nonexistent/vocals.wav"), doc_spotify)
        self.assertTrue(is_valid)
        self.assertIn("Trusted provider", reason)

        # Syllable-synced apple music doc should also be trusted
        doc_apple = LyricsDoc(
            source="apple",
            syncType="syllable",
            language="en",
            lines=[Line(start=1.0, end=3.0, words="Hello world")],
        )
        is_valid, reason = verify_lyrics_against_audio(Path("/nonexistent/vocals.wav"), doc_apple)
        self.assertTrue(is_valid)
        self.assertIn("Trusted provider", reason)

    def test_phase3_canonical_schema_dual_compatibility(self):
        # Accepts data dict with startTime, endTime, text, artist, title
        canonical_dict = {
            "artist": "Queen",
            "title": "Bohemian Rhapsody",
            "source": "apple",
            "syncType": "syllable",
            "language": "en",
            "lines": [
                {
                    "startTime": 12.34,
                    "endTime": 16.8,
                    "text": "Hello world",
                    "syllables": [
                        {"text": "Hel-", "startTime": 12.34, "endTime": 12.8, "joinNext": True},
                        {"text": "lo ", "startTime": 12.8, "endTime": 13.5, "joinNext": False},
                        {"text": "world", "startTime": 13.6, "endTime": 14.4, "joinNext": False},
                    ],
                }
            ],
            "lyricsOffsetSec": 0.0,
        }
        doc = LyricsDoc.from_dict(canonical_dict)
        self.assertEqual(doc.artist, "Queen")
        self.assertEqual(doc.title, "Bohemian Rhapsody")
        self.assertEqual(len(doc.lines), 1)

        line = doc.lines[0]
        self.assertAlmostEqual(line.start, 12.34)
        self.assertAlmostEqual(line.startTime, 12.34)
        self.assertAlmostEqual(line.end, 16.8)
        self.assertAlmostEqual(line.endTime, 16.8)
        self.assertEqual(line.words, "Hello world")
        self.assertEqual(line.text, "Hello world")

        syll = line.syllables[0]
        self.assertEqual(syll.text, "Hel-")
        self.assertAlmostEqual(syll.start, 12.34)
        self.assertAlmostEqual(syll.startTime, 12.34)
        self.assertAlmostEqual(syll.end, 12.8)
        self.assertAlmostEqual(syll.endTime, 12.8)
        self.assertTrue(syll.joinNext)

        # Serialization outputs both styles
        out_dict = doc.to_dict()
        self.assertEqual(out_dict["artist"], "Queen")
        self.assertEqual(out_dict["lines"][0]["startTime"], 12.34)
        self.assertEqual(out_dict["lines"][0]["text"], "Hello world")
        self.assertEqual(out_dict["lines"][0]["syllables"][0]["startTime"], 12.34)

    def test_peak_prominence_calculation_and_offset_threshold(self):
        import numpy as np
        from lyrics_providers.align_check import _calculate_peak_prominence

        # Sharp isolated peak has high prominence (~1.0)
        sharp_signal = np.array([0.0, 0.1, 0.9, 0.1, 0.0])
        prom_sharp = _calculate_peak_prominence(sharp_signal, 2)
        self.assertGreaterEqual(prom_sharp, 0.8)

        # Ambiguous peak surrounded by high sidelobes has low prominence (< 0.50)
        ambiguous_signal = np.array([0.1, 0.82, 0.70, 0.85, 0.68, 0.80, 0.1])
        prom_ambig = _calculate_peak_prominence(ambiguous_signal, 3)
        self.assertLess(prom_ambig, 0.50)


if __name__ == "__main__":
    unittest.main()
