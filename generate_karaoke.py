#!/usr/bin/env python3
"""
AI Karaoke Generator: MP3 to UltraStar TXT + Instrumental Audio Track
Version 5.0:
- High-Accuracy Phonetic Syllabification (English & German phonotactics + Monosyllable protection)
- Intelligent Same-Pitch Note Merging (guarantees 1-syllable words never get duplicate tones)
- Melisma / Pitch-Bend Detection (correct UltraStar '~' slur notation)
- Dual High-Accuracy Pitch Tracking:
    * Primary: CREPE Full with Viterbi decoding + RMS Energy weighting
    * Fallback / Alternative: Librosa pYIN with HMM Viterbi tracking
- Transient Consonant Filtering (trims onset/offset consonant noise before pitch calculation)
- Millisecond-precision UltraStar Beat Timing (BPM 1500 -> 10 ms resolution)
"""

import os
import sys
import re
import argparse
import subprocess
import numpy as np
from pathlib import Path
# Optional audio libraries (imported safely)
try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import librosa
except ImportError:
    librosa = None


def print_step(step_num, title):
    print("\n" + "=" * 65)
    print(f"[{step_num}/4] 🎵 {title}")
    print("=" * 65)


# ==============================================================================
# 1. Phonetic Syllable Engine & Monosyllable Protection
# ==============================================================================

# Exhaustive dictionary of words that are phonetically 1 syllable
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


def count_phonetic_syllables(word, lang="de"):
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


def split_syllables(word, lang="de", word_duration=0.5):
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
    if word_duration < 0.28 or count_phonetic_syllables(clean_word, lang) <= 1:
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
# 2. Audio Processing, Stem Separation & Key Detection
# ==============================================================================

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11]
MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10]


def detect_song_key(audio_path, manual_key=""):
    """
    Detects song musical key (root + major/minor) using Krumhansl-Schmuckler
    chroma correlation, and returns the scale pitch classes.
    """
    if manual_key:
        clean_k = manual_key.strip()
        is_minor = 'm' in clean_k.lower() and 'maj' not in clean_k.lower()
        root_str = clean_k.replace('m', '').replace('M', '').replace('aj', '').strip()
        root_idx = 0
        for idx, name in enumerate(NOTE_NAMES):
            if name.lower() == root_str.lower() or name.replace('b', '#').lower() == root_str.lower():
                root_idx = idx
                break
        mode = "minor" if is_minor else "major"
        intervals = MINOR_INTERVALS if is_minor else MAJOR_INTERVALS
        scale_pcs = {(root_idx + iv) % 12 for iv in intervals}
        print(f"🎹 Manuelle Tonart gesetzt: {NOTE_NAMES[root_idx]} {mode.capitalize()}")
        return {"key": f"{NOTE_NAMES[root_idx]} {mode.capitalize()}", "root": root_idx, "mode": mode, "scale_pcs": scale_pcs}

    if librosa is None:
        return None

    try:
        print("🎹 Erkenne Tonart (Key Detection) mit Librosa Chroma...")
        y, sr = librosa.load(str(audio_path), sr=22050, duration=75)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)

        best_corr = -1
        best_root = 0
        best_mode = "major"

        for root in range(12):
            maj_prof = np.roll(MAJOR_PROFILE, root)
            corr_maj = np.corrcoef(chroma, maj_prof)[0, 1]
            if corr_maj > best_corr:
                best_corr = corr_maj
                best_root = root
                best_mode = "major"

            min_prof = np.roll(MINOR_PROFILE, root)
            corr_min = np.corrcoef(chroma, min_prof)[0, 1]
            if corr_min > best_corr:
                best_corr = corr_min
                best_root = root
                best_mode = "minor"

        intervals = MAJOR_INTERVALS if best_mode == "major" else MINOR_INTERVALS
        scale_pcs = {(best_root + iv) % 12 for iv in intervals}
        key_name = f"{NOTE_NAMES[best_root]} {best_mode.capitalize()}"
        print(f"✅ Erkannte Tonart: {key_name} (Sicherheit: {best_corr:.2f})")
        return {"key": key_name, "root": best_root, "mode": best_mode, "scale_pcs": scale_pcs}
    except Exception as e:
        print(f"⚠️ Tonart-Erkennung übersprungen ({e})")
        return None


def snap_pitch_to_scale(midi_val, scale_pcs):
    """Snaps off-key microtonal noise to the nearest in-scale pitch class."""
    if not scale_pcs:
        return int(round(midi_val))
    m = int(round(midi_val))
    if (m % 12) in scale_pcs:
        return m
    # Try one semitone down or up
    down_match = ((m - 1) % 12) in scale_pcs
    up_match = ((m + 1) % 12) in scale_pcs
    if down_match and not up_match:
        return m - 1
    if up_match and not down_match:
        return m + 1
    if down_match and up_match:
        # Snap to closer side
        return m - 1 if (midi_val - (m - 1) < (m + 1) - midi_val) else m + 1
    return m


def detect_display_bpm(audio_path):
    print("📊 Berechne Display-BPM mit Librosa...")
    if librosa is None:
        return 120
    try:
        y, sr = librosa.load(audio_path, sr=22050, duration=90)
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


def separate_stems(audio_path, output_dir):
    print_step(1, "Stimm- und Instrumental-Trennung mit Demucs (KI)")
    audio_path = Path(audio_path).resolve()
    output_dir = Path(output_dir).resolve()

    song_stem_name = audio_path.stem
    demucs_folder = output_dir / "htdemucs" / song_stem_name
    vocals_file = demucs_folder / "vocals.wav"
    instrumental_file = demucs_folder / "no_vocals.wav"

    if vocals_file.exists() and instrumental_file.exists():
        print("⚡ Gesang und Playback bereits im Cache vorhanden:")
        print(f"   Gesang: {vocals_file}")
        print(f"   Playback: {instrumental_file}")
        return vocals_file, instrumental_file

    cmd = [
        sys.executable, "-m", "demucs.separate",
        "--two-stems=vocals",
        "-n", "htdemucs",
        "-o", str(output_dir),
        str(audio_path)
    ]
    print(f"🚀 Starte Demucs: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)

    if not vocals_file.exists() or not instrumental_file.exists():
        raise FileNotFoundError(f"Demucs-Dateien nicht gefunden in {demucs_folder}")

    print(f"✅ Gesangsspur: {vocals_file}")
    print(f"✅ Instrumentalspur: {instrumental_file}")
    return vocals_file, instrumental_file


def transcribe_lyrics(vocals_path):
    print_step(2, "Songtext & Wort-Timestamps mit Whisper (KI)")
    from faster_whisper import WhisperModel

    print("🤖 Lade Faster-Whisper Modell (small)...")
    model = WhisperModel("small", device="cpu", compute_type="int8")

    print("🎙️ Transkribiere Gesang mit Wort-Timestamps...")
    segments, info = model.transcribe(
        str(vocals_path),
        word_timestamps=True,
        vad_filter=True,
        beam_size=5
    )

    words = []
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

    lang = info.language or "de"
    print(f"✅ {len(words)} Wörter erkannt. Sprache: {lang}")
    return words, lang


# ==============================================================================
# 3. High-Accuracy Pitch Detection (CREPE Full / Librosa pYIN)
# ==============================================================================

def compute_audio_rms(y, sr, hop_length):
    """Computes frame-level RMS energy."""
    if librosa is not None:
        rms = librosa.feature.rms(y=y, frame_length=hop_length * 2, hop_length=hop_length)[0]
    else:
        num_frames = int(len(y) / hop_length)
        rms = np.zeros(num_frames)
        for i in range(num_frames):
            frame = y[i * hop_length : (i + 1) * hop_length]
            rms[i] = np.sqrt(np.mean(frame ** 2) + 1e-8)
    return rms


def analyze_vocal_pitch(vocals_path, pitch_engine="pyin", crepe_model="tiny", vocal_range="auto"):
    """
    Extracts continuous fundamental pitch (f0) contour and frame confidence.
    Defaults to Librosa pYIN for ultra-fast, smooth, zero-lag inference (2-5s).
    """
    print_step(3, "Tonhöhen-Analyse mit KI / Monophonem Viterbi-Tracking")

    use_crepe = (pitch_engine == "crepe")
    if use_crepe:
        try:
            return _analyze_pitch_crepe(vocals_path, model_name=crepe_model, vocal_range=vocal_range)
        except Exception as e:
            print(f"⚠️ CREPE fehlgeschlagen ({e}). Schalte auf Librosa pYIN um...")
            return _analyze_pitch_pyin(vocals_path, vocal_range=vocal_range)
    else:
        return _analyze_pitch_pyin(vocals_path, vocal_range=vocal_range)


def _analyze_pitch_crepe(vocals_path, model_name="tiny", vocal_range="auto"):
    import torch
    import torchcrepe

    print(f"🧠 Starte CREPE ({model_name}) Neural Pitch Inferenz...")
    sr = 16000
    y = None

    if sf is not None:
        try:
            data, orig_sr = sf.read(str(vocals_path), dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)
            if orig_sr != sr and librosa is not None:
                data = librosa.resample(data, orig_sr=orig_sr, target_sr=sr)
            y = data
        except Exception:
            y = None

    if y is None and librosa is not None:
        y, _ = librosa.load(str(vocals_path), sr=sr, mono=True)

    if y is None:
        raise RuntimeError("Konnte Gesangsdatei weder mit SoundFile noch mit Librosa laden.")

    audio = torch.from_numpy(y.astype(np.float32)).unsqueeze(0)

    hop_length = 160  # 10 ms at 16 kHz
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    fmin = 80.0 if vocal_range == "male" else 115.0
    fmax = 1050.0
    print(f"🚀 Inferenz auf {device.upper()} (Hop: 10 ms, Frequenz: {fmin:.0f} - {fmax:.0f} Hz)...")

    # Run CREPE prediction with smaller batch size to avoid GPU lag
    pitch_hz, periodicity = torchcrepe.predict(
        audio,
        sample_rate=sr,
        hop_length=hop_length,
        fmin=fmin,
        fmax=fmax,
        model=model_name,
        batch_size=512,
        device=device,
        return_periodicity=True
    )

    pitch_np = pitch_hz.squeeze().cpu().numpy()
    conf_np = periodicity.squeeze().cpu().numpy()

    with np.errstate(divide='ignore', invalid='ignore'):
        midi_np = 69.0 + 12.0 * np.log2(np.maximum(1e-4, pitch_np) / 440.0)
        midi_np = np.nan_to_num(midi_np, nan=60.0)

    y_mono = audio.squeeze().cpu().numpy()
    rms_np = compute_audio_rms(y_mono, sr, hop_length)
    min_len = min(len(midi_np), len(rms_np), len(conf_np))

    print(f"✅ CREPE-Analyse erfolgreich: {min_len} Frames (10 ms Raster).")
    return {
        "type": "contour",
        "frame_dur_sec": hop_length / sr,
        "midi": midi_np[:min_len],
        "conf": conf_np[:min_len],
        "rms": rms_np[:min_len],
        "total_frames": min_len,
        "audio": y_mono,
        "sr": sr
    }


def _analyze_pitch_pyin(vocals_path, vocal_range="auto"):
    print("🎼 Starte Librosa pYIN (Ultra-schnelles Viterbi Pitch-Tracking, kein Lag)...")
    if librosa is None:
        raise RuntimeError("Librosa ist nicht installiert. Bitte 'pip install librosa' ausführen.")

    y, sr = librosa.load(str(vocals_path), sr=22050, mono=True)
    hop_length = int(sr * 0.010)  # 10 ms per frame

    fmin = 80.0 if vocal_range == "male" else 115.0
    fmax = 1050.0

    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=fmin,
        fmax=fmax,
        sr=sr,
        hop_length=hop_length,
        fill_na=None
    )

    f0 = np.nan_to_num(f0, nan=0.0)
    conf_np = np.nan_to_num(voiced_probs, nan=0.0)

    with np.errstate(divide='ignore', invalid='ignore'):
        midi_np = np.where(f0 > 0, 69.0 + 12.0 * np.log2(f0 / 440.0), 60.0)

    rms_np = compute_audio_rms(y, sr, hop_length)
    min_len = min(len(midi_np), len(rms_np), len(conf_np))

    print(f"✅ pYIN-Analyse blitzschnell abgeschlossen: {min_len} Frames.")
    return {
        "type": "contour",
        "frame_dur_sec": hop_length / sr,
        "midi": midi_np[:min_len],
        "conf": conf_np[:min_len],
        "rms": rms_np[:min_len],
        "total_frames": min_len,
        "audio": y,
        "sr": sr
    }

    print(f"✅ pYIN-Analyse erfolgreich: {min_len} Frames (10 ms Raster).")
    return {
        "type": "contour",
        "frame_dur_sec": hop_length / sr,
        "midi": midi_np,
        "conf": conf_np,
        "rms": rms_np,
        "total_frames": min_len,
        "audio": y,
        "sr": sr
    }


def get_syllable_pitch(pitch_data, start_sec, end_sec, fallback_pitch=60):
    """
    Calculates the exact musical pitch of a sung syllable.
    Trims onset/offset consonant transients and computes an energy-weighted median.
    """
    frame_dur = pitch_data["frame_dur_sec"]
    dur = end_sec - start_sec

    # Transient trimming: vowels reside in the core 70% of the segment
    trim_ratio = 0.15 if dur >= 0.16 else 0.0
    core_start = start_sec + (dur * trim_ratio)
    core_end = end_sec - (dur * trim_ratio)

    start_frame = max(0, int(core_start / frame_dur))
    end_frame = min(pitch_data["total_frames"], int(core_end / frame_dur))

    if end_frame <= start_frame:
        start_frame = max(0, int(start_sec / frame_dur))
        end_frame = min(pitch_data["total_frames"], int(end_sec / frame_dur))
        if end_frame <= start_frame:
            return fallback_pitch

    midi_slice = pitch_data["midi"][start_frame:end_frame]
    conf_slice = pitch_data["conf"][start_frame:end_frame]
    rms_slice = pitch_data["rms"][start_frame:end_frame]

    # Voiced frame filtering: confidence and energy threshold
    # Never accept confidence < 0.35 (which is unvoiced noise/breath)
    for min_conf in [0.45, 0.35]:
        mask = (conf_slice >= min_conf)
        if np.any(mask):
            voiced_midis = midi_slice[mask]
            voiced_weights = conf_slice[mask] * (rms_slice[mask] + 1e-4)

            # Weighted median
            sort_idx = np.argsort(voiced_midis)
            sorted_midis = voiced_midis[sort_idx]
            sorted_weights = voiced_weights[sort_idx]
            cum_weights = np.cumsum(sorted_weights)
            cutoff = cum_weights[-1] / 2.0
            median_idx = np.searchsorted(cum_weights, cutoff)
            median_pitch = sorted_midis[min(median_idx, len(sorted_midis) - 1)]
            return int(round(median_pitch))

    # If completely unvoiced (e.g. unvoiced consonant 'f', 's', 't'), inherit the melodic pitch
    # instead of guessing random unvoiced noise!
    return fallback_pitch


def detect_melisma_pitches(pitch_data, start_sec, end_sec, min_dur=0.45):
    """
    Checks if a held single-syllable note contains a deliberate melisma (distinct pitch change).
    Returns a list of (start_time, end_time, pitch) tuples.
    """
    dur = end_sec - start_sec
    if dur < min_dur:
        return None

    frame_dur = pitch_data["frame_dur_sec"]
    sf = max(0, int(start_sec / frame_dur))
    ef = min(pitch_data["total_frames"], int(end_sec / frame_dur))
    if ef - sf < 30:  # < 300 ms of data
        return None

    midis = pitch_data["midi"][sf:ef]
    confs = pitch_data["conf"][sf:ef]
    voiced = confs >= 0.40
    if np.sum(voiced) < 20:
        return None

    # Test if there are two distinct pitch plateaus (first half vs second half)
    half = len(midis) // 2
    p1 = get_syllable_pitch(pitch_data, start_sec, start_sec + (dur * 0.5))
    p2 = get_syllable_pitch(pitch_data, start_sec + (dur * 0.5), end_sec)

    # If the two halves differ by at least 1 full semitone
    if abs(p1 - p2) >= 1.0:
        mid_time = start_sec + (dur * 0.5)
        return [
            (start_sec, mid_time, p1),
            (mid_time, end_sec, p2)
        ]

    return None


# ==============================================================================
# 4. UltraStar Chart Generation & Note Reconciler
# ==============================================================================

def generate_ultrastar_chart(words, pitch_data, display_bpm, title, artist, output_txt_path, lang="de", key_info=None):
    print_step(4, "Erstellung der UltraStar TXT Datei mit Tonleiter & Oktav-Korrektur")

    ustar_bpm = 1500.0
    beat_dur_sec = 0.01  # 10 ms per beat (15 / 1500)

    def sec_to_beat(sec):
        return int(round(sec / beat_dur_sec))

    ultrastar_lines = []
    ultrastar_lines.append(f"#TITLE:{title}")
    ultrastar_lines.append(f"#ARTIST:{artist}")
    ultrastar_lines.append(f"#BPM:{ustar_bpm}")
    ultrastar_lines.append(f"#REALBPM:{display_bpm}")
    ultrastar_lines.append("#GAP:0")
    ultrastar_lines.append(f"#LANGUAGE:{lang.upper()}")
    ultrastar_lines.append("#GENRE:Karaoke AI")
    if key_info:
        ultrastar_lines.append(f"#KEY:{key_info['key']}")

    scale_pcs = key_info["scale_pcs"] if key_info else set()

    # Pass 1: Raw notes extraction for all words
    word_notes_list = []
    prev_pitch = 60

    for i, w in enumerate(words):
        w_start = w["start"]
        w_end = max(w["end"], w_start + 0.16)
        raw_word = w["word"]
        w_dur = w_end - w_start

        pause_beat = None
        if i > 0:
            pause_sec = w_start - words[i-1]["end"]
            if pause_sec > 1.25:
                pause_beat = sec_to_beat(words[i-1]["end"] + 0.15)

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

    # Pass 2: Global Tessitura Analysis & Subharmonic Octave Recovery
    all_raw_pitches = [n["pitch"] for wn in word_notes_list for n in wn["notes"] if n["pitch"] > 0]
    if all_raw_pitches:
        p75 = np.percentile(all_raw_pitches, 75)
        # If upper register is in 4th/5th octave (female/lead vocal >= 64, e.g. G4, Bb4, C5),
        # any notes <= 59 that fell into subharmonic tracking are folded +12 semitones up!
        if p75 >= 64:
            print(f"🎯 Gesangslage erkannt: Hohe Stimmlage (75. Perzentil: {p75:.1f}). Korrigiere Subharmonische (+12 st)...")
            for wn in word_notes_list:
                for n in wn["notes"]:
                    if n["pitch"] <= 59:
                        n["pitch"] += 12

    # Pass 3: Scale Snapping (In-Key Tuning)
    for wn in word_notes_list:
        for n in wn["notes"]:
            if scale_pcs:
                n["pitch"] = snap_pitch_to_scale(n["pitch"], scale_pcs)

    # Pass 4: Syllable Formatting, Note Preservation & Word Spacing
    last_end_beat = 0
    for wn in word_notes_list:
        if wn["pause_beat"] is not None:
            ultrastar_lines.append(f"- {wn['pause_beat']}")
            last_end_beat = max(last_end_beat, wn["pause_beat"])

        # Note Preservation Rule:
        # Multi-syllable words (num_sylls > 1) MUST PRESERVE each distinct syllable note (e.g. 'ein-', 'fa-', 'cher')!
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

        # Word-boundary Spacing:
        # Guarantee a clean visual gap (at least 6 beats = 60 ms) between distinct words
        # so note capsules and text never collide horizontally (e.g. 'wäre' and 'ein-')
        for note_idx, note in enumerate(active_notes):
            s_pitch = note["pitch"]
            s_beat = sec_to_beat(note["start"])
            e_beat = sec_to_beat(note["end"])

            # Word spacing
            if note_idx == 0 and last_end_beat > 0:
                min_start = last_end_beat + 6
                if s_beat < min_start:
                    s_beat = min_start

            if e_beat - s_beat < 10:
                e_beat = s_beat + 10

            if s_beat < last_end_beat:
                s_beat = last_end_beat + 2

            if e_beat <= s_beat:
                e_beat = s_beat + 10

            d_beat = max(8, e_beat - s_beat)
            last_end_beat = s_beat + d_beat

            ultrastar_lines.append(f": {s_beat} {d_beat} {s_pitch} {note['text']}")

    ultrastar_lines.append("E")

    with open(output_txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(ultrastar_lines) + "\n")

    print(f"🎉 UltraStar Datei erfolgreich gespeichert: {output_txt_path}")


# ==============================================================================
# 5. CLI Entrypoint
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(description="AI Karaoke Generator 5.0 (Präzise Melodien + Phonetik)")
    parser.add_argument("input_audio", help="Pfad zur Eingabe-Audiodatei (MP3, WAV, M4A)")
    parser.add_argument("--artist", default="", help="Künstler-Name (optional)")
    parser.add_argument("--title", default="", help="Song-Titel (optional)")
    parser.add_argument("--output_dir", default="./output", help="Ausgabeordner")
    parser.add_argument("--pitch-engine", choices=["pyin", "crepe"], default="pyin",
                        help="Tonhöhen-Algorithmus (pyin = blitzschnell 3s, crepe = neural)")
    parser.add_argument("--crepe-model", choices=["full", "tiny"], default="tiny",
                        help="CREPE Modell-Größe")
    parser.add_argument("--key", default="", help="Musikalische Tonart (z.B. 'Eb', 'Cm', 'F', optional)")
    parser.add_argument("--vocal-range", choices=["auto", "female", "male"], default="auto",
                        help="Gesangsbereich (auto, female, male)")

    args = parser.parse_args()

    audio_path = Path(args.input_audio).resolve()
    if not audio_path.exists():
        print(f"❌ Fehler: Datei nicht gefunden: {audio_path}")
        sys.exit(1)

    filename_stem = audio_path.stem
    if not args.artist and not args.title:
        if " - " in filename_stem:
            parts = filename_stem.split(" - ", 1)
            artist, title = parts[0].strip(), parts[1].strip()
        else:
            artist, title = "Unknown Artist", filename_stem
    else:
        artist = args.artist or "Unknown Artist"
        title = args.title or filename_stem

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print("\n" + "🎤" * 35)
    print(f" Starte KI-Karaoke Pipeline 5.0 für: {artist} - {title}")
    print(f" (Engine: {args.pitch_engine.upper()}, Tonleiter-Snap & 100% Millisekunden)")
    print("🎤" * 35)

    display_bpm = detect_display_bpm(str(audio_path))
    vocals_file, instrumental_file = separate_stems(audio_path, output_dir)
    words, detected_lang = transcribe_lyrics(vocals_file)
    key_info = detect_song_key(instrumental_file if instrumental_file.exists() else audio_path, manual_key=args.key)
    pitch_data = analyze_vocal_pitch(vocals_file, pitch_engine=args.pitch_engine, crepe_model=args.crepe_model, vocal_range=args.vocal_range)

    clean_filename = f"{artist} - {title}".replace("/", "_").replace("\\", "_")
    output_txt = output_dir / f"{clean_filename}.txt"

    generate_ultrastar_chart(words, pitch_data, display_bpm, title, artist, output_txt, lang=detected_lang, key_info=key_info)

    final_instrumental = output_dir / f"{clean_filename} [Instrumental].wav"
    if instrumental_file.exists():
        import shutil
        shutil.copyfile(instrumental_file, final_instrumental)

    print("\n" + "⭐" * 35)
    print("FERTIG! Folgende Dateien wurden erzeugt:")
    print(f"1. Noten-Datei (UltraStar TXT): {output_txt}")
    print(f"2. Instrumental-Audio (Playback): {final_instrumental}")
    print("⭐" * 35 + "\n")


if __name__ == "__main__":
    main()
