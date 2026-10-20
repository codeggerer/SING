"""
Note building, melisma processing, and tessitura/scale adaptation.
"""

from __future__ import annotations
from typing import List, Dict, Any, Optional, Set
import numpy as np

from karaoke.pitch import get_syllable_pitch, detect_melisma_pitches, snap_pitch_to_scale
from karaoke.lyrics_io import split_syllables
from karaoke.config import (
    BEAT_DUR_SEC, PAUSE_BEAT_THRESHOLD_SEC, MIN_WORD_DUR_CLAMP,
    SUBHARMONIC_P75_THRESHOLD, SUBHARMONIC_NOTE_THRESHOLD
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
    Pass 1: Extracts raw notes and pause beats for each word.
    """
    word_notes_list = []
    prev_pitch = 60

    for i, w in enumerate(words):
        w_start = w["start"]
        w_end = max(w["end"], w_start + MIN_WORD_DUR_CLAMP)
        raw_word = w["word"]
        w_dur = w_end - w_start

        pause_beat = None
        if i > 0:
            pause_sec = w_start - words[i-1]["end"]
            if pause_sec > PAUSE_BEAT_THRESHOLD_SEC:
                pause_beat = sec_to_beat(words[i-1]["end"] + 0.15)

        is_already_syllable = w.get("is_syllable", False)
        if is_already_syllable:
            s_pitch = get_syllable_pitch(pitch_data, w_start, w_end, fallback_pitch=prev_pitch)
            prev_pitch = s_pitch
            raw_notes = [{"start": w_start, "end": w_end, "pitch": s_pitch, "text": raw_word}]
            word_notes_list.append({"pause_beat": pause_beat, "notes": raw_notes, "num_sylls": 1})
            continue

        syllables = split_syllables(raw_word, lang=lang, word_duration=w_dur)
        num_sylls = len(syllables)
        raw_notes = []

        if num_sylls == 1:
            melisma = detect_melisma_pitches(pitch_data, w_start, w_end)
            if melisma:
                (t0, t1, p1), (t2, t3, p2) = melisma[0], melisma[1]
                raw_notes.append({"start": t0, "end": t1, "pitch": p1, "text": f"{syllables[0]}-"})
                raw_notes.append({"start": t2, "end": t3, "pitch": p2, "text": "~ "})
            else:
                p = get_syllable_pitch(pitch_data, w_start, w_end, fallback_pitch=prev_pitch)
                raw_notes.append({"start": w_start, "end": w_end, "pitch": p, "text": f"{syllables[0]} "})
        else:
            dur_per_syl = w_dur / num_sylls
            for s_idx, syl in enumerate(syllables):
                s_start = w_start + (s_idx * dur_per_syl)
                s_end = s_start + dur_per_syl
                s_pitch = get_syllable_pitch(pitch_data, s_start, s_end, fallback_pitch=prev_pitch)
                prev_pitch = s_pitch
                is_last = (s_idx == num_sylls - 1)
                text_part = f"{syl} " if is_last else f"{syl}-"
                raw_notes.append({"start": s_start, "end": s_end, "pitch": s_pitch, "text": text_part})

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
