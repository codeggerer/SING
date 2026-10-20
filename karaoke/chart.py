"""
UltraStar Chart Generation & Formatting.
"""

from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Any, Optional

try:
    import librosa
except ImportError:
    librosa = None

from karaoke.config import (
    USTAR_BPM, BEAT_DUR_SEC, GAP, DEFAULT_GENRE,
    MIN_NOTE_DUR_BEATS, MIN_NOTE_GAP_BEATS,
)
from karaoke.notes import (
    sec_to_beat, build_word_notes, apply_subharmonic_recovery, apply_scale_snapping
)


def detect_display_bpm(audio_path: Path | str) -> int:
    """Estimates musical display BPM using librosa beat tracking."""
    print("📊 Berechne Display-BPM mit Librosa...")
    if librosa is None:
        return 120
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, duration=90)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        if hasattr(tempo, '__iter__'):
            tempo_val = float(tempo[0])
        else:
            tempo_val = float(tempo)
        if tempo_val < 65:
            tempo_val *= 2
        elif tempo_val > 190:
            tempo_val /= 2
        display_bpm = int(round(tempo_val))
        print(f"✅ Geschätztes Song-Tempo für Anzeige: {display_bpm} BPM")
        return display_bpm
    except Exception as e:
        print(f"⚠️ BPM-Schätzung fehlgeschlagen ({e}), Standard 120 BPM.")
        return 120


def generate_ultrastar_chart(
    words: List[Dict[str, Any]],
    pitch_data: Dict[str, Any],
    display_bpm: int,
    title: str,
    artist: str,
    output_txt_path: Path | str,
    lang: str = "de",
    key_info: Optional[Dict[str, Any]] = None,
) -> Path:
    """
    Builds and writes a complete UltraStar TXT score chart file.
    """
    print("\n" + "=" * 65)
    print("[4/4] 🎵 Erstellung der UltraStar TXT Datei mit Tonleiter & Oktav-Korrektur")
    print("=" * 65)

    output_txt_path = Path(output_txt_path).resolve()

    ultrastar_lines = []
    ultrastar_lines.append(f"#TITLE:{title}")
    ultrastar_lines.append(f"#ARTIST:{artist}")
    ultrastar_lines.append(f"#BPM:{USTAR_BPM}")
    ultrastar_lines.append(f"#REALBPM:{display_bpm}")
    ultrastar_lines.append(f"#GAP:{GAP}")
    ultrastar_lines.append(f"#LANGUAGE:{lang.upper()}")
    ultrastar_lines.append(f"#GENRE:{DEFAULT_GENRE}")
    if key_info and "key" in key_info:
        ultrastar_lines.append(f"#KEY:{key_info['key']}")

    scale_pcs = key_info["scale_pcs"] if (key_info and "scale_pcs" in key_info) else set()

    # Pass 1: Raw notes extraction for all words
    word_notes_list = build_word_notes(words, pitch_data, lang=lang)

    # Pass 2: Global Tessitura Analysis & Subharmonic Octave Recovery
    apply_subharmonic_recovery(word_notes_list)

    # Pass 3: Scale Snapping (In-Key Tuning)
    apply_scale_snapping(word_notes_list, scale_pcs)

    # Pass 4: Syllable Formatting, Note Preservation & Word Spacing
    last_end_beat = 0
    for wn in word_notes_list:
        if wn["pause_beat"] is not None:
            ultrastar_lines.append(f"- {wn['pause_beat']}")
            last_end_beat = max(last_end_beat, wn["pause_beat"])

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
            s_beat = sec_to_beat(note["start"])
            e_beat = sec_to_beat(note["end"])

            # Resolve overlaps only: guarantee at least MIN_NOTE_GAP_BEATS (1 beat = 10 ms)
            if last_end_beat > 0 and s_beat < last_end_beat + MIN_NOTE_GAP_BEATS:
                s_beat = last_end_beat + MIN_NOTE_GAP_BEATS

            # Minimum duration: MIN_NOTE_DUR_BEATS (3 beats = 30 ms)
            if e_beat < s_beat + MIN_NOTE_DUR_BEATS:
                e_beat = s_beat + MIN_NOTE_DUR_BEATS

            d_beat = max(MIN_NOTE_DUR_BEATS, e_beat - s_beat)
            last_end_beat = s_beat + d_beat

            ultrastar_lines.append(f": {s_beat} {d_beat} {s_pitch} {note['text']}")

    ultrastar_lines.append("E")

    with open(output_txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(ultrastar_lines) + "\n")

    print(f"🎉 UltraStar Datei erfolgreich gespeichert: {output_txt_path}")
    return output_txt_path
