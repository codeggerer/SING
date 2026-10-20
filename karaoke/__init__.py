"""
AI Karaoke Engine package.
"""

from karaoke.config import (
    USTAR_BPM, BEAT_DUR_SEC, GAP, DEFAULT_GENRE,
    DEFAULT_QUALITY, DEFAULT_PITCH_ENGINE, DEFAULT_CREPE_MODEL,
    PITCH_ENGINE_FCPE, PITCH_ENGINE_CREPE, PITCH_ENGINE_PYIN, PITCH_ENGINE_RMVPE,
)
from karaoke.hardware import (
    HardwareProfile, ModelSelection, detect_hardware, select_models, is_mlx_whisper_available
)
from karaoke.cache import StageCache, compute_audio_sha1
from karaoke.separate import separate_stems
from karaoke.lyrics_io import (
    MONOSYLLABLE_WORDS, count_phonetic_syllables, split_syllables,
    load_canonical_lyrics, transcribe_lyrics
)
from karaoke.pitch import (
    compute_audio_rms, detect_song_key, snap_pitch_to_scale, soft_snap_to_scale,
    track_f0, clean_f0, analyze_vocal_pitch, _analyze_pitch_crepe, _analyze_pitch_pyin,
    get_syllable_pitch, detect_melisma_pitches, detect_syllable_split, mask_background_regions
)
from karaoke.basicpitch_adapter import BasicPitchAdapter
from karaoke.notes import (
    sec_to_beat, build_word_notes, apply_global_octave_tessitura,
    apply_subharmonic_recovery, apply_scale_snapping
)
from karaoke.chart import (
    detect_display_bpm, generate_ultrastar_chart
)
from karaoke.pipeline import (
    KaraokeJob, run
)
from karaoke.debug_export import (
    export_debug_artifacts
)

__all__ = [
    "KaraokeJob",
    "run",
    "export_debug_artifacts",
    "HardwareProfile",
    "ModelSelection",
    "detect_hardware",
    "select_models",
    "is_mlx_whisper_available",
    "StageCache",
    "compute_audio_sha1",
    "separate_stems",
    "MONOSYLLABLE_WORDS",
    "count_phonetic_syllables",
    "split_syllables",
    "load_canonical_lyrics",
    "transcribe_lyrics",
    "compute_audio_rms",
    "detect_song_key",
    "snap_pitch_to_scale",
    "soft_snap_to_scale",
    "track_f0",
    "clean_f0",
    "analyze_vocal_pitch",
    "_analyze_pitch_crepe",
    "_analyze_pitch_pyin",
    "get_syllable_pitch",
    "detect_melisma_pitches",
    "detect_syllable_split",
    "mask_background_regions",
    "BasicPitchAdapter",
    "sec_to_beat",
    "build_word_notes",
    "apply_global_octave_tessitura",
    "apply_subharmonic_recovery",
    "apply_scale_snapping",
    "detect_display_bpm",
    "generate_ultrastar_chart",
    "USTAR_BPM",
    "BEAT_DUR_SEC",
    "GAP",
]
