"""
Unit tests for eval/metrics.py
"""

import unittest
from eval.metrics import (
    normalize_text,
    levenshtein_distance,
    compute_cer,
    compute_wer,
    align_syllables_dtw,
    compute_timing_metrics,
    compute_pitch_accuracy,
    evaluate_chart,
)


class TestMetrics(unittest.TestCase):

    def test_normalize_text(self):
        """Punctuation stripped, lowercase, umlauts and spaces preserved."""
        raw = "Hallo, Welt! Wie geht's dir? (Schön & wunderbar...)"
        norm = normalize_text(raw)
        self.assertEqual(norm, "hallo welt wie gehts dir schön wunderbar")

    def test_levenshtein_distance(self):
        """Standard edit distance verification."""
        self.assertEqual(levenshtein_distance("kitten", "sitting"), 3)
        self.assertEqual(levenshtein_distance("", "abc"), 3)
        self.assertEqual(levenshtein_distance("test", "test"), 0)

    def test_wer_and_cer(self):
        """Word Error Rate and Character Error Rate."""
        ref = "Ich dachte es wäre einfacher"
        hyp = "Ich dacht es wäre einfacher"
        # 1 word modified ('dachte' -> 'dacht'), total 5 words
        wer = compute_wer(ref, hyp)
        self.assertEqual(wer, 0.2)  # 1/5

        # Ref and hyp identical -> 0.0
        self.assertEqual(compute_wer("hello world", "hello world"), 0.0)
        self.assertEqual(compute_cer("hello world", "hello world"), 0.0)

    def test_pitch_accuracy_identical(self):
        """Identical pitches must yield 100% accuracy on all pitch metrics."""
        truth = [
            {"start_sec": 0.0, "end_sec": 1.0, "pitch": 60, "type": ":"},
            {"start_sec": 1.0, "end_sec": 2.0, "pitch": 64, "type": ":"},
        ]
        gen = [
            {"start_sec": 0.0, "end_sec": 1.0, "pitch": 60, "type": ":"},
            {"start_sec": 1.0, "end_sec": 2.0, "pitch": 64, "type": ":"},
        ]
        res = compute_pitch_accuracy(truth, gen)
        self.assertEqual(res["pitch_strict_0"], 1.0)
        self.assertEqual(res["pitch_strict_1"], 1.0)
        self.assertEqual(res["pitch_octave_0"], 1.0)
        self.assertEqual(res["pitch_octave_1"], 1.0)
        self.assertEqual(res["total_overlap_sec"], 2.0)

    def test_pitch_accuracy_octave_shift(self):
        """Pitch shifted by 12 semitones must fail strict but pass octave-agnostic."""
        truth = [{"start_sec": 0.0, "end_sec": 1.0, "pitch": 60, "type": ":"}]
        gen = [{"start_sec": 0.0, "end_sec": 1.0, "pitch": 72, "type": ":"}]
        res = compute_pitch_accuracy(truth, gen)
        self.assertEqual(res["pitch_strict_0"], 0.0)
        self.assertEqual(res["pitch_strict_1"], 0.0)
        self.assertEqual(res["pitch_octave_0"], 1.0)
        self.assertEqual(res["pitch_octave_1"], 1.0)

    def test_pitch_accuracy_one_semitone_off(self):
        """Pitch shifted by 1 semitone must fail ±0 but pass ±1."""
        truth = [{"start_sec": 0.0, "end_sec": 1.0, "pitch": 60, "type": ":"}]
        gen = [{"start_sec": 0.0, "end_sec": 1.0, "pitch": 61, "type": ":"}]
        res = compute_pitch_accuracy(truth, gen)
        self.assertEqual(res["pitch_strict_0"], 0.0)
        self.assertEqual(res["pitch_strict_1"], 1.0)
        self.assertEqual(res["pitch_octave_0"], 0.0)
        self.assertEqual(res["pitch_octave_1"], 1.0)

    def test_pitch_duration_weighting(self):
        """Pitch accuracy must be weighted by duration of overlap."""
        # 2 seconds correct, 1 second wrong by 5 semitones
        truth = [
            {"start_sec": 0.0, "end_sec": 2.0, "pitch": 60, "type": ":"},
            {"start_sec": 2.0, "end_sec": 3.0, "pitch": 64, "type": ":"},
        ]
        gen = [
            {"start_sec": 0.0, "end_sec": 2.0, "pitch": 60, "type": ":"},
            {"start_sec": 2.0, "end_sec": 3.0, "pitch": 69, "type": ":"},
        ]
        res = compute_pitch_accuracy(truth, gen)
        # 2.0s / 3.0s = 0.6667
        self.assertAlmostEqual(res["pitch_strict_0"], 2.0 / 3.0, places=3)
        self.assertAlmostEqual(res["pitch_strict_1"], 2.0 / 3.0, places=3)

    def test_timing_and_false_split(self):
        """False split rate and onset error calculation."""
        # 1 truth syllable matched by 2 generated notes (a false split!)
        truth = [
            {"start_sec": 1.0, "end_sec": 2.0, "text": "tan-", "pitch": 60},
            {"start_sec": 2.0, "end_sec": 3.0, "text": "zen", "pitch": 62},
        ]
        gen = [
            {"start_sec": 1.05, "end_sec": 1.5, "text": "tan-", "pitch": 60},
            {"start_sec": 1.55, "end_sec": 2.0, "text": "an-", "pitch": 60},
            {"start_sec": 2.1, "end_sec": 3.0, "text": "zen", "pitch": 62},
        ]
        timing = compute_timing_metrics(truth, gen)
        # 1 of 2 truth syllables was split into 2 notes -> false_split_rate = 0.5
        self.assertEqual(timing["false_split_rate"], 0.5)
        # Onset errors: |1.05 - 1.0| = 50ms, |2.1 - 2.0| = 100ms
        self.assertAlmostEqual(timing["onset_error_median_ms"], 75.0, places=1)

    def test_evaluate_chart_composite(self):
        """Full evaluate_chart call returns all fields correctly."""
        truth = [{"start_sec": 0.0, "end_sec": 1.0, "text": "test", "pitch": 60, "type": ":"}]
        gen = [{"start_sec": 0.0, "end_sec": 1.0, "text": "test", "pitch": 60, "type": ":"}]
        metrics = evaluate_chart(truth, gen)
        self.assertEqual(metrics.pitch_strict_0, 1.0)
        self.assertEqual(metrics.lyrics_wer, 0.0)
        self.assertEqual(metrics.false_split_rate, 0.0)
        self.assertEqual(metrics.truth_note_count, 1)
        self.assertEqual(metrics.gen_note_count, 1)


if __name__ == "__main__":
    unittest.main()
