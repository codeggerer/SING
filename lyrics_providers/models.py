"""
lyrics_providers/models.py - Canonical LyricsDoc Data Model & Serialization
(PLAN.md Phase 2.1)
"""

from __future__ import annotations
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Optional, Dict, Any, Union


@dataclass
class Syllable:
    text: str
    start: float  # seconds
    end: float    # seconds
    joinNext: bool = False
    derived: bool = False

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "text": self.text,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "joinNext": self.joinNext,
        }
        if self.derived:
            d["derived"] = True
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Syllable":
        return cls(
            text=str(data.get("text", "")),
            start=float(data.get("start", 0.0)),
            end=float(data.get("end", 0.0)),
            joinNext=bool(data.get("joinNext", False)),
            derived=bool(data.get("derived", False)),
        )


@dataclass
class Line:
    start: float  # seconds
    end: float    # seconds
    agent: str = "lead"  # "lead" | "background"
    words: str = ""
    syllables: List[Syllable] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "agent": self.agent,
            "words": self.words,
        }
        if self.syllables:
            d["syllables"] = [s.to_dict() for s in self.syllables]
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Line":
        sylls = [Syllable.from_dict(s) for s in data.get("syllables", [])]
        return cls(
            start=float(data.get("start", 0.0)),
            end=float(data.get("end", 0.0)),
            agent=str(data.get("agent", "lead")),
            words=str(data.get("words", "")),
            syllables=sylls,
        )


@dataclass
class LyricsDoc:
    source: str  # "spicylyrics" | "spotify" | "lrclib" | "whisper"
    syncType: str  # "syllable" | "word" | "line" | "static"
    language: str = "en"
    lines: List[Line] = field(default_factory=list)
    lyricsOffsetSec: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "syncType": self.syncType,
            "language": self.language,
            "lines": [l.to_dict() for l in self.lines],
            "lyricsOffsetSec": round(self.lyricsOffsetSec, 3),
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LyricsDoc":
        lines = [Line.from_dict(l) for l in data.get("lines", [])]
        return cls(
            source=str(data.get("source", "unknown")),
            syncType=str(data.get("syncType", "line")),
            language=str(data.get("language", "en")),
            lines=lines,
            lyricsOffsetSec=float(data.get("lyricsOffsetSec", 0.0)),
        )

    @classmethod
    def from_json(cls, json_str_or_path: Union[str, Path]) -> "LyricsDoc":
        p = Path(json_str_or_path) if not isinstance(json_str_or_path, Path) else json_str_or_path
        if p.exists() and p.is_file():
            content = p.read_text(encoding="utf-8")
        else:
            content = str(json_str_or_path)
        data = json.loads(content)
        return cls.from_dict(data)

    def get_full_text(self) -> str:
        """Return all text joined with newlines."""
        return "\n".join(l.words for l in self.lines if l.words)

    def to_words_list(self) -> List[Dict[str, Any]]:
        """
        Convert LyricsDoc into the word/syllable dictionaries expected by
        generate_karaoke.py's chart builder.
        Preserves syllable precision when available.
        """
        output_words = []
        offset = self.lyricsOffsetSec

        for line in self.lines:
            if line.syllables and self.syncType == "syllable":
                for idx, s in enumerate(line.syllables):
                    # In UltraStar, syllables not joined to next word end with a space
                    text = s.text
                    if not s.joinNext and not text.endswith(" "):
                        text += " "
                    s_start = max(0.0, s.start + offset)
                    s_end = max(s_start + 0.03, s.end + offset)
                    output_words.append({
                        "word": text,
                        "start": s_start,
                        "end": s_end,
                        "probability": 1.0,
                        "agent": line.agent,
                        "is_syllable": True,
                    })
            else:
                # Line-synced: distribute line text across words within realistic phrase duration
                line_words = [w for w in line.words.split() if w.strip()]
                if not line_words:
                    continue
                line_start = max(0.0, line.start + offset)
                raw_dur = max(0.5, line.end - line.start)
                # Cap phrase duration so words are not stretched over instrumental gaps
                est_dur = max(1.5, min(len(line_words) * 0.42 + 0.5, 6.0))
                line_dur = min(raw_dur, est_dur)
                dur_per_word = line_dur / len(line_words)

                for w_idx, w in enumerate(line_words):
                    w_start = line_start + w_idx * dur_per_word
                    w_end = w_start + dur_per_word
                    output_words.append({
                        "word": w + " ",
                        "start": w_start,
                        "end": w_end,
                        "probability": 0.9,
                        "agent": line.agent,
                        "is_syllable": False,
                    })

        return output_words
