"""
Vocal and instrumental separation stage for AI Karaoke Pipeline.
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
    hardware_profile: Optional[HardwareProfile] = None,
    model_selection: Optional[ModelSelection] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Tuple[Path, Path]:
    """
    Separates vocals and instrumental stems using Demucs (htdemucs).
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
        model_selection = select_models(hardware_profile)

    if progress_cb:
        progress_cb("separate", 0.1, f"Starting Demucs separation on {hardware_profile.device}...")

    print("\n" + "=" * 65)
    print("[1/4] 🎵 Stimm- und Instrumental-Trennung mit Demucs (KI)")
    print("=" * 65)

    cmd = [
        sys.executable, "-m", "demucs.separate",
        "--two-stems=vocals",
        "-n", model_selection.separator,
        "-o", str(output_dir),
    ]

    # Handle segment override for low-memory devices
    if model_selection.separator_segment:
        cmd.extend(["--segment", str(model_selection.separator_segment)])

    # Add device parameter if supported
    if hardware_profile.backend == "cuda":
        cmd.extend(["-d", hardware_profile.device])
    elif hardware_profile.backend == "cpu":
        cmd.extend(["-d", "cpu"])
    # Note: On macOS, demucs will auto-detect MPS or use default torch device

    cmd.append(str(audio_path))

    env = os.environ.copy()
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

    print(f"🚀 Starte Demucs: {' '.join(cmd)}")
    subprocess.run(cmd, env=env, check=True)

    if not legacy_vocals.exists() or not legacy_instrumental.exists():
        raise FileNotFoundError(f"Demucs-Dateien nicht gefunden in {demucs_folder}")

    # Copy to stage cache if active
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
