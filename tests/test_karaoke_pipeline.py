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
import json
import os
import sys
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

    def test_portamento_glide_filter(self):
        """OVERHAUL_PLAN Phase 5.1: Vocal scoops/portamento (R^2 > 0.70 & monotonic) must NOT split."""
        from karaoke.pitch import detect_syllable_split

        t = np.arange(0, 0.8, 0.010)
        # Continuous monotonic vocal glide from 60.0 to 64.0
        midis = np.linspace(60.0, 64.0, len(t))
        confs = np.ones_like(t) * 0.95
        pitch_data = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis,
            "conf": confs,
            "total_frames": len(t),
        }

        split = detect_syllable_split(pitch_data, 0.0, 0.8, has_tilde=False)
        self.assertIsNone(split, "Monotonic portamento glide should be filtered out and not split!")

    def test_melisma_duration_and_plateau_bounds(self):
        """OVERHAUL_PLAN Phase 5.1: Min syllable dur 700ms, min plateau 250ms, min diff 2.5 st."""
        from karaoke.pitch import detect_syllable_split

        # 1. 600 ms syllable (< 700 ms): must NOT split without tilde/hyphen
        t_600 = np.arange(0, 0.6, 0.010)
        midis_600 = np.concatenate([np.full(30, 60.0), np.full(30, 64.0)])
        pitch_data_600 = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis_600,
            "conf": np.ones_like(t_600) * 0.95,
            "rms": np.ones_like(t_600) * 0.5,
            "total_frames": len(t_600),
        }
        self.assertIsNone(detect_syllable_split(pitch_data_600, 0.0, 0.6, has_tilde=False))
        # With tilde, 600 ms >= 350 ms and can split
        self.assertIsNotNone(detect_syllable_split(pitch_data_600, 0.0, 0.6, has_tilde=True))

        # 2. 800 ms syllable with short plateau 1: 180 ms (< 250 ms) -> must NOT split
        t_800 = np.arange(0, 0.8, 0.010)
        midis_short_plateau = np.concatenate([np.full(18, 60.0), np.full(62, 64.0)])
        pitch_data_short = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis_short_plateau,
            "conf": np.ones_like(t_800) * 0.95,
            "total_frames": len(t_800),
        }
        self.assertIsNone(detect_syllable_split(pitch_data_short, 0.0, 0.8, has_tilde=False))

        # 3. 800 ms syllable with small pitch difference: 2.0 st (< 2.5 st) -> must NOT split
        midis_small_diff = np.concatenate([np.full(40, 60.0), np.full(40, 62.0)])
        pitch_data_small = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis_small_diff,
            "conf": np.ones_like(t_800) * 0.95,
            "total_frames": len(t_800),
        }
        self.assertIsNone(detect_syllable_split(pitch_data_small, 0.0, 0.8, has_tilde=False))

        # 4. Valid melisma: 800 ms (>= 700 ms), 400 ms plateaus (>= 250 ms), 3.5 st diff (>= 2.5 st) -> SPLITS!
        midis_valid = np.concatenate([np.full(40, 60.0), np.full(40, 63.5)])
        pitch_data_valid = {
            "type": "contour",
            "frame_dur_sec": 0.010,
            "midi": midis_valid,
            "conf": np.ones_like(t_800) * 0.95,
            "rms": np.ones_like(t_800) * 0.5,
            "total_frames": len(t_800),
        }
        valid_split = detect_syllable_split(pitch_data_valid, 0.0, 0.8, has_tilde=False)
        self.assertIsNotNone(valid_split, "Legitimate step melisma must split!")
        self.assertEqual(len(valid_split), 2)
        self.assertAlmostEqual(valid_split[0][2], 60.0, delta=0.5)
        self.assertAlmostEqual(valid_split[1][2], 63.5, delta=0.5)

    def test_tuning_clamp_max_15_cents(self):
        """OVERHAUL_PLAN Phase 5.2: Global tuning drift clamped to +/- 15 cents maximum."""
        from karaoke.pitch import clean_f0
        from karaoke.config import TUNING_MAX_CORRECTION_CENTS

        self.assertEqual(TUNING_MAX_CORRECTION_CENTS, 15.0)

        # Create a sustained signal shifted sharp by +18 cents (A4 = 444.6 Hz)
        t = np.arange(0, 2.0, 0.010)
        f0 = 440.0 * (2.0 ** (0.18 / 12.0)) * np.ones_like(t)
        v_prob = np.ones_like(t) * 0.95
        rms = np.ones_like(t) * 0.5

        midi_float, cleaned_prob, tuning_cents = clean_f0(t, f0, v_prob, rms)
        # Tuning adjustment must be clamped to 15.0 cents max
        self.assertLessEqual(abs(tuning_cents), 15.0)
        self.assertAlmostEqual(tuning_cents, 15.0, delta=0.5)

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

    def test_debug_artifacts_export(self):
        """Phase 7.3: Debug export generates contour.png and report.json."""
        from karaoke.debug_export import export_debug_artifacts

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)

            t = np.arange(0, 2.0, 0.010)
            midis = np.full_like(t, 60.0)
            midis[50:100] = 64.0
            confs = np.full_like(t, 0.9)
            rms = np.full_like(t, 0.5)

            pitch_data = {
                "type": "contour",
                "frame_dur_sec": 0.010,
                "midi": midis,
                "conf": confs,
                "rms": rms,
                "total_frames": len(t),
                "tuning_cents": -5.2,
            }

            word_notes = [
                {
                    "pause_beat": None,
                    "num_sylls": 1,
                    "notes": [{"start": 0.1, "end": 0.9, "pitch": 60, "pitch_float": 60.05, "text": "Hel-"}],
                },
                {
                    "pause_beat": None,
                    "num_sylls": 1,
                    "notes": [{"start": 0.95, "end": 1.8, "pitch": 64, "pitch_float": 63.95, "text": "lo"}],
                },
            ]

            key_info = {"key": "C", "confidence": 0.92}
            res = export_debug_artifacts(
                tmp_path,
                pitch_data,
                word_notes,
                title="Test Song",
                artist="Test Artist",
                key_info=key_info,
                pitch_engine="fcpe",
            )

            png_file = tmp_path / "contour.png"
            json_file = tmp_path / "report.json"

            self.assertTrue(png_file.exists(), "contour.png must be created")
            self.assertGreater(png_file.stat().st_size, 1000, "contour.png should have valid image bytes")

            self.assertTrue(json_file.exists(), "report.json must be created")
            with open(json_file, "r", encoding="utf-8") as f:
                report = json.load(f)

            self.assertEqual(report["title"], "Test Song")
            self.assertEqual(report["artist"], "Test Artist")
            self.assertEqual(report["detected_key"], "C")
            self.assertEqual(len(report["syllables"]), 2)
            self.assertEqual(report["syllables"][0]["text"], "Hel-")
            self.assertEqual(report["syllables"][0]["pitch_midi"], 60)


class TestDualStemSeparation(unittest.TestCase):
    """Unit tests for Phase 6: Dual-Stem Audio Engine & CLI."""

    def test_cached_stems_retrieval(self):
        """separate_stems should instantly retrieve pre-cached stems without running subprocess."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            dummy_audio = tmp_path / "test_song.wav"
            dummy_audio.write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00D\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00")

            demucs_dir = tmp_path / "htdemucs" / "test_song"
            demucs_dir.mkdir(parents=True, exist_ok=True)
            mock_vocals = demucs_dir / "vocals.wav"
            mock_inst = demucs_dir / "no_vocals.wav"
            mock_vocals.write_bytes(b"vocals")
            mock_inst.write_bytes(b"instrumental")

            from karaoke.separate import separate_stems
            v_res, i_res = separate_stems(dummy_audio, output_dir=tmp_path)

            self.assertEqual(v_res.resolve(), mock_vocals.resolve())
            self.assertEqual(i_res.resolve(), mock_inst.resolve())
            self.assertTrue(v_res.exists())
            self.assertTrue(i_res.exists())

    def test_cli_missing_file_json_progress(self):
        """CLI should output clean JSON error when file is missing."""
        import subprocess
        cmd = [
            sys.executable,
            str(Path(__file__).resolve().parent.parent / "scripts" / "separate_stems.py"),
            "nonexistent_audio_file.wav",
            "--json-progress"
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertNotEqual(proc.returncode, 0)
        out = proc.stdout.strip()
        data = json.loads(out)
        self.assertEqual(data["status"], "error")
        self.assertIn("File not found", data["message"])


    def test_detect_vocal_onset_and_snap(self):
        """Test vocal onset detection and UltraStar chart snapping (Phase 1.1)."""
        from karaoke.sync import detect_vocal_onset, snap_vocal_onset_to_chart
        import numpy as np

        sr = 16000
        # 5 seconds of silence followed by 3 seconds of a 440Hz vocal tone
        silence = np.zeros(int(sr * 2.5), dtype=np.float32)
        t = np.linspace(0, 3, int(sr * 3), endpoint=False, dtype=np.float32)
        vocal_tone = (0.8 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
        audio = np.concatenate([silence, vocal_tone])

        onset = detect_vocal_onset(audio, sr=sr)
        self.assertAlmostEqual(onset, 2.5, delta=0.08)

        # UltraStar chart with first note at beat 100 (#BPM:1500 -> 1.0s)
        chart_content = (
            "#TITLE:Vocal Snap Test\n"
            "#ARTIST:Public Domain\n"
            "#BPM:1500\n"
            "#GAP:0\n"
            ": 100 20 60 Test \n"
            "E\n"
        )
        res = snap_vocal_onset_to_chart(audio, chart_content)
        self.assertEqual(res.method, "vocal_onset")
        # delta_tau = 2.5s - 1.0s = 1.5s -> aligned_gap_ms = 1500ms
        self.assertAlmostEqual(res.aligned_gap_ms, 1500.0, delta=80.0)


class TestTier2Precision(unittest.TestCase):
    """Unit tests for Phase 2: Tier 2 Syllable-Synced Precision & Studio Offset."""

    def test_energy_guided_syllable_split_monosyllable_protection(self):
        """Monosyllable protection: words in MONOSYLLABLE_WORDS or < 0.28s must never be split."""
        from karaoke.notes import energy_guided_syllable_split
        # 1. Monosyllable word from list
        res = energy_guided_syllable_split("breathe", 1.0, 1.8, lang="en")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["word"], "breathe ")

        # 2. Short duration (< 0.28s) multi-syllable word
        res_short = energy_guided_syllable_split("einfach", 2.0, 2.20, lang="de")
        self.assertEqual(len(res_short), 1)
        self.assertEqual(res_short[0]["word"], "einfach ")

    def test_energy_guided_syllable_split_snaps_to_energy_valley(self):
        """Multi-syllable words must snap boundary to acoustic energy minimum within ±120ms."""
        from karaoke.notes import energy_guided_syllable_split
        sr = 16000
        # 600ms word: Vowel 1 (0 to 240ms), Consonant valley (240ms to 360ms with valley at 300ms), Vowel 2 (360ms to 600ms)
        vowel1 = (0.8 * np.sin(2.0 * np.pi * 330.0 * np.linspace(0, 0.24, int(sr * 0.24)))).astype(np.float32)
        valley = (0.01 * np.sin(2.0 * np.pi * 100.0 * np.linspace(0, 0.12, int(sr * 0.12)))).astype(np.float32)
        vowel2 = (0.8 * np.sin(2.0 * np.pi * 440.0 * np.linspace(0, 0.24, int(sr * 0.24)))).astype(np.float32)
        audio = np.concatenate([vowel1, valley, vowel2])

        res = energy_guided_syllable_split(
            "einfach",
            start=10.0,
            end=10.60,
            vocal_audio=audio,
            sr=sr,
            lang="de",
            search_window_sec=0.120,
        )
        self.assertEqual(len(res), 2, f"Expected 2 syllables for 'einfach', got {len(res)}")
        self.assertEqual(res[0]["word"], "ein-")
        self.assertEqual(res[1]["word"], "fach ")
        # Boundary should snap to around 10.30s (±30ms) within the energy valley
        split_time = res[0]["end"]
        self.assertAlmostEqual(split_time, 10.30, delta=0.04)
        self.assertEqual(res[1]["start"], split_time)
        self.assertAlmostEqual(res[1]["end"], 10.60)

    def test_expand_words_with_energy_syllables(self):
        """expand_words_with_energy_syllables must expand word-level items into syllables."""
        from karaoke.lyrics_io import expand_words_with_energy_syllables
        words = [
            {"word": "einfach", "start": 1.0, "end": 1.8, "is_syllable": False},
            {"word": "dance ", "start": 2.0, "end": 2.5, "is_syllable": False},
        ]
        expanded = expand_words_with_energy_syllables(words, lang="de")
        self.assertEqual(len(expanded), 3)  # 'ein-', 'fach ', 'dance '
        self.assertEqual(expanded[0]["word"], "ein-")
        self.assertEqual(expanded[1]["word"], "fach ")
        self.assertEqual(expanded[2]["word"], "dance ")
        self.assertTrue(all(item["is_syllable"] for item in expanded))

    def test_measure_studio_offset_calculation(self):
        """measure_studio_offset must accurately calculate offset = t_vocal_first - t_lyric_first."""
        from karaoke.sync import measure_studio_offset
        sr = 16000
        # 2.5s silence + 1.5s singing
        silence = np.zeros(int(sr * 2.5), dtype=np.float32)
        t = np.linspace(0, 1.5, int(sr * 1.5), endpoint=False, dtype=np.float32)
        tone = (0.75 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
        vocals = np.concatenate([silence, tone])

        lyrics_doc = {
            "artist": "Test Artist",
            "title": "Test Title",
            "syncType": "syllable",
            "lines": [
                {
                    "start": 2.20,
                    "end": 4.00,
                    "words": "Hello world",
                    "syllables": [
                        {"text": "Hel-", "start": 2.20, "end": 2.60},
                        {"text": "lo ", "start": 2.60, "end": 3.00},
                        {"text": "world ", "start": 3.10, "end": 3.80},
                    ],
                }
            ],
        }

        res = measure_studio_offset(vocals, lyrics_doc, sr=sr)
        self.assertTrue(res["success"])
        # Vocal onset ~2.50s, Lyric first = 2.20s -> Offset ~ +0.30s (+300ms)
        self.assertAlmostEqual(res["vocal_first_sec"], 2.50, delta=0.08)
        self.assertAlmostEqual(res["lyric_first_sec"], 2.20, places=2)
        self.assertAlmostEqual(res["studio_offset_sec"], 0.30, delta=0.08)
        self.assertAlmostEqual(res["offset_ms"], 300.0, delta=80.0)


if __name__ == "__main__":
    unittest.main()
