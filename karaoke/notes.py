"""
Note building, melisma processing, and tessitura/scale adaptation (PLAN.md Phase 5).
"""

from __future__ import annotations
from typing import List, Dict, Any, Optional, Set
import numpy as np

from karaoke.pitch import (
    get_syllable_pitch,
    detect_syllable_split,
    soft_snap_to_scale,
    snap_pitch_to_scale,
)
from karaoke.config import (
    BEAT_DUR_SEC,
    PAUSE_BREAK_THRESHOLD_SEC,
    LINE_MAX_WORDS,
    SONG_MEDIAN_MIN_MIDI,
    SONG_MEDIAN_MAX_MIDI,
    KEY_MIN_CONFIDENCE_FOR_SNAP,
)


def sec_to_beat(sec: float) -> int:
    """Converts seconds to 10 ms beats (BPM 1500)."""
    return int(round(sec / BEAT_DUR_SEC))


def build_word_notes(
    words: List[Dict[str, Any]],
    pitch_data: Dict[str, Any],
    lang: str = "de",
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Pass 1: Extracts raw notes and pause beats for each word/syllable.
    Respects:
    - Provider syllables / aligned syllables
    - Phrase line breaks from providers or silence >= 0.6s / 8 words
    - Minimum duration 30ms
    - Change-point step detector for melisma (Fix for P2: dur >= 500ms, plateaus >= 150ms, diff >= 2st)
    - Unvoiced syllable pitch inheritance from neighbor in same phrase
    """
    word_notes_list = []
    prev_pitch_float = 60.0
    words_in_current_phrase = 0

    for i, w in enumerate(words):
        w_start = float(w["start"])
        # Minimum 30ms duration
        w_end = max(float(w["end"]), w_start + 0.030)
        raw_word = w["word"]
        w_dur = w_end - w_start

        # Check line break conditions
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
        has_tilde_marker = "~" in raw_word or raw_word.endswith("-")

        if is_already_syllable:
            # Check for deliberate melisma split on long syllables (>= 500ms)
            melisma = detect_syllable_split(
                pitch_data,
                w_start,
                w_end,
                basic_pitch_notes=basic_pitch_notes,
                has_tilde=has_tilde_marker,
                fallback_pitch=prev_pitch_float,
            )
            if melisma:
                (t0, t1, pf1, pi1), (t2, t3, pf2, pi2) = melisma[0], melisma[1]
                prev_pitch_float = pf2
                clean_text = raw_word.rstrip('~').rstrip('-').rstrip(' ')
                raw_notes = [
                    {"start": t0, "end": t1, "pitch": pi1, "pitch_float": pf1, "text": f"{clean_text}-"},
                    {"start": t2, "end": t3, "pitch": pi2, "pitch_float": pf2, "text": "~ "},
                ]
            else:
                s_float, s_pitch = get_syllable_pitch(pitch_data, w_start, w_end, fallback_pitch=prev_pitch_float, return_float=True)
                prev_pitch_float = s_float
                raw_notes = [{"start": w_start, "end": w_end, "pitch": s_pitch, "pitch_float": s_float, "text": raw_word}]

            word_notes_list.append({"pause_beat": pause_beat, "notes": raw_notes, "num_sylls": 1})
            continue

        # Derived syllables via vowel nucleus distribution
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
            melisma = detect_syllable_split(
                pitch_data,
                w_start,
                w_end,
                basic_pitch_notes=basic_pitch_notes,
                has_tilde=has_tilde_marker,
                fallback_pitch=prev_pitch_float,
            )
            if melisma:
                (t0, t1, pf1, pi1), (t2, t3, pf2, pi2) = melisma[0], melisma[1]
                prev_pitch_float = pf2
                clean_text = syll_dicts[0]['word'].strip().rstrip('-').rstrip('~')
                raw_notes.append({"start": t0, "end": t1, "pitch": pi1, "pitch_float": pf1, "text": f"{clean_text}-"})
                raw_notes.append({"start": t2, "end": t3, "pitch": pi2, "pitch_float": pf2, "text": "~ "})
            else:
                p_float, p_int = get_syllable_pitch(pitch_data, w_start, w_end, fallback_pitch=prev_pitch_float, return_float=True)
                prev_pitch_float = p_float
                raw_notes.append({"start": w_start, "end": w_end, "pitch": p_int, "pitch_float": p_float, "text": syll_dicts[0]["word"]})
        else:
            for s_idx, s_info in enumerate(syll_dicts):
                s_s = s_info["start"]
                s_e = s_info["end"]
                s_float, s_pitch = get_syllable_pitch(pitch_data, s_s, s_e, fallback_pitch=prev_pitch_float, return_float=True)
                prev_pitch_float = s_float
                raw_notes.append({"start": s_s, "end": s_e, "pitch": s_pitch, "pitch_float": s_float, "text": s_info["word"]})

        word_notes_list.append({"pause_beat": pause_beat, "notes": raw_notes, "num_sylls": num_sylls})

    return word_notes_list


def apply_global_octave_tessitura(word_notes_list: List[Dict[str, Any]]) -> None:
    """
    PLAN.md Phase 5.5: Delete the p75 >= 64 -> +12 hack.
    Octave handling now lives in contour continuity repair (clean_f0).
    As a last global check: if median MIDI of the whole song is < 45 or > 84,
    shift by whole octaves.
    """
    all_raw_pitches = [
        n["pitch"] for wn in word_notes_list
        for n in wn["notes"]
        if n.get("pitch") is not None and not np.isnan(n["pitch"]) and n["pitch"] > 0
    ]
    if not all_raw_pitches:
        return

    med = float(np.median(all_raw_pitches))
    shift = 0
    while med + shift < SONG_MEDIAN_MIN_MIDI:
        shift += 12
    while med + shift > SONG_MEDIAN_MAX_MIDI:
        shift -= 12

    if shift != 0:
        print(f"🌍 Globale Gesangslagen-Verschiebung: Median {med:.1f} um {shift:+d} Halbtöne angepasst.")
        for wn in word_notes_list:
            for n in wn["notes"]:
                if n.get("pitch") is not None and not np.isnan(n["pitch"]) and n["pitch"] > 0:
                    n["pitch"] += shift
                    if "pitch_float" in n:
                        n["pitch_float"] += shift


def apply_subharmonic_recovery(word_notes_list: List[Dict[str, Any]]):
    """
    Backward-compatible alias for apply_global_octave_tessitura.
    """
    apply_global_octave_tessitura(word_notes_list)


def apply_scale_snapping(
    word_notes_list: List[Dict[str, Any]],
    scale_pcs: Set[int],
    confidence: float = 1.0,
):
    """
    Pass 3: Soft Scale Snapping (PLAN.md Phase 5.5).
    Replaces hard snapping:
    - No snap when confidence < 0.60
    - Snaps only if |pitch_float - nearest_scale_tone| <= 0.35 st
    """
    if not scale_pcs:
        return

    for wn in word_notes_list:
        for n in wn["notes"]:
            p_float = n.get("pitch_float", float(n["pitch"]))
            n["pitch"] = soft_snap_to_scale(p_float, scale_pcs, confidence=confidence)
