#!/usr/bin/env python3
"""
AI Karaoke Generator: MP3 to UltraStar TXT + Instrumental Audio Track
CLI Wrapper & Public API Interface.

Version 5.0 (Modularized Architecture):
- High-Accuracy Phonetic Syllabification (English & German phonotactics + Monosyllable protection)
- Intelligent Same-Pitch Note Merging (guarantees 1-syllable words never get duplicate tones)
- Melisma / Pitch-Bend Detection (correct UltraStar '~' slur notation)
- Dual High-Accuracy Pitch Tracking:
    * Primary: CREPE Full with Viterbi decoding + RMS Energy weighting
    * Fallback / Alternative: Librosa pYIN with HMM Viterbi tracking
- Transient Consonant Filtering (trims onset/offset consonant noise before pitch calculation)
- Millisecond-precision UltraStar Beat Timing (BPM 1500 -> 10 ms resolution)
- Dynamic Hardware Profiling (Apple Silicon M4 MPS / NVIDIA CUDA / CPU)
- Stage-level Caching (sha1 audio + parameters)
- Machine-readable progress streaming (--json-progress)
"""

import sys
import json
import argparse
from pathlib import Path

# Re-export all public API functions from the modular karaoke package
from karaoke import (
    KaraokeJob,
    run,
    HardwareProfile,
    ModelSelection,
    detect_hardware,
    select_models,
    is_mlx_whisper_available,
    StageCache,
    compute_audio_sha1,
    separate_stems,
    MONOSYLLABLE_WORDS,
    count_phonetic_syllables,
    split_syllables,
    load_canonical_lyrics,
    transcribe_lyrics,
    compute_audio_rms,
    detect_song_key,
    snap_pitch_to_scale,
    soft_snap_to_scale,
    track_f0,
    clean_f0,
    analyze_vocal_pitch,
    _analyze_pitch_crepe,
    _analyze_pitch_pyin,
    get_syllable_pitch,
    detect_melisma_pitches,
    detect_syllable_split,
    mask_background_regions,
    BasicPitchAdapter,
    sec_to_beat,
    build_word_notes,
    apply_global_octave_tessitura,
    apply_subharmonic_recovery,
    apply_scale_snapping,
    detect_display_bpm,
    generate_ultrastar_chart,
    USTAR_BPM,
    BEAT_DUR_SEC,
    GAP,
)


def print_step(step_num: int, title: str):
    """Prints a formatted step header banner."""
    print("\n" + "=" * 65)
    print(f"[{step_num}/4] 🎵 {title}")
    print("=" * 65)


def main():
    parser = argparse.ArgumentParser(description="AI Karaoke Generator 5.0 (Präzise Melodien + Phonetik)")
    parser.add_argument("input_audio", help="Pfad zur Eingabe-Audiodatei (MP3, WAV, M4A)")
    parser.add_argument("--artist", default="", help="Künstler-Name (optional)")
    parser.add_argument("--title", default="", help="Song-Titel (optional)")
    parser.add_argument("--output_dir", default="./output", help="Ausgabeordner")
    parser.add_argument("--pitch-engine", choices=["fcpe", "crepe", "pyin", "rmvpe"], default="fcpe",
                        help="Tonhöhen-Algorithmus (fcpe = neural singing, crepe = neural, pyin = fallback)")
    parser.add_argument("--crepe-model", choices=["full", "tiny"], default="full",
                        help="CREPE Modell-Größe")
    parser.add_argument("--separator", choices=["demucs", "roformer"], default="demucs",
                        help="Stimmtrennungs-Modell (demucs, roformer)")
    parser.add_argument("--use-basic-pitch", action="store_true", default=False,
                        help="Basic Pitch als Zweitmeinung für Melisma-Splits & Oktav-Tiebreaker aktivieren")
    parser.add_argument("--key", default="", help="Musikalische Tonart (z.B. 'Eb', 'Cm', 'F', optional)")
    parser.add_argument("--vocal-range", choices=["auto", "female", "male"], default="auto",
                        help="Gesangsbereich (auto, female, male)")
    parser.add_argument("--lyrics-json", default=None,
                        help="Pfad zu kanonischer lyrics.json (Phase 2)")
    # Phase 3 additions:
    parser.add_argument("--quality", choices=["fast", "balanced", "best"], default="balanced",
                        help="Qualitätsstufe (fast, balanced, best)")
    parser.add_argument("--device", choices=["auto", "cpu", "mps", "cuda"], default="auto",
                        help="Hardware-Gerät forcieren (auto, cpu, mps, cuda)")
    parser.add_argument("--json-progress", action="store_true", default=False,
                        help="Maschinenlesbarer JSON-Progress Output für Server/SSE")
    parser.add_argument("--no-cache", action="store_true", default=False,
                        help="Stage-Cache deaktivieren")
    # Phase 7 additions:
    parser.add_argument("--debug-dir", default=None,
                        help="Ausgabeordner für Debug-Artefakte (contour.png, report.json)")

    args = parser.parse_args()

    audio_path = Path(args.input_audio).resolve()
    if not audio_path.exists():
        if args.json_progress:
            print(json.dumps({"status": "error", "message": f"Datei nicht gefunden: {audio_path}"}), flush=True)
        else:
            print(f"❌ Fehler: Datei nicht gefunden: {audio_path}")
        sys.exit(1)

    override_device = None if args.device == "auto" else args.device

    job = KaraokeJob(
        input_audio=audio_path,
        artist=args.artist,
        title=args.title,
        output_dir=args.output_dir,
        pitch_engine=args.pitch_engine,
        crepe_model=args.crepe_model,
        separator=args.separator,
        use_basic_pitch=args.use_basic_pitch,
        key=args.key,
        vocal_range=args.vocal_range,
        lyrics_json=args.lyrics_json,
        quality=args.quality,
        device=override_device,
        use_cache=not args.no_cache,
        debug_dir=args.debug_dir,
    )

    if args.json_progress:
        def progress_callback(stage: str, fraction: float, message: str):
            print(json.dumps({"stage": stage, "fraction": fraction, "message": message}), flush=True)
    else:
        print("\n" + "🎤" * 35)
        print(f" Starte KI-Karaoke Pipeline 5.0")
        print(f" (Engine: {args.pitch_engine.upper()}, Quality: {args.quality})")
        print("🎤" * 35)

        def progress_callback(stage: str, fraction: float, message: str):
            # Normal CLI printing is handled inside pipeline step functions
            pass

    try:
        result = run(job, progress_cb=progress_callback)
    except Exception as e:
        if args.json_progress:
            print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        raise

    if args.json_progress:
        # Final machine-readable line with result paths
        final_payload = {
            "status": "done",
            "artist": result["artist"],
            "title": result["title"],
            "output_txt": str(result["output_txt"]),
            "instrumental_wav": str(result["instrumental_wav"]),
            "vocals_wav": str(result["vocals_wav"]),
            "meta_json": str(result["meta_json"]),
            "lyrics_source": result["lyrics_source"],
            "debug_dir": str(result["debug_dir"]) if result.get("debug_dir") else None,
            "hardware": result["hardware"],
            "models_used": result["models_used"],
        }
        print(json.dumps(final_payload), flush=True)
    else:
        print("\n" + "⭐" * 35)
        print("FERTIG! Folgende Dateien wurden erzeugt:")
        print(f"1. Noten-Datei (UltraStar TXT): {result['output_txt']}")
        print(f"2. Instrumental-Audio (Playback): {result['instrumental_wav']}")
        print(f"3. Metadaten (JSON): {result['meta_json']}")
        if result.get("debug_dir"):
            print(f"4. Debug-Artefakte (PNG + JSON): {result['debug_dir']}")
        print("⭐" * 35 + "\n")


if __name__ == "__main__":
    main()
