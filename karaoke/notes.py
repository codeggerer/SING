"""
Note building, melisma processing, and tessitura/scale adaptation.
"""

from __future__ import annotations
from typing import List, Dict, Any, Optional, Set
import numpy as np

from karaoke.pitch import get_syllable_pitch, detect_melisma_pitches, snap_pitch_to_scale
from karaoke.config import (
    BEAT_DUR_SEC,
    PAUSE_BREAK_THRESHOLD_SEC,
    LINE_MAX_WORDS,
    SUBHARMONIC_P75_THRESHOLD,
    SUBHARMONIC_NOTE_THRESHOLD,
)


def sec_to_beat(sec: float) -> int:
    """Converts seconds to 10 ms beats (BPM 1500)."""
    return int(round(sec / BEAT_DUR_SEC))


def build_word_notes(
    words: List[Dict[str, Any]],
    pitch_data: Dict[str, Any],
    lang: str = "de",
) -> List[Dict[str, Any]]:
    """
    Pass 1: Extracts raw notes and pause beats for each word/syllable.
    Respects:
    - Provider syllables / aligned syllables
    - Phrase line breaks from providers or silence >= 0.6s / 8 words (Task 6)
    - Minimum duration 30ms (Task 4)
    """
    word_notes_list = []
    prev_pitch = 60
    words_in_current_phrase = 0

    for i, w in enumerate(words):
        w_start = float(w["start"])
        # Remove arbitrary clamps (Task 4): minimum 30ms duration
        w_end = max(float(w["end"]), w_start + 0.030)
        raw_word = w["word"]
        w_dur = w_end - w_start

        # Check line break conditions (Task 6)
        pause_beat = None
        if i > 0:
            prev_end = float(words[i-1]["end"])
            pause_sec = w_start - prev_end
            has_line_break_marker = bool(words[i-1].get("line_break_after", False))

            if has_line_break_marker or pause_sec >= PAUSE_BREAK_THRESHOLD_SEC or words_in_current_phrase >= LINE_MAX_WORDS:
                pause_sec_mid = prev_end + min(0.15, max(0.02, pause_sec / 2.0)) if pause_sec > 0.04 else prev_end + 0.01
                pause_beat = sec_to_beat(pause_sec_mid)
                words_in_current_phrase = 0

        words_in_current_phrase += 1

        is_already_syllable = w.get("is_syllable", False)
        if is_already_syllable:
            s_pitch = get_syllable_pitch(pitch_data, w_start, w_end, fallback_pitch=prev_pitch)
            prev_pitch = s_pitch
            raw_notes = [{"start": w_start, "end": w_end, "pitch": s_pitch, "text": raw_word}]
            word_notes_list.append({"pause_beat": pause_beat, "notes": raw_notes, "num_sylls": 1})
            continue

        # Derived syllables via Task 2 vowel nucleus distribution
        from karaoke.align import distribute_word_syllables
        syll_dicts = distribute_word_syllables(
            raw_word,
            w_start,
            w_end,
            lang=lang,
            is_last_in_phrase=(words_in_current_phrase >= LINE_MAX_WORDS),
        )
        num_sylls = len(syll_dicts)
        raw_notes = []

        if num_sylls == 1:
            melisma = detect_melisma_pitches(pitch_data, w_start, w_end)
            if melisma:
                (t0, t1, p1), (t2, t3, p2) = melisma[0], melisma[1]
                raw_notes.append({"start": t0, "end": t1, "pitch": p1, "text": f"{syll_dicts[0]['word'].strip()}-"})
                raw_notes.append({"start": t2, "end": t3, "pitch": p2, "text": "~ "})
            else:
                p = get_syllable_pitch(pitch_data, w_start, w_end, fallback_pitch=prev_pitch)
                raw_notes.append({"start": w_start, "end": w_end, "pitch": p, "text": syll_dicts[0]["word"]})
        else:
            for s_idx, s_info in enumerate(syll_dicts):
                s_s = s_info["start"]
                s_e = s_info["end"]
                s_pitch = get_syllable_pitch(pitch_data, s_s, s_e, fallback_pitch=prev_pitch)
                prev_pitch = s_pitch
                raw_notes.append({"start": s_s, "end": s_e, "pitch": s_pitch, "text": s_info["word"]})

        word_notes_list.append({"pause_beat": pause_beat, "notes": raw_notes, "num_sylls": num_sylls})

    return word_notes_list


def apply_subharmonic_recovery(word_notes_list: List[Dict[str, Any]]):
    """
    Pass 2: Global Tessitura Analysis & Subharmonic Octave Recovery.
    """
    all_raw_pitches = [n["pitch"] for wn in word_notes_list for n in wn["notes"] if n["pitch"] > 0]
    if all_raw_pitches:
        p75 = np.percentile(all_raw_pitches, 75)
        if p75 >= SUBHARMONIC_P75_THRESHOLD:
            print(f"🎯 Gesangslage erkannt: Hohe Stimmlage (75. Perzentil: {p75:.1f}). Korrigiere Subharmonische (+12 st)...")
            for wn in word_notes_list:
                for n in wn["notes"]:
                    if n["pitch"] <= SUBHARMONIC_NOTE_THRESHOLD:
                        n["pitch"] += 12


def apply_scale_snapping(word_notes_list: List[Dict[str, Any]], scale_pcs: Set[int]):
    """
    Pass 3: Scale Snapping (In-Key Tuning).
    """
    if not scale_pcs:
        return
    for wn in word_notes_list:
        for n in wn["notes"]:
            n["pitch"] = snap_pitch_to_scale(n["pitch"], scale_pcs)
