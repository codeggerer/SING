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
from karaoke.align_mms import (
    find_vowel_nucleus_from_char_spans,
    compute_vowel_nucleus_onset,
)
from karaoke.config import (
    BEAT_DUR_SEC,
    PAUSE_BREAK_THRESHOLD_SEC,
    LINE_MAX_WORDS,
    SONG_MEDIAN_MIN_MIDI,
    SONG_MEDIAN_MAX_MIDI,
    KEY_MIN_CONFIDENCE_FOR_SNAP,
    MIN_WORD_DUR_FOR_SPLIT,
)


def sec_to_beat(sec: float) -> int:
    """Converts seconds to 10 ms beats (BPM 1500)."""
    return int(round(sec / BEAT_DUR_SEC))


def is_monosyllable(word: str, lang: str = "de", duration: float = 0.5) -> bool:
    """
    Checks if a word is monosyllabic (1 syllable) in English or German.
    Enforces monosyllable protection (AGENTS.md rule 4):
    Words with duration < 0.28s, in MONOSYLLABLE_WORDS, or with phonetic count <= 1
    are monosyllabic and must never be split.
    """
    if duration < 0.28:
        return True
    from karaoke.lyrics_io import MONOSYLLABLE_WORDS, count_phonetic_syllables
    import re
    clean = re.sub(r'^[^\w]+|[^\w]+$', '', word).lower()
    if not clean or len(clean) <= 3:
        return True
    if clean in MONOSYLLABLE_WORDS:
        return True
    return count_phonetic_syllables(clean, lang=lang) <= 1


def syllabify_word(
    word: str,
    lang: str = "de",
    word_duration: float = 0.5,
) -> List[Dict[str, Any]]:
    """
    Splits a word into phonetic syllables with display and trailing hyphen/space formatting.
    Returns list of dicts:
    [
        {"display": "Fens-", "text": "Fens-", "word": "Fens-", "raw": "Fens", "is_last": False},
        {"display": "ter ", "text": "ter ", "word": "ter ", "raw": "ter", "is_last": True}
    ]
    """
    from karaoke.lyrics_io import split_syllables
    clean_w = word.strip()
    parts = split_syllables(clean_w, lang=lang, word_duration=word_duration)
    n = len(parts)
    if n <= 1:
        text = f"{clean_w} " if not (clean_w.endswith(" ") or clean_w.endswith("-")) else clean_w
        return [{"display": text, "text": text, "word": text, "raw": clean_w, "is_last": True}]

    res = []
    for i, p in enumerate(parts):
        is_last = (i == n - 1)
        disp = f"{p} " if is_last else f"{p}-"
        res.append({
            "display": disp,
            "text": disp,
            "word": disp,
            "raw": p,
            "is_last": is_last,
        })
    return res


def energy_guided_syllable_split(
    word: str,
    start: float,
    end: float,
    vocal_audio: Optional[np.ndarray] = None,
    sr: int = 16000,
    lang: str = "de",
    pitch_data: Optional[Dict[str, Any]] = None,
    search_window_sec: float = 0.120,
    is_last_in_phrase: bool = False,
    has_pause_after: bool = False,
) -> List[Dict[str, Any]]:
    """
    Phase 2.1: Energy-Guided Sub-Word Syllabification.
    When dividing a multi-syllable word across N phonetic syllables, inspects the RMS
    energy envelope E(t) = sqrt( (1/W) * sum_{k=0}^{W-1} x^2(t+k) ) and spectral flux.
    Vowels have high energy; plosives and unvoiced consonants appear as brief energy dips.
    Snaps syllable boundary markers to local minima of E(t) within a ±120ms search window
    around the phonetic estimate.
    """
    clean_w = word.strip()
    total_dur = max(0.030, end - start)

    # Monosyllable protection: words with duration < 0.28s or count <= 1 are NEVER split
    if is_monosyllable(clean_w, lang=lang, duration=total_dur) or total_dur < MIN_WORD_DUR_FOR_SPLIT:
        disp = f"{clean_w} " if not (clean_w.endswith(" ") or clean_w.endswith("-")) else clean_w
        note_s = compute_vowel_nucleus_onset(clean_w, start, end, pitch_data=pitch_data)
        return [{
            "word": disp,
            "text": disp,
            "start": round(start, 3),
            "note_start": round(max(start, note_s), 3),
            "end": round(end, 3),
            "is_syllable": True,
        }]

    from karaoke.lyrics_io import split_syllables
    syllables = split_syllables(clean_w, lang=lang, word_duration=total_dur)
    N = len(syllables)
    if N <= 1:
        disp = f"{clean_w} " if not (clean_w.endswith(" ") or clean_w.endswith("-")) else clean_w
        note_s = compute_vowel_nucleus_onset(clean_w, start, end, pitch_data=pitch_data)
        return [{
            "word": disp,
            "text": disp,
            "start": round(start, 3),
            "note_start": round(max(start, note_s), 3),
            "end": round(end, 3),
            "is_syllable": True,
        }]

    # Compute phonetic estimates based on vowel nucleus and onset consonant distribution
    import re
    vowels_re = re.compile(r'[aeiouyäöüAEIOUYÄÖÜ]')
    weights = []
    for s_idx, syl in enumerate(syllables):
        s_clean = syl.lower()
        has_vowel = bool(vowels_re.search(s_clean))
        base_w = 1.0 if has_vowel else 0.5
        onset_m = re.match(r'^[^aeiouyäöü]+', s_clean)
        onset_c = len(onset_m.group(0)) if onset_m else 0
        w = base_w + 0.15 * onset_c
        if s_idx == N - 1:
            w *= 1.20
        if (s_idx == N - 1) and (is_last_in_phrase or has_pause_after):
            w *= 1.20
        weights.append(w)

    tot_w = sum(weights) or 1.0
    norm_w = [w / tot_w for w in weights]

    phonetic_splits = []
    accum = start
    for i in range(N - 1):
        accum += total_dur * norm_w[i]
        phonetic_splits.append(accum)

    # Audio energy envelope extraction
    if vocal_audio is None and pitch_data:
        vocal_audio = pitch_data.get("audio")
        if "sr" in pitch_data:
            sr = int(pitch_data["sr"])

    rms = None
    flux = None
    chunk_t0 = 0.0

    if vocal_audio is not None and len(vocal_audio) > 0:
        is_full_track = (len(vocal_audio) > int((total_dur + 0.5) * sr) and start >= 0)
        hop_length = int(round(sr * 0.010))  # 10ms frame hop
        frame_length = 2 * hop_length        # 20ms frame window W

        if is_full_track:
            margin = 0.6
            w_s_samp = max(0, int(round((start - margin) * sr)))
            w_e_samp = min(len(vocal_audio), int(round((end + margin) * sr)))
            chunk = vocal_audio[w_s_samp:w_e_samp]
            chunk_t0 = w_s_samp / float(sr)
        else:
            chunk = vocal_audio
            chunk_t0 = start

        if len(chunk) >= frame_length:
            try:
                import librosa
                rms = librosa.feature.rms(y=chunk, frame_length=frame_length, hop_length=hop_length)[0]
                try:
                    flux = librosa.onset.onset_strength(y=chunk, sr=sr, hop_length=hop_length)
                except Exception:
                    flux = np.zeros_like(rms)
            except Exception:
                pad = frame_length - (len(chunk) % hop_length) if (len(chunk) % hop_length) != 0 else 0
                padded = np.pad(chunk, (0, pad))
                num_frames = (len(padded) - frame_length) // hop_length + 1
                strides = (padded.strides[0] * hop_length, padded.strides[0])
                frames = np.lib.stride_tricks.as_strided(
                    padded, shape=(num_frames, frame_length), strides=strides
                )
                rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12).astype(np.float32)
                flux = np.zeros_like(rms)
    elif pitch_data and "rms" in pitch_data:
        rms = pitch_data["rms"]
        chunk_t0 = 0.0
        flux = np.zeros_like(rms)

    snapped_splits = []
    prev_boundary = start
    for k in range(N - 1):
        t_phon = phonetic_splits[k]
        min_bound = prev_boundary + 0.030
        max_bound = end - 0.030 * (N - 1 - k)
        if min_bound >= max_bound:
            snapped_splits.append(min_bound)
            prev_boundary = min_bound
            continue

        if rms is not None and len(rms) > 0:
            # Search window: ±search_window_sec (default ±120ms) around phonetic estimate
            w_s_time = max(min_bound, t_phon - search_window_sec)
            w_e_time = min(max_bound, t_phon + search_window_sec)
            if w_e_time > w_s_time:
                f_start = max(0, int(round((w_s_time - chunk_t0) / 0.010)))
                f_end = min(len(rms) - 1, int(round((w_e_time - chunk_t0) / 0.010)))
                if f_end > f_start:
                    rms_win = rms[f_start:f_end + 1]
                    max_rms_win = float(np.max(rms_win))
                    min_rms_win = float(np.min(rms_win))
                    # Only snap if there is a real acoustic energy dip in the window (min 4% drop)
                    if max_rms_win > 1e-4 and (max_rms_win - min_rms_win) >= 0.04 * max_rms_win:
                        cost = rms_win

                        # Center of minimum valley / plateau of E(t)
                        min_c = float(np.min(cost))
                        span_c = float(np.max(cost)) - min_c
                        if span_c > 1e-6:
                            valley_mask = np.where(cost <= min_c + 0.10 * span_c)[0]
                            best_f_rel = int(round((valley_mask[0] + valley_mask[-1]) / 2.0))
                        else:
                            best_f_rel = int(np.argmin(cost))

                        best_f = f_start + best_f_rel
                        t_snapped = chunk_t0 + best_f * 0.010
                        t_snapped = max(min_bound, min(max_bound, t_snapped))
                        snapped_splits.append(t_snapped)
                        prev_boundary = t_snapped
                        continue

        t_snapped = max(min_bound, min(max_bound, t_phon))
        snapped_splits.append(t_snapped)
        prev_boundary = t_snapped

    result = []
    cur_t = start
    for s_idx, syl in enumerate(syllables):
        is_last = (s_idx == N - 1)
        s_end = end if is_last else snapped_splits[s_idx]
        s_dur = max(0.030, s_end - cur_t)
        actual_end = round(cur_t + s_dur, 3)
        disp = f"{syl} " if is_last else f"{syl}-"
        note_s = compute_vowel_nucleus_onset(syl, cur_t, actual_end, pitch_data=pitch_data)
        result.append({
            "word": disp,
            "text": disp,
            "start": round(cur_t, 3),
            "note_start": round(max(cur_t, note_s), 3),
            "end": actual_end,
            "is_syllable": True,
        })
        cur_t = actual_end

    return result


def build_word_notes(
    words: List[Dict[str, Any]],
    pitch_data: Dict[str, Any],
    lang: str = "de",
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
    key_info: Optional[Dict[str, Any]] = None,
    use_viterbi: bool = True,
    vocal_audio: Optional[np.ndarray] = None,
) -> List[Dict[str, Any]]:
    """
    Extracts structured notes and pause beats for each word/syllable.
    Uses Scale-Constrained Viterbi HMM Quantization (Phase 5) by default.
    """
    if vocal_audio is None and pitch_data:
        vocal_audio = pitch_data.get("audio")
    sr = int(pitch_data.get("sr", 16000)) if pitch_data else 16000

    if use_viterbi and pitch_data and ("midi" in pitch_data or "pitches" in pitch_data):
        from karaoke.quantizer import quantize_notes
        expanded_words = []
        for w in words:
            if w.get("is_syllable", False):
                expanded_words.append(w)
            else:
                raw_word = str(w.get("word", ""))
                w_start = float(w["start"])
                w_end = max(float(w["end"]), w_start + 0.030)
                syll_dicts = energy_guided_syllable_split(
                    raw_word,
                    w_start,
                    w_end,
                    vocal_audio=vocal_audio,
                    sr=sr,
                    lang=lang,
                    pitch_data=pitch_data,
                    is_last_in_phrase=bool(w.get("line_break_after")),
                )
                if len(syll_dicts) <= 1:
                    expanded_words.append(w)
                else:
                    for s_idx, s in enumerate(syll_dicts):
                        s_dict = {
                            "word": s["word"],
                            "text": s.get("text", s["word"]),
                            "start": s["start"],
                            "note_start": s.get("note_start", s["start"]),
                            "end": s["end"],
                            "char_spans": s.get("char_spans"),
                            "is_syllable": True,
                        }
                        if s_idx == len(syll_dicts) - 1:
                            if w.get("line_break_after"):
                                s_dict["line_break_after"] = True
                            if w.get("pause_beat") is not None:
                                s_dict["pause_beat"] = w["pause_beat"]
                        expanded_words.append(s_dict)

        try:
            return quantize_notes(
                expanded_words,
                pitch_data,
                key_info=key_info,
                lang=lang,
                basic_pitch_notes=basic_pitch_notes,
            )
        except Exception as e:
            print(f"⚠️ Viterbi-Quantisierung fehlgeschlagen ({e}), weiche auf Pass-1 aus...")
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
                if words[i-1].get("pause_beat") is not None:
                    raw_pb = int(words[i-1]["pause_beat"])
                    prev_b = sec_to_beat(prev_end)
                    curr_b = sec_to_beat(w_start)
                    if curr_b > prev_b + 1:
                        pause_beat = max(prev_b + 1, min(curr_b - 1, raw_pb))
                    else:
                        pause_beat = prev_b + 1
                else:
                    pause_sec_mid = prev_end + min(0.15, max(0.02, pause_sec / 2.0)) if pause_sec > 0.04 else prev_end + 0.01
                    pause_beat = sec_to_beat(pause_sec_mid)
                words_in_current_phrase = 0

        words_in_current_phrase += 1

        is_already_syllable = w.get("is_syllable", False)
        has_tilde_marker = "~" in raw_word

        if is_already_syllable:
            note_s = float(w.get("note_start", 0.0))
            if note_s <= 0.0 or note_s < w_start:
                note_s = compute_vowel_nucleus_onset(raw_word, w_start, w_end, char_spans=w.get("char_spans"), pitch_data=pitch_data)
            note_s = max(w_start, min(note_s, w_end - 0.030))

            # Check for deliberate melisma split on long syllables (>= 700ms) or rapid runs via HSMM
            melisma = detect_syllable_split(
                pitch_data,
                note_s,
                w_end,
                basic_pitch_notes=basic_pitch_notes,
                has_tilde=has_tilde_marker,
                fallback_pitch=prev_pitch_float,
                method="auto",
            )
            if melisma and len(melisma) >= 2:
                clean_text = raw_word.rstrip('~').rstrip('-').rstrip(' ')
                raw_notes = []
                for m_idx, (t0, t1, pf, pi) in enumerate(melisma):
                    n_start = note_s if m_idx == 0 else t0
                    txt = f"{clean_text}-" if m_idx == 0 else "~ "
                    raw_notes.append({
                        "start": t0,
                        "note_start": n_start,
                        "end": t1,
                        "pitch": pi,
                        "pitch_float": pf,
                        "text": txt,
                    })
                prev_pitch_float = melisma[-1][2]
            else:
                s_float, s_pitch = get_syllable_pitch(pitch_data, note_s, w_end, fallback_pitch=prev_pitch_float, return_float=True)
                prev_pitch_float = s_float
                raw_notes = [{"start": w_start, "note_start": note_s, "end": w_end, "pitch": s_pitch, "pitch_float": s_float, "text": raw_word}]

            word_notes_list.append({"pause_beat": pause_beat, "notes": raw_notes, "num_sylls": 1})
            continue

        # Derived syllables via energy-guided sub-word syllabification (Phase 2.1)
        syll_dicts = energy_guided_syllable_split(
            raw_word,
            w_start,
            w_end,
            vocal_audio=vocal_audio,
            sr=sr,
            lang=lang,
            pitch_data=pitch_data,
            is_last_in_phrase=(words_in_current_phrase >= LINE_MAX_WORDS),
        )
        num_sylls = len(syll_dicts)
        raw_notes = []

        if num_sylls == 1:
            note_s = float(syll_dicts[0].get("note_start", w_start))
            melisma = detect_syllable_split(
                pitch_data,
                note_s,
                w_end,
                basic_pitch_notes=basic_pitch_notes,
                has_tilde=has_tilde_marker,
                fallback_pitch=prev_pitch_float,
                method="auto",
            )
            if melisma and len(melisma) >= 2:
                clean_text = syll_dicts[0]['word'].strip().rstrip('-').rstrip('~')
                for m_idx, (t0, t1, pf, pi) in enumerate(melisma):
                    n_start = note_s if m_idx == 0 else t0
                    txt = f"{clean_text}-" if m_idx == 0 else "~ "
                    raw_notes.append({
                        "start": t0,
                        "note_start": n_start,
                        "end": t1,
                        "pitch": pi,
                        "pitch_float": pf,
                        "text": txt,
                    })
                prev_pitch_float = melisma[-1][2]
            else:
                p_float, p_int = get_syllable_pitch(pitch_data, note_s, w_end, fallback_pitch=prev_pitch_float, return_float=True)
                prev_pitch_float = p_float
                raw_notes.append({"start": w_start, "note_start": note_s, "end": w_end, "pitch": p_int, "pitch_float": p_float, "text": syll_dicts[0]["word"]})
        else:
            for s_idx, s_info in enumerate(syll_dicts):
                s_s = s_info["start"]
                s_e = s_info["end"]
                s_note_s = float(s_info.get("note_start", s_s))
                s_float, s_pitch = get_syllable_pitch(pitch_data, s_note_s, s_e, fallback_pitch=prev_pitch_float, return_float=True)
                prev_pitch_float = s_float
                raw_notes.append({"start": s_s, "note_start": s_note_s, "end": s_e, "pitch": s_pitch, "pitch_float": s_float, "text": s_info["word"]})

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
