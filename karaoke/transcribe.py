"""
karaoke/transcribe.py - Two-Step Whisper-to-MMS Pipeline (Breakthrough 1)

Implements Breakthrough 1 from TIER3_TIER4_NEURAL_OVERHAUL_PLAN.md:
- Eliminates the ~370ms onset lag and 1,919ms outlier stretching caused by
  Whisper cross-attention timestamps on singing audio.
- Step 1: Pre-filters audio with Silero VAD v5 to silence non-vocal sections and
  prevent instrumental hallucinations.
- Step 2: Uses Whisper Large-v3 solely for linguistic text extraction in text-only mode
  (word_timestamps=False, beam_size=5), completely discarding attention timestamps.
- Step 3: Routes recognized words directly into Meta MMS-FA CTC Trellis Forced Alignment
  for frame-level timing precision (15-20ms boundaries).
"""

from __future__ import annotations
import os
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Callable

import numpy as np

try:
    import torch
except ImportError:
    torch = None

from karaoke.align_mms import (
    MMSForcedAligner,
    clean_word_for_mms,
    load_audio_mono,
    distribute_word_syllables,
    snap_syllables_to_audio,
    prune_note_ends,
    forced_align_words,
)
from karaoke.vad import apply_vad_mask, detect_vocal_intervals, filter_hallucinations_vad
from karaoke.cache import StageCache
from karaoke.hardware import HardwareProfile, ModelSelection, detect_hardware, select_models


def build_whisper_initial_prompt(
    artist: str = "",
    title: str = "",
    language: str = "auto",
) -> Optional[str]:
    """
    Constructs an initial_prompt for Whisper conditioning containing artist,
    title, and language context (Phase 4.2).

    Conditioning Whisper with metadata biases the beam search towards the correct
    vocabulary, orthography, and phrase structure while preventing degenerate repetition.
    """
    clean_artist = (artist or "").strip()
    clean_title = (title or "").strip()

    if not clean_artist and not clean_title:
        return None

    if clean_artist and clean_title:
        meta = f"{clean_artist} - {clean_title}"
    else:
        meta = clean_artist or clean_title

    lang = (language or "auto").lower().strip()

    # German conditioning prompt (matches Master Plan Phase 4.2)
    if lang == "de" or (lang in ("auto", "") and any(c in meta.lower() for c in "äöüß")):
        return f"Songtext von {meta}. Korrekte Groß- und Kleinschreibung, Strophen und Refrain."
    elif lang == "en":
        return f"Lyrics of {meta}. Correct spelling, capitalization, verses and chorus."
    else:
        # Default prompt specified in Master Plan Phase 4.2
        return f"Songtext von {meta}. Korrekte Groß- und Kleinschreibung, Strophen und Refrain."


def transcribe_and_forced_align(
    vocals_wav_path: Path | str,
    language: str = "auto",
    device: str = "auto",
    pitch_data: Optional[Dict[str, Any]] = None,
    return_syllables: bool = False,
    whisper_model_name: str = "large-v3-turbo",
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
    artist: str = "",
    title: str = "",
    silence_threshold: float = 0.35,
    initial_prompt: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    Tier 4 Pure AI Fallback (Whisper ASR + MMS Forced Alignment):
    1. Pre-filters vocal audio with Silero VAD (Phase 4.1) to silence non-vocal frames (guitar solos).
    2. Runs Whisper in text-only mode conditioned on artist/title initial_prompt (Phase 4.2).
    3. Routes recognized text directly into Meta MMS-FA CTC Trellis for frame-level timing.
    4. Post-filters any remaining hallucinations outside vocal intervals.

    Args:
        vocals_wav_path: Path to isolated dry vocal stem.
        language: Language code ("auto", "de", "en", etc.).
        device: Device for inference ("auto", "cpu", "mps", "cuda").
        pitch_data: Optional F0 pitch dict for acoustic syllable boundary snapping.
        return_syllables: If True, returns phonetic syllable dicts snapped to audio.
                          If False, returns word-level dicts matching Section 1.2 spec.
        whisper_model_name: Whisper model size/name (default: "large-v3-turbo").
        progress_cb: Optional callback for progress streaming.
        artist: Known artist name for prompt conditioning.
        title: Known song title for prompt conditioning.
        silence_threshold: VAD silence sensitivity threshold (default: 0.35).
        initial_prompt: Explicit Whisper initial_prompt override.

    Returns:
        (aligned_items, detected_language)
    """
    vocals_path = Path(vocals_wav_path)
    if not vocals_path.exists():
        raise FileNotFoundError(f"Vocals file not found: {vocals_path}")

    if progress_cb:
        progress_cb("lyrics", 0.05, "Pre-filtering vocals with Silero VAD...")

    # Step 1: Pre-filter audio with Silero VAD to eliminate instrumental hallucinations (Phase 4.1)
    mask_res = apply_vad_mask(
        vocals_path,
        silence_threshold=silence_threshold,
        return_intervals=True,
    )
    if isinstance(mask_res, tuple) and len(mask_res) == 2:
        clean_vocals_path, speech_intervals = mask_res
    else:
        clean_vocals_path = mask_res
        speech_intervals = []

    # Step 2: Whisper Large-v3 in text-only mode (beam_size=5 for maximum linguistic accuracy)
    if progress_cb:
        progress_cb("lyrics", 0.20, f"Transcribing lyrics text with Whisper ({whisper_model_name})...")

    from faster_whisper import WhisperModel

    whisper_dev = "cpu"
    compute_type = "int8"
    whisper_model = None

    candidate_models = [whisper_model_name, "small", "base", "tiny"]
    for m in candidate_models:
        try:
            whisper_model = WhisperModel(m, device=whisper_dev, compute_type=compute_type)
            break
        except Exception:
            continue

    if whisper_model is None:
        raise RuntimeError(f"Could not initialize Faster-Whisper model from candidates: {candidate_models}")

    lang_param = None if language in ("auto", "", None) else language

    # Phase 4.2: Whisper initial_prompt metadata conditioning
    prompt = initial_prompt
    if prompt is None and (artist or title):
        prompt = build_whisper_initial_prompt(artist=artist, title=title, language=language)

    segments, info = whisper_model.transcribe(
        str(clean_vocals_path),
        initial_prompt=prompt,
        beam_size=5,
        word_timestamps=False,  # DISCARD WHISPER TIMESTAMPS COMPLETELY
        vad_filter=False,       # Already filtered by Silero VAD
        condition_on_previous_text=False,
        language=lang_param,
    )

    detected_lang = info.language or "en"
    segments_list = []
    for seg in segments:
        txt = seg.text.strip()
        if not txt:
            continue
        # Discard phantom tokens on pure silence where Whisper flags high no_speech_prob
        if getattr(seg, "no_speech_prob", 0.0) >= 0.60:
            continue
        # Phase 4.1 Zero Hallucinations: Discard hallucinated segments outside vocal intervals
        if speech_intervals:
            has_overlap = any(
                float(seg.end) > float(item["start"]) - 0.35 and float(seg.start) < float(item["end"]) + 0.35
                for item in speech_intervals
            )
            if not has_overlap:
                continue
        segments_list.append(seg)

    if not segments_list:
        return [], detected_lang

    raw_lines = [seg.text.strip() for seg in segments_list]

    if progress_cb:
        progress_cb("lyrics", 0.60, f"Aligning {len(raw_lines)} lines with Meta MMS-FA CTC Trellis...")

    # Step 3: Route Whisper's words into Meta MMS-FA Forced Aligner
    # Load audio mono 16kHz
    vocal_audio_16k, sr = load_audio_mono(clean_vocals_path, target_sr=16000)
    audio_dur = len(vocal_audio_16k) / sr
    waveform_tensor = torch.from_numpy(vocal_audio_16k).unsqueeze(0)

    aligner_dev = None if device == "auto" else device
    aligner = MMSForcedAligner.get_instance(device=aligner_dev)

    aligned_words: List[Dict[str, Any]] = []

    for seg_idx, seg in enumerate(segments_list):
        raw_words = seg.text.strip().split()
        if not raw_words:
            continue

        win_start = max(0.0, float(seg.start) - 0.5)
        win_end = min(audio_dur, float(seg.end) + 0.5)
        start_samp = int(win_start * sr)
        end_samp = int(win_end * sr)
        chunk = waveform_tensor[:, start_samp:end_samp]

        cleaned_pairs = [(r, clean_word_for_mms(r, lang=detected_lang)) for r in raw_words]
        valid_indices = [idx for idx, (r, c) in enumerate(cleaned_pairs) if len(c) > 0]

        aligned_for_seg = []
        if valid_indices:
            mms_words = [cleaned_pairs[idx][1] for idx in valid_indices]
            spans, ratio = aligner.align_chunk(chunk, mms_words)

            if spans and len(spans) == len(valid_indices):
                span_map = {idx: sp for idx, sp in zip(valid_indices, spans)}
                for idx, (raw_w, clean_w) in enumerate(cleaned_pairs):
                    sp = span_map.get(idx)
                    if sp and len(sp) > 0:
                        w_start = win_start + (sp[0].start * ratio)
                        w_end = win_start + (sp[-1].end * ratio)
                        char_spans = [
                            (ch, win_start + s.start * ratio, win_start + s.end * ratio)
                            for ch, s in zip(clean_w, sp)
                        ]
                        aligned_for_seg.append({
                            "word": raw_w,
                            "start": round(w_start, 3),
                            "end": round(max(w_start + 0.030, w_end), 3),
                            "confidence": 0.95,
                            "line_break_after": (idx == len(cleaned_pairs) - 1),
                            "char_spans": char_spans,
                        })
                    else:
                        prev_end = aligned_for_seg[-1]["end"] if aligned_for_seg else seg.start
                        aligned_for_seg.append({
                            "word": raw_w,
                            "start": round(prev_end, 3),
                            "end": round(prev_end + 0.030, 3),
                            "confidence": 0.50,
                            "line_break_after": (idx == len(cleaned_pairs) - 1),
                            "char_spans": None,
                        })

        if len(aligned_for_seg) < len(raw_words):
            # Fallback if alignment of this segment failed
            n_w = len(raw_words)
            seg_dur = max(0.2, float(seg.end) - float(seg.start))
            step = seg_dur / n_w
            aligned_for_seg = []
            for idx, raw_w in enumerate(raw_words):
                s = float(seg.start) + idx * step
                e = s + step * 0.9
                aligned_for_seg.append({
                    "word": raw_w,
                    "start": round(s, 3),
                    "end": round(e, 3),
                    "confidence": 0.50,
                    "line_break_after": (idx == n_w - 1),
                    "char_spans": None,
                })

        aligned_words.extend(aligned_for_seg)

    # Post-processing: enforce strict monotonicity
    for i in range(1, len(aligned_words)):
        if aligned_words[i]["start"] < aligned_words[i - 1]["end"]:
            aligned_words[i - 1]["end"] = max(
                aligned_words[i - 1]["start"] + 0.030,
                aligned_words[i]["start"],
            )

    # Phase 4.1 Post-filtering: zero hallucinations outside detected vocal intervals
    if speech_intervals:
        aligned_words = filter_hallucinations_vad(aligned_words, speech_intervals)

    # Breakthrough 4: Spectral transient attack snapping for word onsets
    try:
        from karaoke.transients import snap_word_onsets_to_transients
        aligned_words = snap_word_onsets_to_transients(
            aligned_words,
            audio=vocal_audio_16k,
            sr=sr,
            search_window_ms=35.0,
        )
    except Exception:
        pass

    if not return_syllables:
        if progress_cb:
            progress_cb("lyrics", 1.0, f"Aligned {len(aligned_words)} words via MMS CTC Trellis ({detected_lang})")
        return aligned_words, detected_lang

    # Syllables requested for direct note synthesis
    final_syllables: List[Dict[str, Any]] = []
    n_words = len(aligned_words)

    for w_idx, w_data in enumerate(aligned_words):
        is_last = w_data.get("line_break_after", False) or (w_idx == n_words - 1)
        sylls = distribute_word_syllables(
            word=w_data["word"],
            start=w_data["start"],
            end=w_data["end"],
            lang=detected_lang,
            char_spans=w_data.get("char_spans"),
            is_last_in_phrase=is_last,
            has_pause_after=is_last,
            vocal_audio=vocal_audio_16k,
            sr=sr,
        )
        if is_last and sylls:
            sylls[-1]["line_break_after"] = True
        final_syllables.extend(sylls)

    final_syllables = snap_syllables_to_audio(
        final_syllables,
        vocal_audio_16k,
        sr=sr,
        pitch_data=pitch_data,
    )
    final_syllables = prune_note_ends(final_syllables, pitch_data=pitch_data)

    if progress_cb:
        progress_cb("lyrics", 1.0, f"Transcribed & aligned {len(final_syllables)} notes ({detected_lang})")

    return final_syllables, detected_lang


def transcribe_lyrics_two_step(
    vocals_path: Path | str,
    pitch_data: Optional[Dict[str, Any]] = None,
    hardware_profile: Optional[HardwareProfile] = None,
    model_selection: Optional[ModelSelection] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
    artist: str = "",
    title: str = "",
    silence_threshold: float = 0.35,
    initial_prompt: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    Drop-in replacement for transcribe_lyrics in karaoke/lyrics_io.py using the
    Breakthrough 1 two-step decoupling pipeline with Phase 4 Whisper conditioning.
    """
    if stage_cache:
        cached = stage_cache.load_words()
        if cached is not None:
            words, lang = cached
            print(f"⚡ Verwende gecachte Whisper-Wort-Timestamps: {len(words)} Wörter (Sprache: {lang})")
            if progress_cb:
                progress_cb("lyrics", 1.0, f"Loaded {len(words)} words from cache")
            return words, lang

    if hardware_profile is None:
        hardware_profile = detect_hardware()
    if model_selection is None:
        model_selection = select_models(hardware_profile)

    whisper_model_name = getattr(model_selection, "whisper_model", "large-v3-turbo")
    device = getattr(hardware_profile, "device", "auto")

    words, detected_lang = transcribe_and_forced_align(
        vocals_wav_path=vocals_path,
        language="auto",
        device=device,
        pitch_data=pitch_data,
        return_syllables=True,
        whisper_model_name=whisper_model_name,
        progress_cb=progress_cb,
        artist=artist,
        title=title,
        silence_threshold=silence_threshold,
        initial_prompt=initial_prompt,
    )

    if stage_cache:
        stage_cache.save_words(words, detected_lang)

    return words, detected_lang
