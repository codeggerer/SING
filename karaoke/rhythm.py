"""
karaoke/rhythm.py - Musical Meter & Beat Grid Tracking (Issue #4).

Tracks tempo (BPM), beat phase, downbeat offset (#GAP), and musical time-grid
(1/4, 1/8, 1/16 notes and triplets) from instrumental audio stems.
Provides soft beat grid snapping to eliminate alignment micro-jitter while
preserving expressive syncopation and vocal rubato.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np

try:
    import librosa
except ImportError:
    librosa = None


@dataclass
class RhythmGrid:
    """
    Structured representation of a song's musical meter, tempo, and beat grid.
    """
    bpm: float
    beat_interval_sec: float
    phase_sec: float
    gap_ms: float
    beat_times: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float64))
    confidence: float = 1.0
    meter: Tuple[int, int] = (4, 4)

    @property
    def sixteenth_step_sec(self) -> float:
        """Duration of a 1/16th note in seconds."""
        return self.beat_interval_sec / 4.0

    @property
    def eighth_step_sec(self) -> float:
        """Duration of a 1/8th note in seconds."""
        return self.beat_interval_sec / 2.0

    @property
    def quarter_step_sec(self) -> float:
        """Duration of a 1/4th note in seconds."""
        return self.beat_interval_sec

    def to_dict(self) -> Dict[str, Any]:
        return {
            "bpm": round(float(self.bpm), 2),
            "beat_interval_sec": round(float(self.beat_interval_sec), 4),
            "phase_sec": round(float(self.phase_sec), 4),
            "gap_ms": round(float(self.gap_ms), 1),
            "confidence": round(float(self.confidence), 3),
            "meter": list(self.meter),
            "beat_count": int(len(self.beat_times)),
        }

    def get_nearest_grid(
        self,
        time_sec: float,
        subdivisions: Sequence[str] = ("1/16",),
    ) -> Tuple[float, float, str]:
        """
        Calculates the nearest musical grid line to time_sec and the absolute distance.

        Returns: (nearest_time_sec, abs_diff_sec, subdivision_name)
        """
        best_time = time_sec
        best_diff = float("inf")
        best_subdiv = "1/16"

        for subdiv in subdivisions:
            if subdiv == "1/16":
                step = self.sixteenth_step_sec
            elif subdiv == "1/8":
                step = self.eighth_step_sec
            elif subdiv == "1/4":
                step = self.quarter_step_sec
            elif subdiv == "1/32":
                step = self.beat_interval_sec / 8.0
            elif subdiv == "1/12":  # 8th-note triplet
                step = self.beat_interval_sec / 3.0
            elif subdiv == "1/24":  # 16th-note triplet
                step = self.beat_interval_sec / 6.0
            else:
                step = self.sixteenth_step_sec

            if step <= 0:
                continue

            # Grid line: phase_sec + k * step
            k = round((time_sec - self.phase_sec) / step)
            grid_time = max(0.0, self.phase_sec + k * step)
            diff = abs(time_sec - grid_time)

            if diff < best_diff:
                best_diff = diff
                best_time = grid_time
                best_subdiv = subdiv

        return best_time, best_diff, best_subdiv


def track_song_rhythm(
    audio_path_or_data: Union[str, Path, np.ndarray],
    sr: int = 22050,
    duration: Optional[float] = None,
    min_bpm: float = 65.0,
    max_bpm: float = 190.0,
) -> RhythmGrid:
    """
    Analyzes an audio track (preferably instrumental stem) using librosa beat tracking.
    Extracts real song BPM, beat timestamps, downbeat phase, and #GAP offset in ms.
    """
    if librosa is None:
        # Fallback if librosa is unavailable
        bpm = 120.0
        interval = 60.0 / bpm
        return RhythmGrid(
            bpm=bpm,
            beat_interval_sec=interval,
            phase_sec=0.0,
            gap_ms=0.0,
            confidence=0.5,
        )

    # Load audio
    if isinstance(audio_path_or_data, (str, Path)):
        p = Path(audio_path_or_data)
        if not p.exists():
            bpm = 120.0
            return RhythmGrid(bpm=bpm, beat_interval_sec=60.0 / bpm, phase_sec=0.0, gap_ms=0.0, confidence=0.0)
        try:
            y, sr = librosa.load(str(p), sr=sr, mono=True, duration=duration)
        except Exception:
            bpm = 120.0
            return RhythmGrid(bpm=bpm, beat_interval_sec=60.0 / bpm, phase_sec=0.0, gap_ms=0.0, confidence=0.0)
    else:
        y = np.asarray(audio_path_or_data, dtype=np.float32)
        if y.ndim > 1:
            y = np.mean(y, axis=0 if y.shape[0] < y.shape[1] else 1)

    if len(y) < sr * 2:  # Less than 2 seconds of audio
        bpm = 120.0
        return RhythmGrid(bpm=bpm, beat_interval_sec=60.0 / bpm, phase_sec=0.0, gap_ms=0.0, confidence=0.1)

    # Compute onset strength envelope
    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, beat_frames = librosa.beat.beat_track(
            y=y,
            sr=sr,
            onset_envelope=onset_env,
            trim=False,
        )
    except Exception:
        bpm = 120.0
        return RhythmGrid(bpm=bpm, beat_interval_sec=60.0 / bpm, phase_sec=0.0, gap_ms=0.0, confidence=0.2)

    # Normalize tempo into [min_bpm, max_bpm]
    if hasattr(tempo, "__iter__"):
        tempo_val = float(tempo[0]) if len(tempo) > 0 else 120.0
    else:
        tempo_val = float(tempo)

    if tempo_val <= 0 or math.isnan(tempo_val):
        tempo_val = 120.0

    while tempo_val < min_bpm:
        tempo_val *= 2.0
    while tempo_val > max_bpm:
        tempo_val /= 2.0

    tempo_val = round(tempo_val, 2)
    beat_interval = 60.0 / tempo_val

    # Convert frames to beat timestamps
    beat_times = librosa.frames_to_time(beat_frames, sr=sr) if len(beat_frames) > 0 else np.zeros(0)

    # Calculate circular mean phase of beat timestamps modulo beat_interval
    if len(beat_times) >= 2:
        phases = beat_times % beat_interval
        angles = 2.0 * np.pi * (phases / beat_interval)
        cos_sum = float(np.sum(np.cos(angles)))
        sin_sum = float(np.sum(np.sin(angles)))
        mean_angle = math.atan2(sin_sum, cos_sum) % (2.0 * np.pi)
        phase_sec = (mean_angle / (2.0 * np.pi)) * beat_interval
        # Directional statistics resultant vector length R in [0, 1]
        confidence = float(math.sqrt(cos_sum * cos_sum + sin_sum * sin_sum) / len(beat_times))
        confidence = max(0.2, min(1.0, confidence))
    elif len(beat_times) == 1:
        phase_sec = float(beat_times[0] % beat_interval)
        confidence = 0.5
    else:
        phase_sec = 0.0
        confidence = 0.3

    gap_ms = round(phase_sec * 1000.0, 1)

    return RhythmGrid(
        bpm=tempo_val,
        beat_interval_sec=beat_interval,
        phase_sec=phase_sec,
        gap_ms=gap_ms,
        beat_times=beat_times,
        confidence=confidence,
    )


def snap_onset_to_grid(
    onset_sec: float,
    rhythm_grid: Optional[RhythmGrid],
    tolerance_sec: float = 0.030,
    subdivisions: Sequence[str] = ("1/16",),
) -> Tuple[float, bool]:
    """
    Soft beat grid snapping for a single onset timestamp:
    - If onset is within tolerance_sec (default <= 30 ms) of a musical grid line (1/16th note),
      snaps directly to the grid line.
    - If onset clearly lands off-grid (syncopation / triplet / vocal rubato),
      preserves continuous timing.

    Returns: (snapped_or_original_sec, did_snap)
    """
    if rhythm_grid is None or rhythm_grid.confidence < 0.2:
        return onset_sec, False

    nearest_time, diff, _ = rhythm_grid.get_nearest_grid(onset_sec, subdivisions=subdivisions)
    if diff <= tolerance_sec:
        return max(0.0, nearest_time), True

    return onset_sec, False


def snap_notes_to_beat_grid(
    word_notes_list: List[Dict[str, Any]],
    rhythm_grid: Optional[RhythmGrid],
    tolerance_sec: float = 0.030,
    min_note_dur_sec: float = 0.030,
    min_gap_sec: float = 0.010,
    subdivisions: Sequence[str] = ("1/16",),
    snap_durations: bool = True,
) -> None:
    """
    In-place soft beat grid snapping on word_notes_list.
    Quantizes onsets and durations that land within tolerance_sec of 1/16th notes,
    while preserving continuous timing for off-beat / syncopated notes and avoiding collisions.
    """
    if rhythm_grid is None or rhythm_grid.confidence < 0.2:
        return

    # Pass 1: Soft snapping onsets and durations
    for wn in word_notes_list:
        notes = wn.get("notes", [])
        for note in notes:
            raw_start = float(note.get("note_start", note.get("start", 0.0)))
            raw_end = float(note.get("end", raw_start + 0.1))

            snapped_start, did_snap_s = snap_onset_to_grid(
                raw_start,
                rhythm_grid,
                tolerance_sec=tolerance_sec,
                subdivisions=subdivisions,
            )

            if snap_durations:
                snapped_end, did_snap_e = snap_onset_to_grid(
                    raw_end,
                    rhythm_grid,
                    tolerance_sec=tolerance_sec,
                    subdivisions=subdivisions,
                )
                if snapped_end < snapped_start + min_note_dur_sec:
                    snapped_end = max(raw_end, snapped_start + min_note_dur_sec)
            else:
                dur = raw_end - raw_start
                snapped_end = snapped_start + dur
                did_snap_e = False

            note["note_start"] = snapped_start
            note["start"] = min(float(note.get("start", snapped_start)), snapped_start)
            note["end"] = snapped_end
            note["grid_snapped"] = did_snap_s or did_snap_e

    # Pass 2: Overlap resolution to prevent collisions
    last_end = 0.0
    for wn in word_notes_list:
        notes = wn.get("notes", [])
        for note in notes:
            s = float(note.get("note_start", note["start"]))
            e = float(note["end"])

            if last_end > 0.0 and s < last_end + min_gap_sec:
                s = last_end + min_gap_sec
                note["note_start"] = s
                note["start"] = s

            if e < s + min_note_dur_sec:
                e = s + min_note_dur_sec
                note["end"] = e

            last_end = e
