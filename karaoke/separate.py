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
    """Separation using audio-separator Mel-Band RoFormer."""
    from audio_separator.separator import Separator

    out_dir.mkdir(parents=True, exist_ok=True)
    if progress_cb:
        progress_cb("separate", 0.1, "Starting Mel-Band RoFormer vocal separation...")

    print("\n" + "=" * 65)
    print("[1/4] 🎵 Stimm- und Instrumental-Trennung mit Mel-Band RoFormer")
    print("=" * 65)

    sep = Separator(
        output_dir=str(out_dir),
        output_format="WAV",
        log_level=30,  # WARNING
    )
    # Kim vocal model / Mel-Band RoFormer
    sep.load_model("model_mel_band_roformer_crowd.onnx")
    outputs = sep.separate(str(audio_path))

    vocals_file = None
    instrumental_file = None
    for out_f in outputs:
        p = out_dir / out_f
        if "vocals" in out_f.lower():
            vocals_file = p
        elif "instrumental" in out_f.lower() or "no_vocals" in out_f.lower() or "background" in out_f.lower():
            instrumental_file = p

    if vocals_file is None or instrumental_file is None:
        raise RuntimeError("RoFormer hat nicht beide Stems erzeugt.")

    dest_vocals = out_dir / "vocals.wav"
    dest_instrumental = out_dir / "no_vocals.wav"
    shutil.move(str(vocals_file), str(dest_vocals))
    shutil.move(str(instrumental_file), str(dest_instrumental))

    if stage_cache:
        try:
            shutil.copyfile(dest_vocals, stage_cache.vocals_path)
            shutil.copyfile(dest_instrumental, stage_cache.instrumental_path)
        except Exception:
            pass

    if progress_cb:
        progress_cb("separate", 1.0, "Vocal separation complete")

    return dest_vocals, dest_instrumental


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
