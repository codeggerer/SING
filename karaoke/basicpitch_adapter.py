"""
Basic Pitch Adapter (PLAN.md Phase 5.6).
Provides neural note-event prediction and onset confidence as an optional second opinion.
"""

from __future__ import annotations
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
import numpy as np


class BasicPitchAdapter:
    """
    Adapter for Spotify's Basic Pitch note prediction.
    Used selectively for:
    1. Agreement vote for melisma split decisions
    2. Octave tie-breaking when f0 tracker and Basic Pitch differ by ~12 st
    """

    def __init__(self):
        self._available = False
        self._predict_fn = None
        try:
            from basic_pitch.inference import predict
            self._predict_fn = predict
            self._available = True
        except Exception:
            self._available = False

    @property
    def is_available(self) -> bool:
        return self._available

    def predict_notes(self, audio_path: Path | str) -> List[Dict[str, Any]]:
        """
        Runs Basic Pitch inference on audio and returns list of note events.
        Each note event: {'start': float, 'end': float, 'pitch': int, 'amplitude': float}
        """
        if not self._available or self._predict_fn is None:
            return []

        try:
            audio_path = Path(audio_path).resolve()
            if not audio_path.exists():
                return []

            model_output, midi_data, note_events = self._predict_fn(str(audio_path))
            parsed_notes = []
            for ev in note_events:
                # ev: (start_sec, end_sec, pitch_midi, amplitude, pitch_bends)
                s = float(ev[0])
                e = float(ev[1])
                p = int(round(float(ev[2])))
                amp = float(ev[3]) if len(ev) > 3 else 0.5
                parsed_notes.append({
                    "start": s,
                    "end": e,
                    "pitch": p,
                    "amplitude": amp,
                })
            return parsed_notes
        except Exception as e:
            print(f"⚠️ Basic Pitch Inferenz fehlgeschlagen: {e}")
            return []

    @staticmethod
    def votes_for_split(
        basic_pitch_notes: List[Dict[str, Any]],
        start_sec: float,
        end_sec: float,
        split_time_sec: float,
        margin_sec: float = 0.08,
    ) -> bool:
        """
        Checks if Basic Pitch agrees on a pitch change/split within [start_sec, end_sec].
        Returns True if:
        - There are at least two distinct notes within the syllable window, AND
        - One ends/starts within margin_sec of split_time_sec, AND
        - Their pitches differ by >= 1 semitone.
        """
        if not basic_pitch_notes:
            return False

        # Filter notes that overlap with syllable window
        overlapping = [
            n for n in basic_pitch_notes
            if n["end"] > start_sec and n["start"] < end_sec
        ]

        if len(overlapping) < 2:
            return False

        # Look for a note transition near split_time_sec
        for i in range(len(overlapping) - 1):
            n1 = overlapping[i]
            n2 = overlapping[i + 1]
            if abs(n1["end"] - split_time_sec) <= margin_sec or abs(n2["start"] - split_time_sec) <= margin_sec:
                if abs(n1["pitch"] - n2["pitch"]) >= 1:
                    return True

        return False

    @staticmethod
    def tie_break_octave(
        f0_midi: float,
        f0_conf: float,
        bp_notes: List[Dict[str, Any]],
        start_sec: float,
        end_sec: float,
    ) -> float:
        """
        When f0 tracker and Basic Pitch disagree by an octave (+/- 12 semitones),
        picks the octave of the one with higher confidence (never averages).
        """
        if not bp_notes:
            return f0_midi

        overlapping = [
            n for n in bp_notes
            if n["end"] > start_sec and n["start"] < end_sec
        ]
        if not overlapping:
            return f0_midi

        # Weight Basic Pitch notes by overlap duration and amplitude
        bp_pitches = []
        bp_weights = []
        for n in overlapping:
            overlap = min(end_sec, n["end"]) - max(start_sec, n["start"])
            if overlap > 0:
                bp_pitches.append(n["pitch"])
                bp_weights.append(overlap * n.get("amplitude", 0.5))

        if not bp_pitches:
            return f0_midi

        bp_median = bp_pitches[np.argmax(bp_weights)]
        st_diff = f0_midi - bp_median

        # If difference is near 12 or -12 semitones
        if abs(abs(st_diff) - 12.0) <= 1.5:
            # Check confidences: if Basic Pitch confidence/amplitude is significantly higher
            best_bp_amp = max(bp_weights)
            if best_bp_amp > 0.70 and f0_conf < 0.60:
                return float(bp_median)

        return f0_midi
