"""
karaoke/separate_roformer.py - Mel-Band RoFormer High-SDR Stem Separation (Breakthrough 3)
State-of-the-art vocal isolation (12.5+ dB SDR) with Apple Silicon MPS acceleration
and automatic Demucs v4 fallback.
"""

from __future__ import annotations
import os
import sys
import shutil
import logging
from pathlib import Path
from typing import Tuple, Optional, Callable, Any, List

import torch

# Known high-performing RoFormer model architectures/weights for vocals
ROFORMER_VOCAL_MODELS: List[str] = [
    "model_mel_band_roformer_vocals.onnx",
    "MelBandRoformer.ckpt",
    "vocals_mel_band_roformer.ckpt",
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt",
]


def resolve_roformer_device(device: str = "auto") -> str:
    """Resolves target compute device for RoFormer separation (MPS, CUDA, or CPU)."""
    dev_str = (device or "auto").lower().strip()
    if dev_str in ("auto", "mps") and torch.backends.mps.is_available():
        os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
        return "mps"
    elif dev_str in ("auto", "cuda") and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def get_default_model_dir() -> Path:
    """Returns canonical model cache directory for audio-separator."""
    user_cache = Path.home() / ".cache" / "audio-separator-models"
    if user_cache.exists():
        return user_cache
    tmp_cache = Path("/tmp/audio-separator-models")
    if tmp_cache.exists():
        return tmp_cache
    user_cache.mkdir(parents=True, exist_ok=True)
    return user_cache


def find_cached_roformer_model(model_dir: Path) -> Optional[str]:
    """Scans cache directory for any pre-downloaded RoFormer model checkpoint."""
    if not model_dir.exists():
        return None
    for model_name in ROFORMER_VOCAL_MODELS:
        if (model_dir / model_name).exists():
            return model_name
    # Also check any file containing 'roformer'
    try:
        for f in model_dir.iterdir():
            if f.is_file() and "roformer" in f.name.lower() and (f.suffix in (".ckpt", ".onnx", ".pt", ".th")):
                return f.name
    except Exception:
        pass
    return None


def _sync_legacy_files(
    vocal_out: Path,
    inst_out: Path,
    legacy_vocals: Path,
    legacy_inst: Path,
    legacy_inst2: Path,
    stage_cache: Optional[Any] = None,
) -> None:
    """Ensures legacy filenames (vocals.wav, no_vocals.wav, instrumental.wav) and stage cache are synchronized."""
    for dest in (legacy_vocals,):
        if dest.resolve() != vocal_out.resolve():
            try:
                shutil.copyfile(str(vocal_out), str(dest))
            except Exception:
                pass

    for dest in (legacy_inst, legacy_inst2):
        if dest.resolve() != inst_out.resolve():
            try:
                shutil.copyfile(str(inst_out), str(dest))
            except Exception:
                pass

    if stage_cache and hasattr(stage_cache, "vocals_path") and hasattr(stage_cache, "instrumental_path"):
        try:
            if stage_cache.vocals_path.resolve() != vocal_out.resolve():
                shutil.copyfile(str(vocal_out), str(stage_cache.vocals_path))
            if stage_cache.instrumental_path.resolve() != inst_out.resolve():
                shutil.copyfile(str(inst_out), str(stage_cache.instrumental_path))
        except Exception:
            pass


def _sync_canonical_files(
    legacy_vocals: Path,
    legacy_inst: Path,
    vocal_out: Path,
    inst_out: Path,
    stage_cache: Optional[Any] = None,
) -> None:
    """Copies legacy stems to canonical {stem}_vocals.wav / {stem}_instrumental.wav."""
    if legacy_vocals.resolve() != vocal_out.resolve():
        try:
            shutil.copyfile(str(legacy_vocals), str(vocal_out))
        except Exception:
            pass

    if legacy_inst.resolve() != inst_out.resolve():
        try:
            shutil.copyfile(str(legacy_inst), str(inst_out))
        except Exception:
            pass

    if stage_cache and hasattr(stage_cache, "vocals_path") and hasattr(stage_cache, "instrumental_path"):
        try:
            if stage_cache.vocals_path.resolve() != vocal_out.resolve():
                shutil.copyfile(str(vocal_out), str(stage_cache.vocals_path))
            if stage_cache.instrumental_path.resolve() != inst_out.resolve():
                shutil.copyfile(str(inst_out), str(stage_cache.instrumental_path))
        except Exception:
            pass


def separate_mel_band_roformer(
    audio_path: Path | str,
    output_dir: Path | str,
    device: str = "auto",
    model_filename: Optional[str] = None,
    model_file_dir: Optional[Path | str] = None,
    stage_cache: Optional[Any] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Tuple[Path, Path]:
    """
    Separates vocal and instrumental stems using Mel-Band RoFormer (Breakthrough 3).
    Yields studio-grade dry acapellas (12.5+ dB SDR vs Demucs 9.0 dB).
    Falls back gracefully to Demucs v4 if RoFormer weights are unavailable or separation fails.
    """
    audio_path = Path(audio_path).resolve()
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    clean_stem = audio_path.stem
    vocal_out = output_dir / f"{clean_stem}_vocals.wav"
    inst_out = output_dir / f"{clean_stem}_instrumental.wav"

    legacy_vocals = output_dir / "vocals.wav"
    legacy_inst = output_dir / "no_vocals.wav"
    legacy_inst2 = output_dir / "instrumental.wav"

    # 1. Check stage cache
    if stage_cache and hasattr(stage_cache, "has_stems") and stage_cache.has_stems():
        if progress_cb:
            progress_cb("separate", 1.0, "Found cached stems in stage cache")
        return stage_cache.vocals_path, stage_cache.instrumental_path

    # 2. Check canonical stem files in output_dir
    if vocal_out.exists() and inst_out.exists():
        if progress_cb:
            progress_cb("separate", 1.0, "Found cached Mel-Band RoFormer stems")
        _sync_legacy_files(vocal_out, inst_out, legacy_vocals, legacy_inst, legacy_inst2, stage_cache)
        return vocal_out, inst_out

    # 3. Check legacy stem files in output_dir
    if legacy_vocals.exists() and (legacy_inst.exists() or legacy_inst2.exists()):
        chosen_inst = legacy_inst if legacy_inst.exists() else legacy_inst2
        if progress_cb:
            progress_cb("separate", 1.0, "Found cached stems in output folder")
        _sync_canonical_files(legacy_vocals, chosen_inst, vocal_out, inst_out, stage_cache)
        return vocal_out, inst_out

    # 4. Resolve hardware device
    target_device = resolve_roformer_device(device)

    # 5. Model cache directory and model selection
    cache_dir = Path(model_file_dir).resolve() if model_file_dir else get_default_model_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    chosen_model = model_filename
    if not chosen_model:
        cached = find_cached_roformer_model(cache_dir)
        # Also check /tmp/audio-separator-models if different
        if not cached and cache_dir != Path("/tmp/audio-separator-models"):
            cached = find_cached_roformer_model(Path("/tmp/audio-separator-models"))
        chosen_model = cached or ROFORMER_VOCAL_MODELS[0]

    if progress_cb:
        progress_cb("separate", 0.08, f"Initializing Mel-Band RoFormer on {target_device.upper()} ({chosen_model})...")

    print("\n" + "=" * 65)
    print(f"[1/4] 🎵 Mel-Band RoFormer Vocal Separation ({target_device.upper()} SDR 12.5+ dB)")
    print("=" * 65)

    try:
        from audio_separator.separator import Separator

        sep = Separator(
            output_dir=str(output_dir),
            output_format="WAV",
            model_file_dir=str(cache_dir),
            log_level=logging.WARNING,
        )

        if progress_cb:
            progress_cb("separate", 0.15, f"Loading RoFormer weights: {chosen_model}...")

        sep.load_model(model_filename=chosen_model)

        if progress_cb:
            progress_cb("separate", 0.35, "Running neural stem separation...")

        output_files = sep.separate(str(audio_path))

        vocal_file: Optional[Path] = None
        instrumental_file: Optional[Path] = None

        for out_name in output_files:
            p = Path(out_name) if Path(out_name).is_absolute() else output_dir / out_name
            name_lower = p.name.lower()
            if "vocal" in name_lower and not any(k in name_lower for k in ("no_vocal", "instrumental", "background", "karaoke")):
                vocal_file = p
            elif any(k in name_lower for k in ("instrumental", "no_vocals", "no_vocal", "background", "karaoke")):
                instrumental_file = p

        # Fallback heuristic if keyword matching wasn't exact
        if vocal_file is None or instrumental_file is None:
            for out_name in output_files:
                p = Path(out_name) if Path(out_name).is_absolute() else output_dir / out_name
                name_lower = p.name.lower()
                if "vocal" in name_lower and vocal_file is None:
                    vocal_file = p
                elif instrumental_file is None:
                    instrumental_file = p

        if vocal_file is None or instrumental_file is None:
            raise RuntimeError(f"Mel-Band RoFormer did not produce both stems: {output_files}")

        # Move/copy to canonical filenames
        if vocal_file.resolve() != vocal_out.resolve():
            if vocal_out.exists():
                vocal_out.unlink()
            shutil.move(str(vocal_file), str(vocal_out))

        if instrumental_file.resolve() != inst_out.resolve():
            if inst_out.exists():
                inst_out.unlink()
            shutil.move(str(instrumental_file), str(inst_out))

        _sync_legacy_files(vocal_out, inst_out, legacy_vocals, legacy_inst, legacy_inst2, stage_cache)

        if progress_cb:
            progress_cb("separate", 1.0, "Mel-Band RoFormer stem separation complete")

        print(f"✅ Mel-Band RoFormer Vocals: {vocal_out}")
        print(f"✅ Mel-Band RoFormer Playback: {inst_out}")
        return vocal_out, inst_out

    except Exception as e:
        print(f"⚠️ Mel-Band RoFormer fallback to Demucs v4: {e}")
        if progress_cb:
            progress_cb("separate", 0.12, f"Mel-Band RoFormer unavailable ({e}), fallback to Demucs v4...")
        from karaoke.separate import separate_stems
        return separate_stems(
            audio_path=audio_path,
            output_dir=output_dir,
            separator="demucs",
            stage_cache=stage_cache,
            progress_cb=progress_cb,
        )


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Mel-Band RoFormer Vocal Separation (Breakthrough 3)")
    parser.add_argument("input_audio", help="Path to input audio file")
    parser.add_argument("--output_dir", default="./output", help="Destination folder for stems")
    parser.add_argument("--device", choices=["auto", "cpu", "mps", "cuda"], default="auto", help="Hardware device")
    parser.add_argument("--model", default=None, help="RoFormer model filename override")
    parser.add_argument("--json-progress", action="store_true", default=False, help="Emit progress events as JSON lines")

    args = parser.parse_args()
    in_file = Path(args.input_audio).resolve()
    out_dir = Path(args.output_dir).resolve()

    if not in_file.exists():
        if args.json_progress:
            print(json.dumps({"status": "error", "message": f"File not found: {in_file}"}), flush=True)
        else:
            print(f"Error: File not found: {in_file}", file=sys.stderr)
        sys.exit(1)

    if args.json_progress:
        def prog_cb(stage: str, frac: float, msg: str):
            print(json.dumps({"stage": stage, "fraction": frac, "message": msg}), flush=True)
    else:
        def prog_cb(stage: str, frac: float, msg: str):
            pass

    try:
        vocals, inst = separate_mel_band_roformer(
            audio_path=in_file,
            output_dir=out_dir,
            device=args.device,
            model_filename=args.model,
            progress_cb=prog_cb,
        )
        if args.json_progress:
            print(json.dumps({
                "status": "done",
                "vocals_path": str(vocals),
                "instrumental_path": str(inst),
            }), flush=True)
        else:
            print(f"✅ Vocals: {vocals}")
            print(f"✅ Instrumental: {inst}")
    except Exception as exc:
        if args.json_progress:
            print(json.dumps({"status": "error", "message": str(exc)}), flush=True)
        else:
            print(f"Separation failed: {exc}", file=sys.stderr)
        sys.exit(1)
