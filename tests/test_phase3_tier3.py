"""
tests/test_phase3_tier3.py - Comprehensive Unit Tests for Phase 3 (Tier 3 Web Lyrics & Meta MMS-FA Robustness)

Validates:
1. Phase 3.1: VAD-Island Chunked Forced Alignment (Zero Drift over Solos)
   - Continuous vocal activity identification separated by pauses > 1.2s.
   - Independent CTC Trellis alignment per vocal island.
   - Mathematical guarantee: 0% word leakage into instrumental solos.
2. Phase 3.2: Colloquial Slang Normalization Pre-Pass (German & English)
   - GERMAN_SLANG_MAP ("fahr'n", "is", "nich", "hab's", "nem", "ner", "gehts", "draussen")
   - ENGLISH_SLANG_MAP ("gonna", "wanna", "gotta", "lemme", "gimme", "tryna")
   - Original display word preservation for UltraStar highway rendering.
3. High-level plain-text alignment orchestration with VAD islands.
"""

import unittest
import numpy as np
import tempfile
import soundfile as sf
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from karaoke.align_mms import (
    VocalIsland,
    detect_vocal_islands,
    merge_closest_islands,
    segment_lyrics_into_stanzas,
    forced_align_words,
    forced_align_words_vad_islands,
    align_plain_lyrics_mms,
    clean_word_for_mms,
    GERMAN_SLANG_MAP,
    ENGLISH_SLANG_MAP,
)


class TestPhase3Tier3Robustness(unittest.TestCase):

    def test_german_slang_normalization_exhaustive(self):
        """Verifies Phase 3.2 GERMAN_SLANG_MAP normalizes contractions for CTC character tokens."""
        expected_mappings = {
            "fahr'n": "fahren",
            "fahrn": "fahren",
            "is": "ist",
            "nich": "nicht",
            "habs": "habees",
            "hab's": "habees",
            "nem": "einem",
            "ner": "einer",
            "gehts": "gehtes",
            "geht's": "gehtes",
            "draussen": "draussen",
            "gibt's": "gibtes",
            "gibts": "gibtes",
            "kann's": "kannes",
            "kanns": "kannes",
            "wenn's": "wennes",
            "wenns": "wennes",
            "war's": "wares",
            "wars": "wares",
            "wie's": "wiees",
            "wies": "wiees",
            "nix": "nichts",
            "nen": "einen",
            "'nen": "einen",
            "ne": "eine",
            "'ne": "eine",
        }

        for slang, expected in expected_mappings.items():
            clean = clean_word_for_mms(slang, lang="de")
            self.assertEqual(clean, expected, f"Slang '{slang}' must normalize to '{expected}', got '{clean}'")

    def test_english_slang_normalization(self):
        """Verifies Phase 3.2 ENGLISH_SLANG_MAP normalizes colloquial contractions."""
        expected_mappings = {
            "gonna": "goingto",
            "wanna": "wantto",
            "gotta": "gotto",
            "lemme": "letme",
            "gimme": "giveme",
            "kinda": "kindof",
            "sorta": "sortof",
            "outta": "outof",
            "tryna": "tryingto",
            "imma": "iamgoingto",
            "i'mma": "iamgoingto",
            "cause": "because",
            "'cause": "because",
            "cuz": "because",
            "'cuz": "because",
            "ain't": "isnot",
            "aint": "isnot",
        }

        for slang, expected in expected_mappings.items():
            clean = clean_word_for_mms(slang, lang="en")
            self.assertEqual(clean, expected, f"Slang '{slang}' must normalize to '{expected}', got '{clean}'")

    def test_display_text_preserved_with_slang(self):
        """Verifies the highway display text preserves the user's slang while CTC receives clean tokens."""
        sr = 16000
        dur_sec = 2.0
        t = np.linspace(0, dur_sec, int(dur_sec * sr), endpoint=False, dtype=np.float32)
        audio = 0.5 * np.sin(2 * np.pi * 300 * t)

        lyrics = ["Heute fahr'n wir los weil es nich dunkel is"]
        words = forced_align_words(audio, lyrics, lang="de")

        # Find "fahr'n" and "is"
        fahr_word = next((w for w in words if "fahr" in w["word"].lower()), None)
        is_word = next((w for w in words if w["word"].lower() == "is"), None)

        self.assertIsNotNone(fahr_word)
        self.assertEqual(fahr_word["word"], "fahr'n", "Original slang display text must be preserved")
        clean_fahr_chars = "".join([c for c, _, _ in fahr_word["char_spans"]])
        self.assertEqual(clean_fahr_chars, "fahren", "MMS token representation must be normalized 'fahren'")

        self.assertIsNotNone(is_word)
        self.assertEqual(is_word["word"], "is", "Original slang 'is' must be preserved")
        clean_is_chars = "".join([c for c, _, _ in is_word["char_spans"]])
        self.assertEqual(clean_is_chars, "ist", "MMS token representation must be normalized 'ist'")

    def test_vad_island_detection_single_island(self):
        """Verifies short audio or audio with no pauses > 1.2s returns 1 island spanning full duration."""
        sr = 16000
        audio = np.ones(int(2.5 * sr), dtype=np.float32) * 0.1
        islands = detect_vocal_islands(audio, sr=sr, min_pause_sec=1.2)

        self.assertEqual(len(islands), 1)
        self.assertAlmostEqual(islands[0].start_sec, 0.0, delta=0.05)
        self.assertAlmostEqual(islands[0].end_sec, 2.5, delta=0.05)

    def test_vad_island_detection_multiple_islands(self):
        """Verifies audio with gaps > 1.2s correctly splits into distinct VocalIsland objects."""
        sr = 16000
        # 8.0 seconds total:
        # 0.0s..1.5s: Island 1
        # 1.5s..3.5s: 2.0s Pause (> 1.2s)
        # 3.5s..5.0s: Island 2
        # 5.0s..7.0s: 2.0s Pause (> 1.2s)
        # 7.0s..8.0s: Island 3
        audio = np.zeros(8 * sr, dtype=np.float32)
        t = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False, dtype=np.float32)
        audio[0:int(1.5 * sr)] = 0.5 * np.sin(2 * np.pi * 220 * t)
        audio[int(3.5 * sr):int(5.0 * sr)] = 0.5 * np.sin(2 * np.pi * 330 * t)
        t3 = np.linspace(0, 1.0, int(1.0 * sr), endpoint=False, dtype=np.float32)
        audio[int(7.0 * sr):int(8.0 * sr)] = 0.5 * np.sin(2 * np.pi * 440 * t3)

        islands = detect_vocal_islands(audio, sr=sr, min_pause_sec=1.2)
        self.assertEqual(len(islands), 3, f"Expected 3 islands, got {len(islands)}")
        self.assertLessEqual(islands[0].end_sec, 2.0)
        self.assertGreaterEqual(islands[1].start_sec, 3.0)
        self.assertLessEqual(islands[1].end_sec, 5.5)
        self.assertGreaterEqual(islands[2].start_sec, 6.5)

    def test_merge_closest_islands(self):
        """Verifies islands separated by shortest pause are merged when island count > line count."""
        sr = 16000
        islands = [
            VocalIsland(start_sec=0.0, end_sec=2.0, audio=np.zeros(2 * sr), index=0),
            VocalIsland(start_sec=2.5, end_sec=4.0, audio=np.zeros(int(1.5 * sr)), index=1), # gap = 0.5s
            VocalIsland(start_sec=7.0, end_sec=9.0, audio=np.zeros(2 * sr), index=2),        # gap = 3.0s
        ]
        full_audio = np.zeros(10 * sr, dtype=np.float32)
        merged = merge_closest_islands(islands, target_count=2, vocal_audio_16k=full_audio, sr=sr)

        self.assertEqual(len(merged), 2)
        # Island 0 and 1 (separated by 0.5s) must be merged into 1 island [0.0, 4.0]
        self.assertAlmostEqual(merged[0].start_sec, 0.0)
        self.assertAlmostEqual(merged[0].end_sec, 4.0)
        self.assertAlmostEqual(merged[1].start_sec, 7.0)
        self.assertAlmostEqual(merged[1].end_sec, 9.0)

    def test_zero_solo_drift_guarantee(self):
        """
        Phase 3.1 Mathematical Guarantee Test:
        Audio contains a 3.0s instrumental guitar solo between Stanza 1 and Stanza 2.
        Verifies 100% zero word drift or leakage into the solo interval.
        """
        sr = 16000
        # 6.0 seconds total:
        # 0.0s..1.5s: Stanza 1
        # 1.5s..4.5s: 3.0s Guitar Solo
        # 4.5s..6.0s: Stanza 2
        audio = np.zeros(6 * sr, dtype=np.float32)
        t1 = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False, dtype=np.float32)
        audio[0:int(1.5 * sr)] = 0.6 * np.sin(2 * np.pi * 261.63 * t1)  # C4
        t2 = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False, dtype=np.float32)
        audio[int(4.5 * sr):int(6.0 * sr)] = 0.6 * np.sin(2 * np.pi * 329.63 * t2)  # E4

        lyrics = [
            "Erste Strophe hier",
            "Zweite Strophe dort",
        ]
        aligned = forced_align_words_vad_islands(audio, lyrics, min_pause_sec=1.2, lang="de")
        self.assertEqual(len(aligned), 6, "Must align all 6 words across both stanzas")

        # Stanza 1 words: [0..2]
        s1_words = aligned[:3]
        for w in s1_words:
            self.assertLessEqual(w["end"], 2.0, f"Stanza 1 word {w['word']} drifted into solo! (end={w['end']})")

        # Stanza 2 words: [4..6]
        s2_words = aligned[3:]
        for w in s2_words:
            self.assertGreaterEqual(w["start"], 4.0, f"Stanza 2 word {w['word']} drifted backward into solo! (start={w['start']})")

        # Absolute zero words in solo interval [2.0s .. 4.0s]
        for w in aligned:
            self.assertFalse(
                2.0 < w["start"] < 4.0,
                f"Word {w['word']} start={w['start']} leaked into guitar solo region [2.0s, 4.0s]"
            )
            self.assertFalse(
                2.0 < w["end"] < 4.0,
                f"Word {w['word']} end={w['end']} leaked into guitar solo region [2.0s, 4.0s]"
            )

    def test_align_plain_lyrics_mms_end_to_end_with_solo(self):
        """Verifies high-level align_plain_lyrics_mms handles solo breaks seamlessly."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            temp_wav = f.name

        try:
            sr = 16000
            audio = np.zeros(6 * sr, dtype=np.float32)
            t1 = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False, dtype=np.float32)
            audio[0:int(1.5 * sr)] = 0.6 * np.sin(2 * np.pi * 220 * t1)
            t2 = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False, dtype=np.float32)
            audio[int(4.5 * sr):int(6.0 * sr)] = 0.6 * np.sin(2 * np.pi * 330 * t2)
            sf.write(temp_wav, audio, sr)

            raw_lyrics = "Schnell fahr'n\nWir fahr'n weiter"
            sylls = align_plain_lyrics_mms(temp_wav, raw_lyrics, lang="de")

            self.assertEqual(len(sylls), 6, "Expected 6 syllables for 'Schnell fahr\\'n Wir fahr\\'n wei-ter'")
            # Stanza 1 syllables in island 1 (first 2 syllables: Schnell fahr'n)
            for s in sylls[:2]:
                self.assertLessEqual(s["end"], 2.0)
            self.assertTrue(sylls[1].get("line_break_after", False))

            # Stanza 2 syllables in island 2 (last 4 syllables: Wir fahr'n wei-ter)
            for s in sylls[2:]:
                self.assertGreaterEqual(s["start"], 4.0)
            self.assertTrue(sylls[-1].get("line_break_after", False))

            # Monotonicity check
            for i in range(len(sylls) - 1):
                self.assertLessEqual(sylls[i]["start"], sylls[i + 1]["start"])

        finally:
            if os.path.exists(temp_wav):
                os.remove(temp_wav)


if __name__ == "__main__":
    unittest.main()
