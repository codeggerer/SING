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


if __name__ == "__main__":
    unittest.main()
