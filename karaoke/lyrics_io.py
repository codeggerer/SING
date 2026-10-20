"""
Lyrics & Syllables I/O for AI Karaoke Pipeline.
Includes:
- Phonetic Syllable Engine & Monosyllable Protection (English & German)
- Canonical LyricsDoc loading & validation (Phase 2 integration)
- Dual Whisper Transcription (Apple MLX Whisper & Faster-Whisper)
"""

from __future__ import annotations
import os
import re
import sys
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple, Callable

from karaoke.hardware import HardwareProfile, ModelSelection, detect_hardware, select_models, is_mlx_whisper_available
from karaoke.cache import StageCache
from karaoke.config import MIN_WORD_DUR_FOR_SPLIT


# ==============================================================================
# 1. Phonetic Syllable Engine & Monosyllable Protection
# ==============================================================================

MONOSYLLABLE_WORDS = {
    # English silent-e and common monosyllabic words
    'dance', 'danced', 'taste', 'tasted', 'breathe', 'breathed', 'space', 'make', 'makes',
    'love', 'loves', 'loved', 'live', 'lives', 'lived', 'life', 'time', 'times',
    'home', 'homes', 'hope', 'hopes', 'hoped', 'take', 'takes', 'took', 'like', 'likes', 'liked',
    'white', 'name', 'names', 'named', 'game', 'games', 'cause', 'caused', 'done', 'some', 'come', 'comes',
    'leave', 'leaves', 'please', 'pleased', 'peace', 'piece', 'sense', 'house',
    'voice', 'choice', 'price', 'smile', 'smiled', 'guide', 'ride', 'side', 'tide', 'wide',
    'close', 'closed', 'rose', 'nose', 'chose', 'broke', 'spoke', 'smoke', 'joke', 'cute', 'mute',
    'rule', 'rules', 'ruled', 'heart', 'hearts', 'straight', 'night', 'nights', 'light', 'lights',
    'right', 'rights', 'bright', 'fight', 'black', 'blue', 'green', 'through', 'thought',
    'friend', 'friends', 'blood', 'flood', 'build', 'built', 'guess', 'sound', 'sounds', 'world', 'words',
    'great', 'break', 'bread', 'dead', 'head', 'sweet', 'street', 'dream', 'dreams', 'dreamed',
    'stream', 'scream', 'sleep', 'deep', 'keep', 'feel', 'feels', 'felt', 'free', 'sea', 'see', 'seen',
    'give', 'gave', 'given', 'have', 'has', 'had', 'find', 'found', 'mind', 'kind', 'blind', 'sign',
    'sing', 'sang', 'sung', 'song', 'songs', 'ring', 'bring', 'brought', 'catch', 'caught', 'teach',
    'beat', 'club', 'vibe', 'real', 'fake', 'hype', 'flow', 'star', 'drop', 'high', 'down', 'fly',
    'shine', 'rain', 'train', 'pain', 'gain', 'wait', 'late', 'fate', 'date', 'state', 'rate',

    # German monosyllabic words and contractions
    'ein', 'eins', 'aus', 'auf', 'aufs', 'durch', 'für', 'fürs', 'mit', 'nach', 'vom', 'von', 'zum', 'zur', 'zu',
    'nicht', 'nichts', 'noch', 'doch', 'nur', 'schon', 'schön', 'gut', 'sehr', 'mehr', 'wer', 'wie', 'wo',
    'was', 'wann', 'war', 'wahr', 'seh', 'sehn', 'seht', 'sieht', 'sah', 'geh', 'gehn', 'geht', 'ging',
    'steh', 'stehn', 'steht', 'stand', 'traum', 'nacht', 'tag', 'licht', 'blick', 'glück', 'schmerz',
    'herz', 'hand', 'kopf', 'welt', 'zeit', 'raum', 'lied', 'ton', 'klang', 'wort', 'sinn',
    'brand', 'wind', 'meer', 'see', 'hab', 'habs', 'hast', 'hat', 'hatte', 'bist', 'ist', 'sind',
    'warst', 'waren', 'gibt', 'gibts', 'nehm', 'nimmt', 'sag', 'sagt', 'denk', 'denkt', 'hör', 'hört',
    'spiel', 'spielt', 'kann', 'kannst', 'muss', 'musst', 'will', 'willst', 'soll', 'sollt', 'darf', 'darfst'
}


def count_phonetic_syllables(word: str, lang: str = "de") -> int:
    """
    Returns the phonetic syllable count for a word in English or German.
    Ensures that 1-syllable words with silent vowels or diphthongs are never over-counted.
    """
    clean = re.sub(r'^[^\w]+|[^\w]+$', '', word).lower()
    if not clean:
        return 1
    if len(clean) <= 3:
        return 1
    if clean in MONOSYLLABLE_WORDS:
        return 1

    if lang.startswith("de"):
        # German diphthongs / vowel digraphs that count as 1 vowel sound:
        # ei, ey, ai, ay, eu, äu, au, ie
        temp = re.sub(r'(?:ei|ey|ai|ay|eu|äu|au|ie)', 'V', clean)
        # German contractions with silent 'e' or elision: 'ehn$' -> V
        temp = re.sub(r'ehn$', 'V', temp)
        vowels = re.findall(r'[aeiouyäöüV]', temp)
        return max(1, len(vowels))
    else:
        # English phonetic rules:
        temp = clean
        # Handle trailing silent e
        if temp.endswith('e') and not temp.endswith('le') and not temp.endswith('ee') and len(temp) > 3:
            temp = temp[:-1]
        elif temp.endswith('ed') and not (temp.endswith('ted') or temp.endswith('ded')):
            temp = temp[:-2]
        elif temp.endswith('es') and not any(temp.endswith(s) for s in ['ses', 'zes', 'ches', 'shes', 'xes']):
            temp = temp[:-1]

        # English diphthongs / digraphs / trigraphs that form a single syllable sound:
        temp = re.sub(r'(?:eau|iou|ai|ay|ea|ee|ei|ey|oa|oe|oi|oo|ou|oy|au|aw|ew|igh|eigh|ought|aught|ui)', 'V', temp)
        vowels = re.findall(r'[aeiouyV]', temp)
        return max(1, len(vowels))


def split_syllables(word: str, lang: str = "de", word_duration: float = 0.5) -> List[str]:
    """
    Splits a word into true phonetic syllables for singing.
    - If the word is phonetically 1 syllable or duration < 0.28s, returns [word].
    - Otherwise, uses pyphen hyphenation constrained by the phonetic syllable count,
      or sonority vowel splitting.
    """
    clean_word = re.sub(r'^[^\w]+|[^\w]+$', '', word)
    if not clean_word:
        return [word]

    # Monosyllable protection: words shorter than 0.28s or with count <= 1 are NEVER split
    if word_duration < MIN_WORD_DUR_FOR_SPLIT or count_phonetic_syllables(clean_word, lang) <= 1:
        return [word]

    target_syllables = count_phonetic_syllables(clean_word, lang)
    if target_syllables <= 1:
        return [word]

    # Try Pyphen dictionary
    parts = None
    try:
        import pyphen
        pyphen_lang = 'de_DE' if lang.startswith('de') else ('en_US' if lang.startswith('en') else 'es_ES')
        dic = pyphen.Pyphen(lang=pyphen_lang)
        hyphenated = dic.inserted(clean_word)
        if '-' in hyphenated:
            p = [x for x in hyphenated.split('-') if x]
            if len(p) > 1:
                parts = p
    except Exception:
        pass

    # If Pyphen succeeded:
    if parts:
        # If Pyphen over-split (more parts than phonetic count), merge from right
        while len(parts) > target_syllables:
            parts[-2] = parts[-2] + parts[-1]
            parts.pop()
        return parts

    # Fallback: Sonority / Vowel cluster splitting into target_syllables
    vowel_pattern = r'(?:[aeiouyäöüAEIOUYÄÖÜ]{1,2})'
    matches = list(re.finditer(vowel_pattern, clean_word))
    if len(matches) <= 1:
        return [word]

    syllables = []
    prev_idx = 0
    num_splits = min(target_syllables - 1, len(matches) - 1)
    for i in range(num_splits):
        v1_end = matches[i].end()
        v2_start = matches[i+1].start()
        inter_len = v2_start - v1_end
        if inter_len <= 1:
            split_at = v1_end
        else:
            split_at = v1_end + (inter_len // 2)
        syllables.append(clean_word[prev_idx:split_at])
        prev_idx = split_at
    syllables.append(clean_word[prev_idx:])

    res = [s for s in syllables if s]
    return res if res else [word]


# ==============================================================================
# 2. Canonical LyricsDoc Loading (Phase 2 Integration)
# ==============================================================================

def load_canonical_lyrics(
    lyrics_json_path: Path | str,
    vocals_file: Path | str,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Optional[Tuple[List[Dict[str, Any]], str]]:
    """
    Loads and verifies canonical LyricsDoc from JSON.
    Returns (words, detected_lang) if valid, or None if validation fails.
    """
    path = Path(lyrics_json_path).resolve()
    if not path.exists():
        return None

    try:
        from lyrics_providers import LyricsDoc, verify_lyrics_against_audio, estimate_audio_offset
        doc = LyricsDoc.from_json(path)
        print(f"📖 Kanonische Lyrics geladen ({doc.source}, syncType={doc.syncType}, {len(doc.lines)} Zeilen)")

        if progress_cb:
            progress_cb("lyrics", 0.3, f"Loaded canonical lyrics ({doc.syncType}). Verifying against audio...")

        is_valid, reason = verify_lyrics_against_audio(vocals_file, doc)
        if not is_valid:
            print(f"⚠️ Warnung: Lyrics Sanity-Check fehlgeschlagen ({reason}). Weiche auf Whisper aus...")
            return None

        if abs(doc.lyricsOffsetSec) < 1e-4:
            offset = estimate_audio_offset(vocals_file, doc)
            if abs(offset) > 0.04:
                print(f"⏱️ Korrigiere Lyrics-Audio-Offset: {offset:+.3f}s")
                doc.lyricsOffsetSec = offset

        words = doc.to_words_list()
        detected_lang = doc.language or "en"
        print(f"✅ Verwende {len(words)} Provider-Noten/Wörter ({doc.syncType})")
        if progress_cb:
            progress_cb("lyrics", 1.0, f"Using {len(words)} provider syllables ({doc.syncType})")
        return words, detected_lang
    except Exception as e:
        print(f"⚠️ Fehler beim Laden der lyrics.json ({e}). Weiche auf Whisper aus...")
        return None


# ==============================================================================
# 3. Whisper Speech-to-Text Transcription
# ==============================================================================

def transcribe_lyrics(
    vocals_path: Path | str,
    hardware_profile: Optional[HardwareProfile] = None,
    model_selection: Optional[ModelSelection] = None,
    stage_cache: Optional[StageCache] = None,
    progress_cb: Optional[Callable[[str, float, str], None]] = None,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    Transcribes lyrics from vocal audio stem using Whisper (Faster-Whisper or Apple MLX-Whisper).
    """
    # Check cache first
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

    if progress_cb:
        progress_cb("lyrics", 0.1, f"Transcribing vocals using Whisper ({model_selection.whisper_model})...")

    print("\n" + "=" * 65)
    print("[2/4] 🎵 Songtext & Wort-Timestamps mit Whisper (KI)")
    print("=" * 65)

    words = []
    detected_lang = "de"

    # MLX Whisper for Apple Silicon
    if model_selection.whisper_backend == "mlx-whisper" and is_mlx_whisper_available():
        import mlx_whisper
        repo_id = f"mlx-community/whisper-{model_selection.whisper_model}"
        print(f"🍏 Starte Apple MLX-Whisper Inferenz ({repo_id})...")
        try:
            result = mlx_whisper.transcribe(
                str(vocals_path),
                path_or_hf_repo=repo_id,
                word_timestamps=True,
            )
            detected_lang = result.get("language", "de")
            for segment in result.get("segments", []):
                for w in segment.get("words", []):
                    cleaned = w.get("word", "").strip()
                    if cleaned:
                        words.append({
                            "word": cleaned,
                            "start": float(w.get("start", 0.0)),
                            "end": float(w.get("end", 0.0)),
                            "probability": float(w.get("probability", 1.0))
                        })
        except Exception as e:
            print(f"⚠️ MLX-Whisper fehlgeschlagen ({e}). Schalte auf Faster-Whisper um...")
            words = []

    # Faster-Whisper fallback or default
    if not words:
        from faster_whisper import WhisperModel
        print(f"🤖 Lade Faster-Whisper Modell ({model_selection.whisper_model}) auf {model_selection.whisper_device} ({model_selection.whisper_compute})...")

        model = None
        candidate_models = [model_selection.whisper_model]
        for fallback_m in ["small", "base", "tiny"]:
            if fallback_m not in candidate_models:
                candidate_models.append(fallback_m)

        for m_name in candidate_models:
            try:
                model = WhisperModel(
                    m_name,
                    device=model_selection.whisper_device,
                    compute_type=model_selection.whisper_compute,
                )
                if m_name != model_selection.whisper_model:
                    print(f"⚠️ Modell '{model_selection.whisper_model}' offline nicht geladen. Weiche auf '{m_name}' aus.")
                    model_selection.whisper_model = m_name
                break
            except Exception as e:
                print(f"⚠️ Konnte Whisper-Modell '{m_name}' nicht initialisieren ({e}).")
                continue

        if model is None:
            raise RuntimeError(f"Konnte kein Faster-Whisper Modell initialisieren (versucht: {candidate_models}).")

        print("🎙️ Transkribiere Gesang mit Wort-Timestamps...")
        segments, info = model.transcribe(
            str(vocals_path),
            word_timestamps=True,
            vad_filter=True,
            beam_size=5
        )

        for segment in segments:
            for w in segment.words:
                cleaned_word = w.word.strip()
                if cleaned_word:
                    words.append({
                        "word": cleaned_word,
                        "start": float(w.start),
                        "end": float(w.end),
                        "probability": float(w.probability)
                    })

        detected_lang = info.language or "de"

    print(f"✅ {len(words)} Wörter erkannt. Sprache: {detected_lang}")

    # Save to stage cache
    if stage_cache:
        stage_cache.save_words(words, detected_lang)

    if progress_cb:
        progress_cb("lyrics", 1.0, f"Transcribed {len(words)} words ({detected_lang})")

    return words, detected_lang
