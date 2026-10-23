"""
UltraStar Chart Generation & Formatting.
"""

from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

try:
    import librosa
except ImportError:
    librosa = None

from karaoke.config import (
    USTAR_BPM, BEAT_DUR_SEC, GAP, DEFAULT_GENRE,
    MIN_NOTE_DUR_BEATS, MIN_NOTE_GAP_BEATS,
)
from karaoke.notes import (
    sec_to_beat, build_word_notes, apply_global_octave_tessitura, apply_subharmonic_recovery, apply_scale_snapping
)
from karaoke.rhythm import (
    RhythmGrid, track_song_rhythm, snap_notes_to_beat_grid
)


def detect_song_rhythm(
    audio_path: Path | str,
    instrumental_path: Optional[Path | str] = None,
) -> RhythmGrid:
    """Estimates musical tempo, beat grid, and downbeat phase using librosa beat tracking."""
    target = instrumental_path if (instrumental_path and Path(instrumental_path).exists()) else audio_path
    return track_song_rhythm(target)


def detect_display_bpm(audio_path: Path | str) -> int:
    """Estimates musical display BPM using librosa beat tracking."""
    print("📊 Berechne Display-BPM mit Librosa...")
    grid = detect_song_rhythm(audio_path)
    display_bpm = int(round(grid.bpm))
    print(f"✅ Geschätztes Song-Tempo für Anzeige: {display_bpm} BPM (Confidence: {grid.confidence:.2f}, GAP: {grid.gap_ms} ms)")
    return display_bpm


def generate_ultrastar_chart(
    words: List[Dict[str, Any]],
    pitch_data: Dict[str, Any],
    display_bpm: int,
    title: str,
    artist: str,
    output_txt_path: Path | str,
    lang: str = "de",
    key_info: Optional[Dict[str, Any]] = None,
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
    return_word_notes: bool = False,
    vocals_path: Optional[Path | str] = None,
    speech_timestamps: Optional[List[Dict[str, float]]] = None,
    rhythm_grid: Optional[RhythmGrid] = None,
    bpm_mode: str = "millisecond",
    snap_grid: bool = True,
    snap_tolerance_sec: float = 0.030,
    instrumental_path: Optional[Path | str] = None,
) -> Path | Tuple[Path, List[Dict[str, Any]]]:
    """
    Builds and writes a complete UltraStar TXT score chart file.
    Supports soft musical beat grid snapping and configurable BPM modes (millisecond or native).
    """
    print("\n" + "=" * 65)
    print("[4/4] 🎵 Erstellung der UltraStar TXT Datei mit Tonleiter & Oktav-Korrektur")
    print("=" * 65)

    output_txt_path = Path(output_txt_path).resolve()

    # Track song rhythm if not provided and grid snapping or native BPM is requested
    if rhythm_grid is None and (snap_grid or bpm_mode != "millisecond"):
        audio_src = instrumental_path or vocals_path
        if audio_src and Path(audio_src).exists():
            try:
                rhythm_grid = detect_song_rhythm(audio_src)
            except Exception as e:
                print(f"⚠️ Rhythm tracking failed ({e}), continuing without grid.")

    # Apply Silero VAD acoustic breath breaks & hallucination filtering (Breakthrough 2)
    if speech_timestamps or vocals_path:
        try:
            from karaoke.vad import apply_acoustic_breath_breaks, filter_hallucinations_vad, detect_vocal_intervals
            if speech_timestamps is None and vocals_path:
                speech_timestamps = detect_vocal_intervals(vocals_path)
            if speech_timestamps:
                words = filter_hallucinations_vad(words, speech_timestamps)
                words = apply_acoustic_breath_breaks(words, speech_timestamps=speech_timestamps)
        except Exception as e:
            print(f"⚠️ Silero VAD breath break application failed ({e}), continuing with existing words.")

    # Configure timing resolution & header based on bpm_mode
    if bpm_mode == "native" and rhythm_grid is not None:
        chart_bpm = float(display_bpm)
        chart_gap = int(round(rhythm_grid.gap_ms))
        beat_dur_sec = 15.0 / chart_bpm
        gap_sec = chart_gap / 1000.0
        min_note_dur_beats = 1
        min_note_gap_beats = 1
    elif bpm_mode == "native_highres" and rhythm_grid is not None:
        chart_bpm = float(display_bpm * 4)
        chart_gap = int(round(rhythm_grid.gap_ms))
        beat_dur_sec = 15.0 / chart_bpm
        gap_sec = chart_gap / 1000.0
        min_note_dur_beats = 2
        min_note_gap_beats = 1
    else:  # "millisecond" fallback mode
        chart_bpm = USTAR_BPM
        chart_gap = GAP
        beat_dur_sec = BEAT_DUR_SEC
        gap_sec = GAP / 1000.0
        min_note_dur_beats = MIN_NOTE_DUR_BEATS
        min_note_gap_beats = MIN_NOTE_GAP_BEATS

    ultrastar_lines = []
    ultrastar_lines.append(f"#TITLE:{title}")
    ultrastar_lines.append(f"#ARTIST:{artist}")
    ultrastar_lines.append(f"#BPM:{int(chart_bpm) if chart_bpm.is_integer() else round(chart_bpm, 2)}")
    ultrastar_lines.append(f"#REALBPM:{display_bpm}")
    ultrastar_lines.append(f"#GAP:{chart_gap}")
    ultrastar_lines.append(f"#LANGUAGE:{lang.upper()}")
    ultrastar_lines.append(f"#GENRE:{DEFAULT_GENRE}")
    if key_info and "key" in key_info:
        ultrastar_lines.append(f"#KEY:{key_info['key']}")

    scale_pcs = key_info["scale_pcs"] if (key_info and "scale_pcs" in key_info) else set()
    key_confidence = float(key_info.get("confidence", 1.0)) if key_info else 1.0

    vocal_audio = pitch_data.get("audio") if pitch_data else None
    if vocal_audio is None and vocals_path and Path(vocals_path).exists():
        try:
            import librosa
            vocal_audio, _ = librosa.load(str(vocals_path), sr=16000, mono=True)
        except Exception:
            pass

    # Pass 1: Raw notes extraction for all words (Viterbi HMM Quantizer + Energy-Guided Syllables)
    word_notes_list = build_word_notes(
        words,
        pitch_data,
        lang=lang,
        basic_pitch_notes=basic_pitch_notes,
        key_info=key_info,
        vocal_audio=vocal_audio,
    )

    # Pass 2: Global Tessitura Analysis & Subharmonic Octave Recovery
    apply_global_octave_tessitura(word_notes_list)

    # Pass 3: Soft Scale Snapping (In-Key Tuning)
    apply_scale_snapping(word_notes_list, scale_pcs, confidence=key_confidence)

    # Pass 3.5: Soft Beat Grid Quantization (Issue #4)
    if snap_grid and rhythm_grid is not None:
        snap_notes_to_beat_grid(
            word_notes_list,
            rhythm_grid,
            tolerance_sec=snap_tolerance_sec,
        )

    # Pass 4: Syllable Formatting, Note Preservation & Word Spacing
    last_end_beat = 0
    for wn in word_notes_list:
        if wn["pause_beat"] is not None:
            if bpm_mode in ("native", "native_highres") and rhythm_grid is not None:
                p_sec = wn.get("pause_sec")
                if p_sec is None:
                    p_sec = wn["pause_beat"] * BEAT_DUR_SEC
                p_beat = max(last_end_beat + 1, int(round((p_sec - gap_sec) / beat_dur_sec)))
            else:
                p_beat = wn["pause_beat"]
            ultrastar_lines.append(f"- {p_beat}")
            last_end_beat = max(last_end_beat, p_beat)

        # Note Preservation Rule:
        # Multi-syllable words (num_sylls > 1) MUST PRESERVE each distinct syllable note
        # Only merge if a 1-syllable word produced multiple identical pieces.
        if wn["num_sylls"] > 1:
            active_notes = wn["notes"]
        else:
            active_notes = []
            for r_note in wn["notes"]:
                if active_notes and active_notes[-1]["pitch"] == r_note["pitch"]:
                    prev_n = active_notes[-1]
                    prev_n["end"] = r_note["end"]
                    prev_text = prev_n["text"].rstrip('-').rstrip(' ')
                    r_text = r_note["text"].lstrip('~').lstrip(' ')
                    prev_n["text"] = f"{prev_text}{r_text}"
                else:
                    active_notes.append(r_note)

        # Note Formatting, Overlap Resolution & Minimum Timing (PLAN.md Phase 4 Task 4)
        for note_idx, note in enumerate(active_notes):
            s_pitch = note["pitch"]
            note_start_sec = float(note.get("note_start", note["start"]))
            note_end_sec = float(note["end"])

            s_beat = int(round((note_start_sec - gap_sec) / beat_dur_sec))
            e_beat = int(round((note_end_sec - gap_sec) / beat_dur_sec))

            # Resolve overlaps only: guarantee at least min_note_gap_beats
            if last_end_beat > 0 and s_beat < last_end_beat + min_note_gap_beats:
                s_beat = last_end_beat + min_note_gap_beats

            # Minimum duration: min_note_dur_beats
            if e_beat < s_beat + min_note_dur_beats:
                e_beat = s_beat + min_note_dur_beats

            d_beat = max(min_note_dur_beats, e_beat - s_beat)
            last_end_beat = s_beat + d_beat

            ultrastar_lines.append(f": {s_beat} {d_beat} {s_pitch} {note['text']}")

    ultrastar_lines.append("E")

    with open(output_txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(ultrastar_lines) + "\n")

    print(f"🎉 UltraStar Datei erfolgreich gespeichert: {output_txt_path}")
    if return_word_notes:
        return output_txt_path, word_notes_list
    return output_txt_path
