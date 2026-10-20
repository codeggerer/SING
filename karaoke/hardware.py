"""
Dynamic Hardware Detection & Model Selection for the AI Karaoke Engine.

Supports:
- Apple Silicon (MPS on M1/M2/M3/M4)
- NVIDIA GPUs / AMD ROCm (CUDA)
- CPU Fallback
"""

from __future__ import annotations
import os
import sys
import subprocess
from dataclasses import dataclass, field
from typing import Optional, Dict, Any

from karaoke.config import QUALITY_FAST, QUALITY_BALANCED, QUALITY_BEST


@dataclass
class HardwareProfile:
    backend: str          # "mps", "cuda", "cpu"
    device: str           # "mps", "cuda:0", "cpu"
    vram_or_ram_gb: float # Total VRAM (CUDA) or System RAM (MPS/CPU)
    cpu_cores: int
    notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "backend": self.backend,
            "device": self.device,
            "vram_or_ram_gb": round(self.vram_or_ram_gb, 2),
            "cpu_cores": self.cpu_cores,
            "notes": self.notes
        }


@dataclass
class ModelSelection:
    whisper_backend: str   # "mlx-whisper" | "faster-whisper"
    whisper_model: str     # "large-v3-turbo", "large-v3", "medium", "small", etc.
    whisper_compute: str   # "int8", "fp16", "int8_float16", etc.
    whisper_device: str    # "cpu", "cuda", etc.
    separator: str         # "htdemucs" | "roformer"
    separator_device: str  # "mps", "cuda", "cpu"
    separator_segment: Optional[int] = None
    pitch_engine: str = "pyin"       # "pyin", "crepe", "rmvpe", "fcpe"
    crepe_model: str = "tiny"        # "tiny", "full"
    pitch_device: str = "cpu"        # "mps", "cuda", "cpu"
    forced_aligner: str = "cpu"      # "mps", "cuda", "cpu"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "whisper_backend": self.whisper_backend,
            "whisper_model": self.whisper_model,
            "whisper_compute": self.whisper_compute,
            "whisper_device": self.whisper_device,
            "separator": self.separator,
            "separator_device": self.separator_device,
            "separator_segment": self.separator_segment,
            "pitch_engine": self.pitch_engine,
            "crepe_model": self.crepe_model,
            "pitch_device": self.pitch_device,
            "forced_aligner": self.forced_aligner,
        }


def _detect_system_ram_gb() -> float:
    """Detect total system physical RAM in Gigabytes."""
    # Try psutil if available
    try:
        import psutil
        return float(psutil.virtual_memory().total) / (1024 ** 3)
    except Exception:
        pass

    # Try macOS sysctl
    if sys.platform == "darwin":
        try:
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            return float(out.strip()) / (1024 ** 3)
        except Exception:
            pass

    # Try os.sysconf
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page_size > 0:
            return float(pages * page_size) / (1024 ** 3)
    except Exception:
        pass

    # Default conservative estimate: 8 GB
    return 8.0


def is_mlx_whisper_available() -> bool:
    """Check if Apple MLX Whisper is installed and importable."""
    try:
        import mlx_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def detect_hardware(override_device: Optional[str] = None) -> HardwareProfile:
    """
    Detects hardware capabilities.
    Priority:
    1. override_device argument (e.g. 'cpu', 'mps', 'cuda')
    2. KARAOKE_DEVICE environment variable
    3. Apple Silicon MPS if available
    4. NVIDIA / ROCm CUDA if available
    5. CPU fallback
    """
    requested_dev = (override_device or os.environ.get("KARAOKE_DEVICE", "")).lower().strip()

    cpu_cores = os.cpu_count() or 4
    system_ram = _detect_system_ram_gb()

    # Safe PyTorch import
    try:
        import torch
    except ImportError:
        torch = None

    # Handle explicit override
    if requested_dev:
        if requested_dev == "cpu":
            return HardwareProfile(
                backend="cpu",
                device="cpu",
                vram_or_ram_gb=system_ram,
                cpu_cores=cpu_cores,
                notes="Manual override: forced CPU mode"
            )
        elif requested_dev == "mps":
            if torch is not None and torch.backends.mps.is_available():
                os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
                return HardwareProfile(
                    backend="mps",
                    device="mps",
                    vram_or_ram_gb=system_ram,
                    cpu_cores=cpu_cores,
                    notes="Manual override: Apple Silicon MPS"
                )
            else:
                return HardwareProfile(
                    backend="cpu",
                    device="cpu",
                    vram_or_ram_gb=system_ram,
                    cpu_cores=cpu_cores,
                    notes="Requested MPS but torch.backends.mps is unavailable; fell back to CPU"
                )
        elif requested_dev.startswith("cuda"):
            if torch is not None and torch.cuda.is_available():
                vram = float(torch.cuda.get_device_properties(0).total_memory) / (1024 ** 3)
                return HardwareProfile(
                    backend="cuda",
                    device=requested_dev if ":" in requested_dev else "cuda:0",
                    vram_or_ram_gb=vram,
                    cpu_cores=cpu_cores,
                    notes="Manual override: CUDA GPU"
                )
            else:
                return HardwareProfile(
                    backend="cpu",
                    device="cpu",
                    vram_or_ram_gb=system_ram,
                    cpu_cores=cpu_cores,
                    notes="Requested CUDA but torch.cuda is unavailable; fell back to CPU"
                )

    # Automatic detection
    if torch is not None:
        if torch.backends.mps.is_available():
            os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
            return HardwareProfile(
                backend="mps",
                device="mps",
                vram_or_ram_gb=system_ram,
                cpu_cores=cpu_cores,
                notes="Apple Silicon MPS accelerated"
            )
        elif torch.cuda.is_available():
            vram = float(torch.cuda.get_device_properties(0).total_memory) / (1024 ** 3)
            # Note: AMD ROCm on Linux uses torch.cuda as well, so it is handled here.
            return HardwareProfile(
                backend="cuda",
                device="cuda:0",
                vram_or_ram_gb=vram,
                cpu_cores=cpu_cores,
                notes=f"CUDA GPU ({torch.cuda.get_device_name(0)})"
            )

    return HardwareProfile(
        backend="cpu",
        device="cpu",
        vram_or_ram_gb=system_ram,
        cpu_cores=cpu_cores,
        notes="Standard CPU execution"
    )


def select_models(
    hw: HardwareProfile,
    quality: str = QUALITY_BALANCED,
    requested_pitch_engine: Optional[str] = None,
    requested_crepe_model: Optional[str] = None,
    requested_separator: Optional[str] = None,
) -> ModelSelection:
    """
    Selects optimal model tiers, compute types, and devices based on HardwareProfile
    and requested quality.

    Selection table (PLAN.md Phase 3):
    - mps (>=16 GB): mlx-whisper (if available, else faster-whisper CPU), large-v3-turbo, demucs/roformer, CREPE full / pyin
    - cuda >= 10 GB: faster-whisper CUDA fp16, large-v3, roformer GPU
    - cuda < 10 GB: faster-whisper CUDA int8_float16, large-v3-turbo, htdemucs
    - cpu: faster-whisper CPU int8, small (or medium if >=16GB & quality best)
    """
    quality = quality.lower()
    if quality not in (QUALITY_FAST, QUALITY_BALANCED, QUALITY_BEST):
        quality = QUALITY_BALANCED

    # Determine Whisper backend and model
    mlx_avail = (hw.backend == "mps") and is_mlx_whisper_available()

    if hw.backend == "mps":
        sep_device = "mps"
        pitch_device = "mps"
        align_device = "mps"
        sep_segment = None

        if hw.vram_or_ram_gb >= 16.0:
            if quality == QUALITY_BEST:
                whisper_model = "large-v3"
            elif quality == QUALITY_FAST:
                whisper_model = "small"
            else:
                whisper_model = "large-v3-turbo"
        else:
            # Memory < 16GB, drop tier
            whisper_model = "small" if quality == QUALITY_FAST else "medium"

        if mlx_avail:
            whisper_backend = "mlx-whisper"
            whisper_compute = "fp16"
            whisper_device = "mps"
        else:
            whisper_backend = "faster-whisper"
            whisper_compute = "int8"
            whisper_device = "cpu"

    elif hw.backend == "cuda":
        sep_device = hw.device
        pitch_device = hw.device
        align_device = hw.device

        if hw.vram_or_ram_gb >= 10.0:
            whisper_backend = "faster-whisper"
            whisper_compute = "fp16"
            whisper_device = "cuda"
            sep_segment = None
            if quality == QUALITY_BEST:
                whisper_model = "large-v3"
            elif quality == QUALITY_FAST:
                whisper_model = "small"
            else:
                whisper_model = "large-v3"
        else:
            # VRAM < 10 GB
            whisper_backend = "faster-whisper"
            whisper_compute = "int8_float16"
            whisper_device = "cuda"
            sep_segment = 4
            if quality == QUALITY_BEST:
                whisper_model = "large-v3-turbo"
            elif quality == QUALITY_FAST:
                whisper_model = "small"
            else:
                whisper_model = "large-v3-turbo"

    else:
        # CPU
        sep_device = "cpu"
        pitch_device = "cpu"
        align_device = "cpu"
        sep_segment = 7
        whisper_backend = "faster-whisper"
        whisper_compute = "int8"
        whisper_device = "cpu"

        if quality == QUALITY_BEST and hw.vram_or_ram_gb >= 16.0:
            whisper_model = "medium"
        elif quality == QUALITY_FAST:
            whisper_model = "tiny"
        else:
            whisper_model = "small"

    # Separator selection
    separator = requested_separator or "htdemucs"

    # Pitch engine and CREPE model
    if requested_pitch_engine:
        pitch_engine = requested_pitch_engine.lower()
    else:
        pitch_engine = "pyin"

    if requested_crepe_model:
        crepe_model = requested_crepe_model.lower()
    else:
        if quality == QUALITY_FAST:
            crepe_model = "tiny"
        elif quality == QUALITY_BEST:
            crepe_model = "full"
        else:
            crepe_model = "full" if (hw.backend in ("mps", "cuda") and hw.vram_or_ram_gb >= 10.0) else "tiny"

    return ModelSelection(
        whisper_backend=whisper_backend,
        whisper_model=whisper_model,
        whisper_compute=whisper_compute,
        whisper_device=whisper_device,
        separator=separator,
        separator_device=sep_device,
        separator_segment=sep_segment,
        pitch_engine=pitch_engine,
        crepe_model=crepe_model,
        pitch_device=pitch_device,
        forced_aligner=align_device,
    )
