"""
Stage caching mechanism for AI Karaoke Pipeline.
Keyed by sha1(audio) + stage parameters.
"""

from __future__ import annotations
import os
import json
import hashlib
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import numpy as np


def compute_audio_sha1(audio_path: Path | str) -> str:
    """Computes SHA-1 hash of the audio file in chunks."""
    audio_path = Path(audio_path).resolve()
    hasher = hashlib.sha1()
    with open(audio_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


class StageCache:
    """
    Manages cached artifacts for pipeline stages in output/<hash>/
    """
    def __init__(self, base_output_dir: Path | str, audio_path: Path | str, stage_hash: Optional[str] = None):
        self.audio_path = Path(audio_path).resolve()
        self.base_output_dir = Path(base_output_dir).resolve()
        self.audio_hash = stage_hash or compute_audio_sha1(self.audio_path)
        self.cache_dir = self.base_output_dir / self.audio_hash
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @property
    def vocals_path(self) -> Path:
        return self.cache_dir / "vocals.wav"

    @property
    def instrumental_path(self) -> Path:
        return self.cache_dir / "no_vocals.wav"

    def get_f0_path(self, pitch_engine: str, crepe_model: str = "tiny") -> Path:
        return self.cache_dir / f"f0_{pitch_engine}_{crepe_model}.npz"

    def get_words_path(self) -> Path:
        return self.cache_dir / "words.json"

    def get_key_path(self) -> Path:
        return self.cache_dir / "key_info.json"

    # Separation cache
    def has_stems(self) -> bool:
        return self.vocals_path.exists() and self.instrumental_path.exists()

    # Words / lyrics cache
    def load_words(self) -> Optional[Tuple[list, str]]:
        p = self.get_words_path()
        if not p.exists():
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("words", []), data.get("lang", "en")
        except Exception:
            return None

    def save_words(self, words: list, lang: str):
        p = self.get_words_path()
        try:
            with open(p, "w", encoding="utf-8") as f:
                json.dump({"words": words, "lang": lang}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # Pitch contour cache
    def load_f0(self, pitch_engine: str, crepe_model: str = "tiny") -> Optional[Dict[str, Any]]:
        # Check specific f0 file first, or generic f0.npz
        p = self.get_f0_path(pitch_engine, crepe_model)
        if not p.exists():
            generic_p = self.cache_dir / "f0.npz"
            if generic_p.exists():
                p = generic_p
            else:
                return None
        try:
            with np.load(p) as data:
                return {
                    "type": str(data["type"]) if "type" in data else "contour",
                    "frame_dur_sec": float(data["frame_dur_sec"]),
                    "midi": data["midi"],
                    "conf": data["conf"],
                    "rms": data["rms"],
                    "total_frames": int(data["total_frames"]) if "total_frames" in data else len(data["midi"]),
                    "sr": int(data["sr"]) if "sr" in data else 16000,
                    "audio": data["audio"] if "audio" in data else None
                }
        except Exception:
            return None

    def save_f0(self, pitch_data: Dict[str, Any], pitch_engine: str, crepe_model: str = "tiny"):
        p = self.get_f0_path(pitch_engine, crepe_model)
        generic_p = self.cache_dir / "f0.npz"
        try:
            kwargs = {
                "type": pitch_data.get("type", "contour"),
                "frame_dur_sec": pitch_data["frame_dur_sec"],
                "midi": pitch_data["midi"],
                "conf": pitch_data["conf"],
                "rms": pitch_data["rms"],
                "total_frames": pitch_data.get("total_frames", len(pitch_data["midi"])),
                "sr": pitch_data.get("sr", 16000)
            }
            if pitch_data.get("audio") is not None:
                kwargs["audio"] = pitch_data["audio"]
            np.savez_compressed(p, **kwargs)
            if not generic_p.exists():
                np.savez_compressed(generic_p, **kwargs)
        except Exception:
            pass

    # Key cache
    def load_key(self) -> Optional[Dict[str, Any]]:
        p = self.get_key_path()
        if not p.exists():
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data and "scale_pcs" in data:
                data["scale_pcs"] = set(data["scale_pcs"])
            return data
        except Exception:
            return None

    def save_key(self, key_info: Optional[Dict[str, Any]]):
        if not key_info:
            return
        p = self.get_key_path()
        try:
            serializable = dict(key_info)
            if "scale_pcs" in serializable and isinstance(serializable["scale_pcs"], set):
                serializable["scale_pcs"] = list(serializable["scale_pcs"])
            with open(p, "w", encoding="utf-8") as f:
                json.dump(serializable, f, indent=2)
        except Exception:
            pass
