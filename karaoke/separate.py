"""
Vocal and instrumental separation stage for AI Karaoke Pipeline (PLAN.md Phase 5.1).
Supports:
- Demucs (htdemucs)
- audio-separator (Mel-Band RoFormer / MDX23C)
"""

from __future__ import annotations
import os
import sys
import shutil
import subprocess
from pathlib import Path
from typing import Optional, Tuple, Callable

from karaoke.hardware import HardwareProfile, ModelSelection, detect_hardware, select_models
from karaoke.cache import StageCache


def separate_stems(
    audio_path: Path | str,
    output_dir: Path | str,
    separator: str = "demucs",
    hardware_profile: Optional[HardwareProfile] = None,
    model_selection: Optional[ModelSelection] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Tuple[Path, Path]:
    """
    Separates vocals and instrumental stems using Demucs or audio-separator RoFormer.
    Checks cache first before launching separation.
    """
    if progress_cb:
        progress_cb("separate", 0.0, "Checking stem cache...")

    audio_path = Path(audio_path).resolve()
    output_dir = Path(output_dir).resolve()

    # 1. Check StageCache in output/<hash>/
    if stage_cache and stage_cache.has_stems():
        if progress_cb:
            progress_cb("separate", 1.0, "Found cached stems in stage cache")
        print("⚡ Gesang und Playback im Stage-Cache vorhanden:")
        print(f"   Gesang: {stage_cache.vocals_path}")
        print(f"   Playback: {stage_cache.instrumental_path}")
        return stage_cache.vocals_path, stage_cache.instrumental_path

    # 2. Check traditional Demucs output folder (output_dir / htdemucs / stem)
    song_stem_name = audio_path.stem
    demucs_folder = output_dir / "htdemucs" / song_stem_name
    legacy_vocals = demucs_folder / "vocals.wav"
    legacy_instrumental = demucs_folder / "no_vocals.wav"

    if legacy_vocals.exists() and legacy_instrumental.exists():
        if progress_cb:
            progress_cb("separate", 1.0, "Found cached stems in htdemucs folder")
        print("⚡ Gesang und Playback bereits im Cache vorhanden:")
        print(f"   Gesang: {legacy_vocals}")
        print(f"   Playback: {legacy_instrumental}")
        if stage_cache and not stage_cache.has_stems():
            try:
                shutil.copyfile(legacy_vocals, stage_cache.vocals_path)
                shutil.copyfile(legacy_instrumental, stage_cache.instrumental_path)
            except Exception:
                pass
        return legacy_vocals, legacy_instrumental

    # 3. Hardware and model configuration
    if hardware_profile is None:
        hardware_profile = detect_hardware()
    if model_selection is None:
        model_selection = select_models(hardware_profile, requested_separator=separator)

    sep_choice = (separator or model_selection.separator or "demucs").lower()

    if sep_choice == "roformer":
        try:
            return _separate_roformer(
                audio_path,
                demucs_folder,
                hardware_profile=hardware_profile,
                stage_cache=stage_cache,
                progress_cb=progress_cb,
            )
        except Exception as e:
            print(f"⚠️ RoFormer-Separation fehlgeschlagen ({e}). Schalte auf Demucs um...")

    return _separate_demucs(
        audio_path,
        output_dir,
        demucs_folder,
        legacy_vocals,
        legacy_instrumental,
        hardware_profile=hardware_profile,
        model_selection=model_selection,
        stage_cache=stage_cache,
        progress_cb=progress_cb,
    )


def _separate_roformer(
    audio_path: Path,
    out_dir: Path,
    hardware_profile: Optional[HardwareProfile] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Tuple[Path, Path]:
    """Separation using audio-separator Mel-Band RoFormer (Breakthrough 3)."""
    from karaoke.separate_roformer import separate_mel_band_roformer

    dev = hardware_profile.device if hardware_profile else "auto"
    return separate_mel_band_roformer(
        audio_path=audio_path,
        output_dir=out_dir,
        device=dev,
        stage_cache=stage_cache,
        progress_cb=progress_cb,
    )


def _separate_demucs(
    audio_path: Path,
    output_dir: Path,
    demucs_folder: Path,
    legacy_vocals: Path,
    legacy_instrumental: Path,
    hardware_profile: HardwareProfile,
    model_selection: ModelSelection,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Tuple[Path, Path]:
    """Separation using Demucs (htdemucs)."""
    if progress_cb:
        progress_cb("separate", 0.1, f"Starting Demucs separation on {hardware_profile.device}...")

    print("\n" + "=" * 65)
    print("[1/4] 🎵 Stimm- und Instrumental-Trennung mit Demucs (KI)")
    print("=" * 65)

    cmd = [
        sys.executable, "-m", "demucs.separate",
        "--two-stems=vocals",
        "-n", "htdemucs",
        "-o", str(output_dir),
    ]

    if model_selection.separator_segment:
        cmd.extend(["--segment", str(model_selection.separator_segment)])

    if hardware_profile.backend == "cuda":
        cmd.extend(["-d", hardware_profile.device])
    elif hardware_profile.backend == "cpu":
        cmd.extend(["-d", "cpu"])

    cmd.append(str(audio_path))

    env = os.environ.copy()
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

    print(f"🚀 Starte Demucs: {' '.join(cmd)}")
    subprocess.run(cmd, env=env, check=True)

    if not legacy_vocals.exists() or not legacy_instrumental.exists():
        raise FileNotFoundError(f"Demucs-Dateien nicht gefunden in {demucs_folder}")

    if stage_cache:
        try:
            shutil.copyfile(legacy_vocals, stage_cache.vocals_path)
            shutil.copyfile(legacy_instrumental, stage_cache.instrumental_path)
        except Exception:
            pass

    if progress_cb:
        progress_cb("separate", 1.0, "Vocal separation complete")

    print(f"✅ Gesangsspur: {legacy_vocals}")
    print(f"✅ Instrumentalspur: {legacy_instrumental}")
    return legacy_vocals, legacy_instrumental


if __name__ == "__main__":
    import argparse
    import json

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

