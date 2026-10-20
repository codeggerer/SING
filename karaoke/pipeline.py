"""
End-to-end Karaoke Pipeline Execution Engine.
Supports progress callbacks, stage caching, hardware adaptation, and metadata recording.
"""

from __future__ import annotations
import os
import sys
import json
import shutil
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Callable

from karaoke.config import DEFAULT_QUALITY, DEFAULT_PITCH_ENGINE, DEFAULT_CREPE_MODEL
from karaoke.hardware import HardwareProfile, ModelSelection, detect_hardware, select_models
from karaoke.cache import StageCache
from karaoke.separate import separate_stems
from karaoke.lyrics_io import load_canonical_lyrics, transcribe_lyrics
from karaoke.pitch import analyze_vocal_pitch, detect_song_key
from karaoke.chart import detect_display_bpm, generate_ultrastar_chart


@dataclass
class KaraokeJob:
    input_audio: Path | str
    artist: str = ""
    title: str = ""
    output_dir: Path | str = "./output"
    pitch_engine: str = DEFAULT_PITCH_ENGINE
    crepe_model: str = DEFAULT_CREPE_MODEL
    key: str = ""
    vocal_range: str = "auto"
    lyrics_json: Optional[Path | str] = None
    quality: str = DEFAULT_QUALITY
    device: Optional[str] = None
    use_cache: bool = True


def run(
    job: KaraokeJob,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Dict[str, Any]:
    """
    Executes the complete AI karaoke generation pipeline for a job.
    Reports progress via progress_cb(stage: str, fraction: float, message: str).
    """
    def report(stage: str, frac: float, msg: str):
        if progress_cb:
            progress_cb(stage, round(min(1.0, max(0.0, frac)), 3), msg)

    report("init", 0.02, "Initializing hardware and environment...")

    audio_path = Path(job.input_audio).resolve()
    if not audio_path.exists():
        raise FileNotFoundError(f"Eingabe-Audiodatei nicht gefunden: {audio_path}")

    # Resolve artist and title if not provided
    filename_stem = audio_path.stem
    if not job.artist and not job.title:
        if " - " in filename_stem:
            parts = filename_stem.split(" - ", 1)
            artist, title = parts[0].strip(), parts[1].strip()
        else:
            artist, title = "Unknown Artist", filename_stem
    else:
        artist = job.artist or "Unknown Artist"
        title = job.title or filename_stem

    output_dir = Path(job.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Hardware Detection & Model Selection
    hw = detect_hardware(override_device=job.device)
    models = select_models(
        hw,
        quality=job.quality,
        requested_pitch_engine=job.pitch_engine,
        requested_crepe_model=job.crepe_model,
    )

    # 2. Stage Cache
    stage_cache = StageCache(output_dir, audio_path) if job.use_cache else None

    report("init", 0.05, f"Hardware configured: {hw.device} ({hw.backend.upper()})")

    # Step 1: Vocal Separation (weight: 0.05 -> 0.40)
    def sep_progress(s, sub_frac, m):
        report("separate", 0.05 + 0.35 * sub_frac, m)

    vocals_file, instrumental_file = separate_stems(
        audio_path,
        output_dir=output_dir,
        hardware_profile=hw,
        model_selection=models,
        stage_cache=stage_cache,
        progress_cb=sep_progress,
    )

    # Step 2: Display BPM (fast)
    display_bpm = detect_display_bpm(str(audio_path))

    # Step 3: Lyrics & Timestamps (weight: 0.40 -> 0.60)
    def lyrics_progress(s, sub_frac, m):
        report("lyrics", 0.40 + 0.20 * sub_frac, m)

    words = []
    detected_lang = "en"
    lyrics_source = "whisper"

    if job.lyrics_json and Path(job.lyrics_json).exists():
        res = load_canonical_lyrics(job.lyrics_json, vocals_file, progress_cb=lyrics_progress)
        if res is not None:
            words, detected_lang = res
            lyrics_source = "canonical"

    if not words:
        words, detected_lang = transcribe_lyrics(
            vocals_file,
            hardware_profile=hw,
            model_selection=models,
            stage_cache=stage_cache,
            progress_cb=lyrics_progress,
        )

    # Step 4: Key Detection & Pitch Analysis (weight: 0.60 -> 0.85)
    def pitch_progress(s, sub_frac, m):
        report("pitch", 0.60 + 0.25 * sub_frac, m)

    key_info = detect_song_key(
        instrumental_file if instrumental_file.exists() else audio_path,
        manual_key=job.key,
        stage_cache=stage_cache,
    )

    pitch_data = analyze_vocal_pitch(
        vocals_file,
        pitch_engine=models.pitch_engine,
        crepe_model=models.crepe_model,
        vocal_range=job.vocal_range,
        hardware_profile=hw,
        model_selection=models,
        stage_cache=stage_cache,
        progress_cb=pitch_progress,
    )

    # Step 5: UltraStar Chart Generation & Playback Assembly (weight: 0.85 -> 0.98)
    report("chart", 0.88, "Building UltraStar chart file...")

    clean_filename = f"{artist} - {title}".replace("/", "_").replace("\\", "_")
    output_txt = output_dir / f"{clean_filename}.txt"

    generate_ultrastar_chart(
        words,
        pitch_data,
        display_bpm,
        title,
        artist,
        output_txt,
        lang=detected_lang,
        key_info=key_info,
    )

    final_instrumental = output_dir / f"{clean_filename} [Instrumental].wav"
    if instrumental_file.exists():
        try:
            shutil.copyfile(instrumental_file, final_instrumental)
        except Exception:
            pass

    # Save meta.json
    meta = {
        "generator_version": "5.0-refactor",
        "artist": artist,
        "title": title,
        "language": detected_lang,
        "lyrics_source": lyrics_source,
        "display_bpm": display_bpm,
        "key": key_info["key"] if key_info else "Unknown",
        "hardware": hw.to_dict(),
        "models_used": models.to_dict(),
        "output_txt": str(output_txt),
        "instrumental_wav": str(final_instrumental),
    }
    meta_path = output_dir / f"{clean_filename}.meta.json"
    try:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    except Exception:
        pass

    report("done", 1.0, f"Karaoke chart created successfully: {output_txt.name}")

    return {
        "status": "done",
        "artist": artist,
        "title": title,
        "output_txt": output_txt,
        "instrumental_wav": final_instrumental,
        "vocals_wav": vocals_file,
        "meta_json": meta_path,
        "lyrics_source": lyrics_source,
        "hardware": hw.to_dict(),
        "models_used": models.to_dict(),
    }
