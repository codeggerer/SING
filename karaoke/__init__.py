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
from karaoke.separate_roformer import separate_mel_band_roformer
from karaoke.lyrics_io import (
    MONOSYLLABLE_WORDS, count_phonetic_syllables, split_syllables,
    load_canonical_lyrics, transcribe_lyrics, expand_words_with_energy_syllables,
)
from karaoke.pitch import (
    compute_audio_rms, detect_song_key, snap_pitch_to_scale, soft_snap_to_scale,
    detect_key_from_pitch_histogram, detect_key_from_pitches,
    track_f0, clean_f0, analyze_vocal_pitch, _analyze_pitch_crepe, _analyze_pitch_pyin,
    get_syllable_pitch, detect_melisma_pitches, detect_syllable_split, mask_background_regions,
    apply_harmonic_octave_continuity_filter,
    viterbi_decode_notes_hsmm, detect_syllable_split_hsmm,
)
from karaoke.basicpitch_adapter import BasicPitchAdapter
from karaoke.notes import (
    sec_to_beat, build_word_notes, apply_global_octave_tessitura,
    apply_subharmonic_recovery, apply_scale_snapping, energy_guided_syllable_split,
)
from karaoke.chart import (
    detect_display_bpm, detect_song_rhythm, generate_ultrastar_chart
)
from karaoke.pipeline import (
    KaraokeJob, run
)
from karaoke.debug_export import (
    export_debug_artifacts
)
from karaoke.sync import (
    SyncResult,
    align_audio_gap,
    compute_audio_lag,
    synthesize_chart_melody,
    update_ultrastar_gap,
)
from karaoke.align_mms import (
    MMSForcedAligner,
    clean_word_for_mms,
    clean_raw_lyrics_lines,
    spell_number,
    load_mms_pipeline,
    forced_align_words,
    forced_align_words_vad_islands,
    detect_vocal_islands,
    segment_lyrics_into_stanzas,
    VocalIsland,
    GERMAN_SLANG_MAP,
    ENGLISH_SLANG_MAP,
    align_plain_lyrics_mms,
    align_lyrics_doc_mms,
    align_whisper_words_mms,
    find_vowel_nucleus_from_char_spans,
    compute_vowel_nucleus_onset,
)
from karaoke.pitch_neural import (
    track_f0_fcpe,
    track_f0_rmvpe,
    track_f0_neural,
)
from karaoke.quantizer import (
    quantize_notes,
    quantize_syllable_notes_in_key,
    snap_to_scale,
    ViterbiHMMQuantizer,
    compute_pitch_class_profile,
    detect_key_from_pcp,
    analyze_tessitura,
    detect_melisma_in_syllable,
)
from karaoke.syllables_acoustic import (
    slice_word_syllables_acoustically,
    slice_words_acoustically,
    is_monosyllable,
    syllabify_word,
)
from karaoke.vad import (
    load_silero_vad,
    detect_vocal_intervals,
    extract_speech_timestamps,
    calculate_acoustic_line_breaks,
    apply_vad_mask,
    apply_acoustic_breath_breaks,
    filter_hallucinations_vad,
)
from karaoke.transcribe import (
    build_whisper_initial_prompt,
    transcribe_and_forced_align,
    transcribe_lyrics_two_step,
)
from karaoke.transients import (
    snap_onset_to_spectral_transient,
    snap_word_onsets_to_transients,
    snap_syllables_to_transients,
    compute_transient_onset_envelope,
)
from karaoke.rhythm import (
    RhythmGrid,
    track_song_rhythm,
    snap_onset_to_grid,
    snap_notes_to_beat_grid,
)

__all__ = [
    "KaraokeJob",
    "run",
    "export_debug_artifacts",
    "SyncResult",
    "align_audio_gap",
    "compute_audio_lag",
    "synthesize_chart_melody",
    "update_ultrastar_gap",
    "HardwareProfile",
    "ModelSelection",
    "detect_hardware",
    "select_models",
    "is_mlx_whisper_available",
    "StageCache",
    "compute_audio_sha1",
    "separate_stems",
    "separate_mel_band_roformer",
    "MONOSYLLABLE_WORDS",
    "count_phonetic_syllables",
    "split_syllables",
    "load_canonical_lyrics",
    "transcribe_lyrics",
    "compute_audio_rms",
    "detect_song_key",
    "detect_key_from_pitch_histogram",
    "detect_key_from_pitches",
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
    "viterbi_decode_notes_hsmm",
    "detect_syllable_split_hsmm",
    "mask_background_regions",
    "apply_harmonic_octave_continuity_filter",
    "BasicPitchAdapter",
    "sec_to_beat",
    "build_word_notes",
    "apply_global_octave_tessitura",
    "apply_subharmonic_recovery",
    "apply_scale_snapping",
    "detect_display_bpm",
    "detect_song_rhythm",
    "generate_ultrastar_chart",
    "USTAR_BPM",
    "BEAT_DUR_SEC",
    "GAP",
    "MMSForcedAligner",
    "clean_word_for_mms",
    "clean_raw_lyrics_lines",
    "spell_number",
    "load_mms_pipeline",
    "forced_align_words",
    "forced_align_words_vad_islands",
    "detect_vocal_islands",
    "segment_lyrics_into_stanzas",
    "VocalIsland",
    "GERMAN_SLANG_MAP",
    "ENGLISH_SLANG_MAP",
    "align_plain_lyrics_mms",
    "align_lyrics_doc_mms",
    "align_whisper_words_mms",
    "find_vowel_nucleus_from_char_spans",
    "compute_vowel_nucleus_onset",
    "track_f0_fcpe",
    "track_f0_rmvpe",
    "track_f0_neural",
    "quantize_notes",
    "quantize_syllable_notes_in_key",
    "snap_to_scale",
    "ViterbiHMMQuantizer",
    "compute_pitch_class_profile",
    "detect_key_from_pcp",
    "analyze_tessitura",
    "detect_melisma_in_syllable",
    "slice_word_syllables_acoustically",
    "slice_words_acoustically",
    "is_monosyllable",
    "syllabify_word",
    "load_silero_vad",
    "detect_vocal_intervals",
    "extract_speech_timestamps",
    "calculate_acoustic_line_breaks",
    "apply_vad_mask",
    "apply_acoustic_breath_breaks",
    "filter_hallucinations_vad",
    "build_whisper_initial_prompt",
    "transcribe_and_forced_align",
    "transcribe_lyrics_two_step",
    "snap_onset_to_spectral_transient",
    "snap_word_onsets_to_transients",
    "snap_syllables_to_transients",
    "compute_transient_onset_envelope",
    "RhythmGrid",
    "track_song_rhythm",
    "snap_onset_to_grid",
    "snap_notes_to_beat_grid",
]
