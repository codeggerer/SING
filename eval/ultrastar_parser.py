"""
UltraStar .txt parser and timing converter.
Converts any UltraStar file into a structured chart and list of note dictionaries:
    { "start_sec": float, "end_sec": float, "pitch": int, "text": str, "type": str }

Follows the UltraStar specification:
    seconds_per_beat = 15.0 / BPM  (4 beats per bar, 1/4 quarter-BPM convention)
    time_sec = (GAP / 1000.0) + (beat * 15.0 / BPM)
"""

from __future__ import annotations
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Dict, Any, Optional, Union


def beat_to_seconds(beat: float, bpm: float, gap_ms: float = 0.0) -> float:
    """
    Convert an UltraStar beat index to song time in seconds.
    UltraStar BPM convention: 1 beat = 15 / BPM seconds.
    """
    if bpm <= 0:
        raise ValueError(f"BPM must be positive, got {bpm}")
    return (gap_ms / 1000.0) + (beat * (15.0 / bpm))


def seconds_to_beat(sec: float, bpm: float, gap_ms: float = 0.0) -> float:
    """
    Convert song time in seconds to an UltraStar beat index.
    """
    if bpm <= 0:
        raise ValueError(f"BPM must be positive, got {bpm}")
    return (sec - (gap_ms / 1000.0)) * (bpm / 15.0)


@dataclass
class UltraStarNote:
    start_sec: float
    end_sec: float
    pitch: int
    text: str
    type: str  # ':', '*', 'F', 'R', 'G'
    start_beat: int
    duration_beats: int

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "start_sec": self.start_sec,
            "end_sec": self.end_sec,
            "pitch": self.pitch,
            "text": self.text,
            "type": self.type,
        }

    # Dict-like access for compatibility with code expecting a dict
    def __getitem__(self, item: str) -> Any:
        return getattr(self, item)


@dataclass
class UltraStarChart:
    headers: Dict[str, str]
    notes: List[UltraStarNote]
    line_breaks: List[float]  # line break beats

    @property
    def title(self) -> str:
        return self.headers.get("TITLE", "")

    @property
    def artist(self) -> str:
        return self.headers.get("ARTIST", "")

    @property
    def bpm(self) -> float:
        val = self.headers.get("BPM", "300")
        try:
            return float(val.replace(",", "."))
        except ValueError:
            return 300.0

    @property
    def gap_ms(self) -> float:
        val = self.headers.get("GAP", "0")
        try:
            return float(val.replace(",", "."))
        except ValueError:
            return 0.0

    @property
    def notes_dict(self) -> List[Dict[str, Any]]:
        return [n.to_dict() for n in self.notes]


def parse_ultrastar_txt(content_or_path: Union[str, Path], track: int = 0) -> UltraStarChart:
    """
    Parse UltraStar .txt content or file path into an UltraStarChart.
    Supports single singer and duet charts (track 0 for P1, 1 for P2).
    """
    raw_content = ""
    if isinstance(content_or_path, Path) or (isinstance(content_or_path, str) and (os.path.exists(content_or_path) or "\n" not in content_or_path and len(content_or_path) < 500)):
        p = Path(content_or_path)
        if p.is_file():
            # Try utf-8 first, fallback to cp1252 / latin-1
            try:
                raw_content = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                raw_content = p.read_text(encoding="latin-1")
        else:
            raw_content = str(content_or_path)
    else:
        raw_content = str(content_or_path)

    headers: Dict[str, str] = {}
    track_notes: Dict[int, List[UltraStarNote]] = {0: [], 1: []}
    track_breaks: Dict[int, List[float]] = {0: [], 1: []}
    current_track = 0

    lines = raw_content.replace("\r\n", "\n").split("\n")

    # Pass 1: Parse headers first to get BPM and GAP
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            colon_idx = line.find(":")
            if colon_idx != -1:
                key = line[1:colon_idx].strip().upper()
                val = line[colon_idx + 1:].strip()
                headers[key] = val

    bpm_val = headers.get("BPM", "300").replace(",", ".")
    gap_val = headers.get("GAP", "0").replace(",", ".")
    try:
        bpm = float(bpm_val)
    except ValueError:
        bpm = 300.0
    if bpm <= 0:
        bpm = 300.0

    try:
        gap_ms = float(gap_val)
    except ValueError:
        gap_ms = 0.0

    # Pass 2: Parse notes, breaks, and singer tracks
    # Note regex: type beat duration pitch text (with trailing space)
    # Types: : (normal), * (golden), F (freestyle), R (rap), G (golden rap)
    note_regex = re.compile(r"^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)(?:\s(.*))?$")

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("#"):
            continue

        if line in ("P1", "P 1"):
            current_track = 0
            continue
        if line in ("P2", "P 2"):
            current_track = 1
            continue
        if line == "E":
            break

        if line.startswith("-"):
            # Line break: - <beat>
            parts = line[1:].strip().split()
            if parts:
                try:
                    break_beat = float(parts[0].replace(",", "."))
                    track_breaks[current_track].append(break_beat)
                except ValueError:
                    pass
            continue

        m = note_regex.match(raw_line)
        if m:
            ntype, start_b_s, dur_b_s, pitch_s, text = m.groups()
            start_beat = int(start_b_s)
            dur_beat = int(dur_b_s)
            pitch = int(pitch_s)
            # Retain trailing space if present in raw_line
            # In raw_line, text starts after pitch
            # Find the position where text starts
            match_prefix = f"{ntype} {start_b_s} {dur_b_s} {pitch_s}"
            pos = raw_line.find(match_prefix)
            if pos != -1:
                extracted_text = raw_line[pos + len(match_prefix):]
                if extracted_text.startswith(" "):
                    extracted_text = extracted_text[1:]
            else:
                extracted_text = text if text is not None else ""

            start_sec = beat_to_seconds(start_beat, bpm, gap_ms)
            end_sec = beat_to_seconds(start_beat + dur_beat, bpm, gap_ms)

            note = UltraStarNote(
                start_sec=round(start_sec, 4),
                end_sec=round(end_sec, 4),
                pitch=pitch,
                text=extracted_text,
                type=ntype,
                start_beat=start_beat,
                duration_beats=dur_beat,
            )
            track_notes[current_track].append(note)

    # Choose requested track, fallback to 0 if 1 is empty
    chosen_notes = track_notes.get(track, [])
    if not chosen_notes and track != 0:
        chosen_notes = track_notes.get(0, [])
    chosen_breaks = track_breaks.get(track, [])
    if not chosen_breaks and track != 0:
        chosen_breaks = track_breaks.get(0, [])

    return UltraStarChart(
        headers=headers,
        notes=chosen_notes,
        line_breaks=chosen_breaks,
    )
