#!/usr/bin/env python3
"""
CLI script to separate vocals and instrumental stems using Demucs or Mel-Band RoFormer.
Used by AI generation engine and USDB audio ingestion pipeline (Phase 6).
"""

import sys
import json
import shutil
import argparse
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from karaoke.hardware import detect_hardware, select_models
from karaoke.cache import StageCache
from karaoke.separate import separate_stems


def main():
    parser = argparse.ArgumentParser(description="Separate vocals and instrumental stems (Demucs / RoFormer)")
    parser.add_argument("input_audio", help="Path to input audio file (WAV, MP3, etc.)")
    parser.add_argument("--output_dir", default="./output", help="Destination folder for stems")
    parser.add_argument("--separator", choices=["demucs", "roformer"], default="demucs", help="Stem separation algorithm")
    parser.add_argument("--device", choices=["auto", "cpu", "mps", "cuda"], default="auto", help="Hardware device override")
    parser.add_argument("--quality", choices=["fast", "balanced", "best"], default="balanced", help="Separation quality profile")
    parser.add_argument("--json-progress", action="store_true", default=False, help="Emit progress events as JSON lines")
    parser.add_argument("--no-cache", action="store_true", default=False, help="Disable stage cache")

    args = parser.parse_args()

    audio_file = Path(args.input_audio).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not audio_file.exists():
        if args.json_progress:
            print(json.dumps({"status": "error", "message": f"File not found: {audio_file}"}), flush=True)
        else:
            print(f"Error: File not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    override_device = None if args.device == "auto" else args.device
    hw = detect_hardware(override_device=override_device)
    models = select_models(hw, quality=args.quality, requested_separator=args.separator)
    cache = StageCache(out_dir, audio_file) if not args.no_cache else None

    if args.json_progress:
        def prog_cb(stage: str, fraction: float, message: str):
            print(json.dumps({"stage": stage, "fraction": fraction, "message": message}), flush=True)
    else:
        def prog_cb(stage: str, fraction: float, message: str):
            pass

    try:
        vocals_path, inst_path = separate_stems(
            audio_path=audio_file,
            output_dir=out_dir,
            separator=args.separator,
            hardware_profile=hw,
            model_selection=models,
            stage_cache=cache,
            progress_cb=prog_cb,
        )

        direct_vocals = out_dir / "vocals.wav"
        direct_inst = out_dir / "instrumental.wav"
        if vocals_path != direct_vocals and vocals_path.exists():
            try:
                shutil.copyfile(vocals_path, direct_vocals)
                vocals_path = direct_vocals
            except Exception:
                pass
        if inst_path != direct_inst and inst_path.exists():
            try:
                shutil.copyfile(inst_path, direct_inst)
                inst_path = direct_inst
            except Exception:
                pass

        if args.json_progress:
            print(json.dumps({
                "status": "done",
                "vocals_path": str(vocals_path),
                "instrumental_path": str(inst_path),
            }), flush=True)
        else:
            print(f"✅ Vocals: {vocals_path}")
            print(f"✅ Instrumental: {inst_path}")

    except Exception as e:
        if args.json_progress:
            print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        else:
            print(f"Separation failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
