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
from karaoke.pitch import analyze_vocal_pitch, detect_song_key, mask_background_regions
from karaoke.basicpitch_adapter import BasicPitchAdapter
from karaoke.chart import detect_display_bpm, generate_ultrastar_chart
from karaoke.debug_export import export_debug_artifacts


@dataclass
class KaraokeJob:
    input_audio: Path | str
    artist: str = ""
    title: str = ""
    output_dir: Path | str = "./output"
    pitch_engine: str = DEFAULT_PITCH_ENGINE
    crepe_model: str = DEFAULT_CREPE_MODEL
    separator: str = "demucs"
    use_basic_pitch: bool = False
    key: str = ""
    vocal_range: str = "auto"
    lyrics_json: Optional[Path | str] = None
    plain_lyrics: Optional[Path | str] = None
    quality: str = DEFAULT_QUALITY
    device: Optional[str] = None
    use_cache: bool = True
    debug_dir: Optional[Path | str] = None
    silence_threshold: float = 0.35
    initial_prompt: Optional[str] = None


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
        requested_separator=job.separator,
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
        separator=job.separator,
        hardware_profile=hw,
        model_selection=models,
        stage_cache=stage_cache,
        progress_cb=sep_progress,
    )

    # Step 2: Display BPM (fast)
    display_bpm = detect_display_bpm(str(audio_path))

    # Step 3: Key Detection & Pitch Analysis (weight: 0.40 -> 0.65)
    def pitch_progress(s, sub_frac, m):
        report("pitch", 0.40 + 0.25 * sub_frac, m)

    key_info = detect_song_key(
        instrumental_file if instrumental_file.exists() else audio_path,
        vocal_path=vocals_file,
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

    # Breakthrough 5: Ensure Harmonic Octave Continuity Filter (HOCF) is applied
    if not pitch_data.get("hocf_applied", False):
        from karaoke.pitch import apply_harmonic_octave_continuity_filter
        pitch_data = apply_harmonic_octave_continuity_filter(pitch_data)

    # Step 4: Lyrics & Forced Alignment (weight: 0.65 -> 0.85)
    def lyrics_progress(s, sub_frac, m):
        report("lyrics", 0.65 + 0.20 * sub_frac, m)

    words = []
    detected_lang = "en"
    lyrics_source = "whisper"

    if job.lyrics_json and Path(job.lyrics_json).exists():
        res = load_canonical_lyrics(
            job.lyrics_json,
            vocals_file,
            pitch_data=pitch_data,
            hardware_profile=hw,
            progress_cb=lyrics_progress,
        )
        if res is not None:
            words, detected_lang = res
            lyrics_source = "canonical"

    # Priority 2: Unsynced plain-text lyrics (Phase 2 MMS-FA forced alignment)
    if not words and job.plain_lyrics and Path(job.plain_lyrics).exists():
        from karaoke.align_mms import align_plain_lyrics_mms
        lyrics_progress("lyrics", 0.2, "Aligning plain-text lyrics via Meta MMS-FA...")
        try:
            with open(job.plain_lyrics, "r", encoding="utf-8") as f:
                plain_text = f.read()
            lang = "de" if any(c in plain_text.lower() for c in "äöüß") else "en"
            words = align_plain_lyrics_mms(
                vocals_file,
                plain_text,
                pitch_data=pitch_data,
                lang=lang,
                hardware_profile=hw,
            )
            if words:
                detected_lang = lang
                lyrics_source = "plain_mms"
                print(f"✅ Ausrichtung über Meta MMS-FA erfolgreich: {len(words)} Noten/Silben (0% WER)")
                lyrics_progress("lyrics", 1.0, f"Aligned {len(words)} syllables via MMS-FA (0% WER)")
        except Exception as e:
            print(f"⚠️ MMS Plain Lyrics Alignment fehlgeschlagen ({e}). Weiche auf Whisper aus...")
            words = []

    # Priority 3: Fallback to Whisper Speech-to-Text transcription (Phase 4 AI Fallback)
    if not words:
        words, detected_lang = transcribe_lyrics(
            vocals_file,
            pitch_data=pitch_data,
            hardware_profile=hw,
            model_selection=models,
            stage_cache=stage_cache,
            progress_cb=lyrics_progress,
            artist=job.artist,
            title=job.title,
            silence_threshold=job.silence_threshold,
            initial_prompt=job.initial_prompt,
        )

    # Optional: Basic Pitch note prediction for split voting & octave tie-breaking
    bp_notes = None
    if job.use_basic_pitch:
        report("pitch", 0.64, "Extracting Basic Pitch note events (second opinion)...")
        bp_adapter = BasicPitchAdapter()
        if bp_adapter.is_available:
            bp_notes = bp_adapter.predict_notes(vocals_file)

    # Step 5: UltraStar Chart Generation & Playback Assembly (weight: 0.85 -> 0.98)
    report("chart", 0.88, "Building UltraStar chart file...")

    clean_filename = f"{artist} - {title}".replace("/", "_").replace("\\", "_")
    output_txt = output_dir / f"{clean_filename}.txt"

    output_txt, word_notes_list = generate_ultrastar_chart(
        words,
        pitch_data,
        display_bpm,
        title,
        artist,
        output_txt,
        lang=detected_lang,
        key_info=key_info,
        basic_pitch_notes=bp_notes,
        return_word_notes=True,
        vocals_path=vocals_file,
    )

    # Optional: Debug Artifact Export (contour.png and report.json, PLAN.md Phase 7.3)
    if job.debug_dir:
        report("chart", 0.95, "Exporting debug contour plot and report...")
        try:
            export_debug_artifacts(
                job.debug_dir,
                pitch_data,
                word_notes_list,
                title=title,
                artist=artist,
                key_info=key_info,
                pitch_engine=models.pitch_engine,
                basic_pitch_notes=bp_notes,
                hardware_profile=hw,
            )
        except Exception as e:
            print(f"⚠️ Debug-Export fehlgeschlagen: {e}")

    final_instrumental = output_dir / f"{clean_filename} [Instrumental].wav"
    if instrumental_file.exists():
        try:
            shutil.copyfile(instrumental_file, final_instrumental)
        except Exception:
            pass

    final_vocals = output_dir / f"{clean_filename} [Vocals].wav"
    if vocals_file.exists():
        try:
            shutil.copyfile(vocals_file, final_vocals)
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
        "vocals_wav": str(final_vocals) if final_vocals.exists() else str(vocals_file),
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
        "vocals_wav": final_vocals if final_vocals.exists() else vocals_file,
        "meta_json": meta_path,
        "lyrics_source": lyrics_source,
        "debug_dir": str(Path(job.debug_dir).resolve()) if job.debug_dir else None,
        "hardware": hw.to_dict(),
        "models_used": models.to_dict(),
    }
