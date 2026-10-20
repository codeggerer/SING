#!/usr/bin/env python3
"""
Unit tests for the AI Karaoke Pipeline (Version 5.0).
Tests:
1. Phonetic syllable counting (English & German monosyllables + plurals/diphthongs)
2. Syllable splitting (guaranteeing 1-syllable words are never split)
3. Energy-weighted pitch extraction logic
4. Same-pitch note merging (eliminating duplicate tones on 1-syllable words)
5. UltraStar chart generation formatting
"""

import unittest
import numpy as np
import tempfile
import os
from pathlib import Path

# Import functions from generate_karaoke
import generate_karaoke as gk


class TestPhoneticSyllables(unittest.TestCase):

    def test_english_monosyllables(self):
        """English words with silent-e, diphthongs, or complex codas must have count == 1."""
        words = [
            "dance", "danced", "breathe", "taste", "space", "make", "love", "loved",
            "time", "hope", "like", "white", "game", "cause", "done", "some", "come",
            "leave", "please", "peace", "voice", "smile", "guide", "rule", "straight",
            "night", "bright", "thought", "through", "friend", "blood", "dream", "feel",
            "shine", "star", "drop", "vibe", "down"
        ]
        for w in words:
            count = gk.count_phonetic_syllables(w, lang="en")
            self.assertEqual(count, 1, f"Expected '{w}' to have 1 syllable, got {count}")

    def test_german_monosyllables(self):
        """German words with diphthongs, elisions, and contractions must have count == 1."""
        words = [
            "ein", "aus", "auf", "durch", "für", "mit", "nach", "von", "zu",
            "nicht", "noch", "doch", "nur", "schon", "schön", "gut", "sehr", "mehr",
            "seh", "sehn", "sieht", "sah", "geh", "gehn", "geht", "ging",
            "steh", "stehn", "steht", "traum", "nacht", "tag", "licht", "herz",
            "klang", "wort", "sinn", "glück", "hab", "gibt", "denk", "hör", "spiel"
        ]
        for w in words:
            count = gk.count_phonetic_syllables(w, lang="de")
            self.assertEqual(count, 1, f"Expected '{w}' to have 1 syllable, got {count}")

    def test_multisyllable_words(self):
        """Multi-syllable words must count correctly."""
        self.assertEqual(gk.count_phonetic_syllables("einfach", lang="de"), 2)
        self.assertEqual(gk.count_phonetic_syllables("zusammen", lang="de"), 3)
        self.assertEqual(gk.count_phonetic_syllables("beautiful", lang="en"), 3)
        self.assertEqual(gk.count_phonetic_syllables("together", lang="en"), 3)

    def test_split_syllables_never_splits_monosyllables(self):
        """1-syllable words must NEVER be split into multiple parts."""
        monos = ["dance", "breathe", "please", "love", "night", "traum", "sehn", "schön"]
        for w in monos:
            parts = gk.split_syllables(w, lang="de", word_duration=0.5)
            self.assertEqual(len(parts), 1, f"'{w}' was split into {parts}!")
            self.assertEqual(parts[0], w)

    def test_split_syllables_multisyllable(self):
        """Multi-syllable words should be split into valid parts."""
        parts_de = gk.split_syllables("einfach", lang="de", word_duration=0.6)
        self.assertEqual(len(parts_de), 2, f"'einfach' was split into {parts_de}")
        self.assertEqual("".join(parts_de), "einfach")


class TestPitchExtractionAndMerging(unittest.TestCase):

    def test_weighted_median_pitch(self):
        """Pitch extractor should correctly identify the sung pitch and ignore noise."""
        num_frames = 100
        # Simulated vocal note at MIDI 64 (E4) with slight vibrato (63.8 to 64.2)
        midi_frames = np.linspace(63.8, 64.2, num_frames)
        # High confidence for voiced center
        conf_frames = np.ones(num_frames) * 0.85
        # RMS energy highest in center
        rms_frames = np.ones(num_frames) * 0.5
        # Add consonant burst noise at start and end
        midi_frames[:15] = 78.0  # high pitch unvoiced burst
        conf_frames[:15] = 0.20  # low confidence
        midi_frames[-15:] = 45.0  # low vocal fry
        conf_frames[-15:] = 0.20

        pitch_data = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midi_frames,
            "conf": conf_frames,
            "rms": rms_frames,
            "total_frames": num_frames
        }

        # Pitch in the window 0.0 to 1.0s should be cleanly rounded to 64
        detected_pitch = gk.get_syllable_pitch(pitch_data, 0.0, 1.0)
        self.assertEqual(detected_pitch, 64)

    def test_same_pitch_merging(self):
        """
        A 1-syllable word must always produce exactly ONE note (never multiple pieces of the same pitch).
        Multi-syllable words ('einfach') must preserve their distinct singing syllable notes.
        """
        words_mono = [
            {"word": "dance", "start": 1.0, "end": 1.8, "probability": 0.99}
        ]
        total_frames = 300
        pitch_data = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": np.ones(total_frames) * 62.0,
            "conf": np.ones(total_frames) * 0.9,
            "rms": np.ones(total_frames) * 0.5,
            "total_frames": total_frames
        }

        with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as f:
            temp_path = f.name

        try:
            gk.generate_ultrastar_chart(
                words_mono, pitch_data, display_bpm=120, title="Test", artist="Artist",
                output_txt_path=temp_path, lang="en"
            )

            with open(temp_path, "r", encoding="utf-8") as f:
                lines = [line.strip() for line in f if line.strip()]

            note_lines = [l for l in lines if l.startswith(":")]
            # 1-syllable word must have EXACTLY ONE note line
            self.assertEqual(len(note_lines), 1, f"Expected 1 note line for monosyllable, got: {note_lines}")
            self.assertIn("62", note_lines[0])
            self.assertIn("dance", note_lines[0])
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def test_different_pitch_preserved(self):
        """
        If syllables of a word have DIFFERENT pitches (e.g. 62 then 65),
        both notes must be preserved with proper hyphenation!
        """
        words = [
            {"word": "einfach", "start": 1.0, "end": 2.0, "probability": 0.99}
        ]
        # Frame 0 to 150 (1.0 to 1.5s): pitch 62
        # Frame 150 to 300 (1.5 to 2.0s): pitch 65
        total_frames = 300
        midis = np.ones(total_frames) * 62.0
        midis[150:] = 65.0
        pitch_data = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis,
            "conf": np.ones(total_frames) * 0.9,
            "rms": np.ones(total_frames) * 0.5,
            "total_frames": total_frames
        }

        with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as f:
            temp_path = f.name

        try:
            gk.generate_ultrastar_chart(
                words, pitch_data, display_bpm=120, title="Test", artist="Artist",
                output_txt_path=temp_path, lang="de"
            )

            with open(temp_path, "r", encoding="utf-8") as f:
                lines = [line.strip() for line in f if line.strip()]

            note_lines = [l for l in lines if l.startswith(":")]
            self.assertEqual(len(note_lines), 2, f"Expected 2 note lines, got: {note_lines}")
            self.assertIn("62", note_lines[0])
            self.assertIn("65", note_lines[1])
            # First syllable should end with '-'
            self.assertTrue(note_lines[0].endswith("-"))
            # Last syllable should end with word text
            self.assertTrue(note_lines[1].endswith("fach"))
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def test_melisma_detection(self):
        """
        A single-syllable word held long with a 2-semitone pitch change
        should produce a melisma slur with '~'.
        """
        words = [
            {"word": "love", "start": 1.0, "end": 2.0, "probability": 0.99}
        ]
        total_frames = 300
        midis = np.ones(total_frames) * 60.0
        midis[150:] = 64.0  # jumps 4 semitones (major third)
        pitch_data = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis,
            "conf": np.ones(total_frames) * 0.9,
            "rms": np.ones(total_frames) * 0.5,
            "total_frames": total_frames
        }

        with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as f:
            temp_path = f.name

        try:
            gk.generate_ultrastar_chart(
                words, pitch_data, display_bpm=120, title="Test", artist="Artist",
                output_txt_path=temp_path, lang="en"
            )

            with open(temp_path, "r", encoding="utf-8") as f:
                lines = [line.strip() for line in f if line.strip()]

            note_lines = [l for l in lines if l.startswith(":")]
            self.assertEqual(len(note_lines), 2, f"Expected 2 note lines for melisma, got: {note_lines}")
            self.assertIn("60", note_lines[0])
            self.assertIn("64", note_lines[1])
            self.assertIn("~", note_lines[1])
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def test_clean_f0_pipeline(self):
        """Phase 5.3: clean_f0 removes octave jumps, suppresses vibrato, and masks unvoiced."""
        from karaoke.pitch import clean_f0

        t = np.arange(0, 3.0, 0.010)
        # Base pitch 440 Hz (MIDI 69) with 6 Hz vibrato + octave jump
        f0 = 440.0 * (2.0 ** ((0.5 * np.sin(2 * np.pi * 6.0 * t)) / 12.0))
        # Frame 100-105: octave double jump
        f0[100:106] *= 2.0

        v_prob = np.ones_like(t) * 0.95
        # Frame 0-10 and 280-300: unvoiced
        v_prob[:10] = 0.1
        v_prob[280:] = 0.1

        rms = np.ones_like(t) * 0.2
        rms[:10] = 0.00001
        rms[280:] = 0.00001

        midi_float, cleaned_conf, tuning_cents = clean_f0(t, f0, v_prob, rms)

        # Unvoiced frames should be NaN
        self.assertTrue(np.all(np.isnan(midi_float[:10])))
        self.assertTrue(np.all(np.isnan(midi_float[280:])))

        # Octave jump around 100-105 should be repaired to near 69
        self.assertAlmostEqual(midi_float[102], 69.0, delta=1.0)

        # Vibrato should be smoothed (std dev significantly reduced around 69)
        voiced_midis = midi_float[20:80]
        self.assertLess(np.std(voiced_midis), 0.35)

    def test_soft_scale_snapping(self):
        """Phase 5.5: soft scale snapping respects accidentals and requires >=0.6 confidence."""
        from karaoke.pitch import soft_snap_to_scale

        c_major_pcs = {0, 2, 4, 5, 7, 9, 11}

        # 1. Close to scale tone (within 0.35 st): 60.2 -> snaps to 60 (C)
        self.assertEqual(soft_snap_to_scale(60.2, c_major_pcs, confidence=0.8), 60)

        # 2. Close to out-of-scale tone: 61.1 (C# is out of C major)
        # 61.1 is 0.9 st away from 62 (D) and 1.1 st away from 60 (C), dev > 0.35 -> keeps 61!
        self.assertEqual(soft_snap_to_scale(61.0, c_major_pcs, confidence=0.8), 61)

        # 3. Low confidence (< 0.6): does not snap, keeps round(midi_float)
        self.assertEqual(soft_snap_to_scale(60.3, c_major_pcs, confidence=0.4), 60)

    def test_vibrato_does_not_split(self):
        """Phase 5.4: vibrato and glides must NEVER be split into multiple notes."""
        from karaoke.pitch import detect_syllable_split

        t = np.arange(0, 0.8, 0.010)
        # 800 ms with strong 5.5 Hz vibrato
        midis = 65.0 + 0.8 * np.sin(2 * np.pi * 5.5 * t)
        confs = np.ones_like(t) * 0.95
        pitch_data = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis,
            "conf": confs,
            "total_frames": len(t),
        }

        split = detect_syllable_split(pitch_data, 0.0, 0.8, has_tilde=False)
        self.assertIsNone(split, "Vibrato should not trigger a melisma split!")

    def test_basic_pitch_adapter_interface(self):
        """Phase 5.6: BasicPitchAdapter initializes and provides agreement helpers."""
        from karaoke.basicpitch_adapter import BasicPitchAdapter

        adapter = BasicPitchAdapter()
        # Should report availability boolean
        self.assertIsInstance(adapter.is_available, bool)

        # Test agreement helper with synthetic note events
        mock_bp_notes = [
            {"start": 0.0, "end": 0.40, "pitch": 60, "amplitude": 0.8},
            {"start": 0.41, "end": 0.80, "pitch": 64, "amplitude": 0.8},
        ]
        agrees = BasicPitchAdapter.votes_for_split(mock_bp_notes, 0.0, 0.80, 0.40)
        self.assertTrue(agrees)


if __name__ == "__main__":
    unittest.main()
