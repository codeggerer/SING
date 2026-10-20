# 🤖 AGENTS.md – Developer & AI Agent Guide

Welcome to the **SING! Web Studio & AI Karaoke Engine** codebase. This guide provides rapid architectural onboarding, core system invariants, file maps, and command recipes for AI agents and human developers.

---

## ⚡ 30-Second Executive Summary

This project consists of two tightly coupled environments:
1. **Interactive Web Karaoke Client (`public/` + `server.js`)**: A browser-based game inspired by *Let's Sing* and *SingStar*. Features real-time pitch detection via Web Audio API (McLeod Pitch Method), lyrics alignment, scoring, and streaming through YouTube (IFrame API) and Spotify (Web Playback SDK with PKCE).
2. **Offline AI Karaoke Generator (`generate_karaoke.py` + `optimizer.py`)**: A Python pipeline that takes any raw song (MP3/WAV/M4A), separates vocal/instrumental stems via Demucs, transcribes word timestamps with Faster-Whisper, tracks fundamental pitch via CREPE/pYIN, and outputs an UltraStar `.txt` score chart with millisecond precision.

---

## 🗺️ File & Component Map

| Path | Primary Language | Description / Responsibilities |
| :--- | :--- | :--- |
| [`server.js`](./server.js) | Node.js (CommonJS) | **Zero-dependency API Gateway & Static Server**. Handles USDB session auth, LRCLIB/iTunes search proxying, YouTube metadata scraping, and static file delivery. |
| [`public/app.js`](./public/app.js) | JavaScript (ES6+) | **Main Game Engine & Client DSP**. Implements Web Audio API MPM pitch detector, 60 FPS canvas highway, YouTube/Spotify players, offset sync, and scoring. |
| [`public/index.html`](./public/index.html) | HTML5 | **Single-Page Application Shell**. UI for lobby/search, stage arena, HUD, settings modals, and custom `.txt` loader. |
| [`public/style.css`](./public/style.css) | CSS3 | **Dark Glassmorphism UI**. Glowing neon accents, responsive arena grid, particle canvas styling. |
| [`public/ultrastar_index.json`](./public/ultrastar_index.json) | JSON | **Pre-Indexed Catalog**. 6,682 curated songs with title, artist, YouTube video ID, BPM, and initial gap values. |
| [`generate_karaoke.py`](./generate_karaoke.py) | Python 3.11 | **AI Karaoke Pipeline CLI**. 4-step pipeline: Demucs stems -> Faster-Whisper timestamps -> CREPE/pYIN pitch -> UltraStar TXT export. |
| [`optimizer.py`](./optimizer.py) | Python 3.11 | **Multi-Island Genetic Optimizer**. 8-island GA tuning 12 acoustic parameters against ground-truth note charts. |
| [`tests/engine_test.js`](./tests/engine_test.js) | Node.js | **Engine Test Suite**. Tests MPM pitch detection on synthetic tones, catalog validity, and lyric alignment math. |
| [`tests/test_karaoke_pipeline.py`](./tests/test_karaoke_pipeline.py) | Python (unittest) | **AI Unit Tests**. Tests phonetic syllabification, monosyllable protection, and energy-weighted median extraction. |

---

## 🔒 Architectural Invariants & Rules

When modifying or expanding the codebase, adhere to these architectural rules:

### 1. Zero External Dependencies in `server.js`
- `server.js` uses **only** Node.js native standard libraries (`http`, `https`, `fs`, `path`, `url`).
- **Do not introduce Express, Fastify, Axios, or node-fetch** unless explicitly requested. All outgoing HTTP requests are handled via the native `fetchUrl()` / `postUrl()` helper functions.

### 2. UltraStar Format & Beat Math
- UltraStar syntax conventions:
  - `: <start_beat> <duration_beats> <pitch_midi> <syllable_with_trailing_space>` (Normal note)
  - `* <start_beat> <duration_beats> <pitch_midi> <syllable_with_trailing_space>` (Golden note)
  - `F <start_beat> <duration_beats> <pitch_midi> <syllable_with_trailing_space>` (Freestyle note)
  - `- <pause_beat>` (Line break / phrase split)
  - `E` (End of song)
- **Millisecond Resolution in AI Generator**:
  In [`generate_karaoke.py`](./generate_karaoke.py), the output header uses `#BPM:1500`.
  $$\text{Beat Duration} = \frac{15}{\text{BPM}} = \frac{15}{1500} = 0.01\text{ s} = 10\text{ ms}$$
  Each beat is exactly 10 milliseconds.

### 3. McLeod Pitch Method (MPM) Specifications
- Input buffer length is **1536 samples** (`Math.min(buffer.length, 1536)`).
- Pitch tracking bounds: Minimum lag corresponds to 1000 Hz ($\approx 44\text{ samples}$ at 44.1 kHz); maximum lag corresponds to 78 Hz.
- Peak threshold: NSDF peak must be $\ge 0.82 \times \max(\text{lobe})$.
- Parabolic interpolation must be applied to refine fractional sample lag.

### 4. Monosyllable Protection in Syllable Engine
- English words with silent *-e*, diphthongs, or complex codas (*dance, breathe, please, voice, light*) and German contractions (*ein, sehn, geht, traum, glück*) are explicitly indexed in `MONOSYLLABLE_WORDS`.
- Words with duration $< 0.28\text{ s}$ or phonetic syllable count $\le 1$ **must never be split**.

### 5. Playback Synchronization Clock
- `videoOffsetSec` is defined as:
  $$\text{songTime} = \text{rawPlayerTime} - \text{videoOffsetSec}$$
- In `public/app.js`, high-resolution time is interpolated between player ticks via `performance.now()`.

---

## 🛠️ Developer & Agent Command Cheat Sheet

### Web Server & Tests
```bash
# Start Web Server (serves on http://localhost:3000)
node server.js

# Run JavaScript Engine Tests (validates MPM DSP, catalog, sync math)
node tests/engine_test.js
```

### Python AI Pipeline & Tests
```bash
# Run Python Unit Tests
./venv/bin/python -m unittest tests/test_karaoke_pipeline.py

# Generate UltraStar Chart from Audio (fast pYIN mode)
./venv/bin/python generate_karaoke.py "song.mp3" --artist "Artist" --title "Title" --pitch-engine pyin

# Generate with Neural Pitch (TorchCREPE on GPU/MPS)
./venv/bin/python generate_karaoke.py "song.mp3" --artist "Artist" --title "Title" --pitch-engine crepe --crepe-model tiny

# Run Genetic Parameter Optimization
./venv/bin/python optimizer.py "song.mp3" --ground-truth ground_truth_sample.json
```

---

## 🔍 Common Debugging Scenarios & Gotchas

1. **YouTube Video "Embedding Blocked" (Error 150 / 101)**:
   - Record labels often disable embedding on official music videos.
   - **Solution**: The engine supports auto-fallback via `VERIFIED_YOUTUBE_FALLBACKS` in [`public/app.js`](./public/app.js) or alternative query generation (`${query} Lyrics`, `${query} Official Audio`) via `/api/youtube`. Users can also switch to Spotify mode or paste a custom ID.

2. **Octave Leaps in Mic Pitch**:
   - Singing at low volume or through aggressive laptop noise gates can cause octave doubling or subharmonic drops.
   - **Solution**: Toggle `chkOctaveAgnostic` ("Oktav-Freiheit") in the stage controls, which evaluates pitch class modulo 12:
     $$\text{pitchClass} = \text{pitch} \pmod{12}$$

3. **Demucs / Torch Memory & Speed**:
   - `demucs.separate` with `--two-stems=vocals` requires roughly 2 GB RAM. It runs in a subprocess spawned from [`generate_karaoke.py`](./generate_karaoke.py). Outputs are cached in `output/htdemucs/<song_stem>/`.

4. **USDB Login & Session Persistence**:
   - User credentials and session cookies for `usdb.animux.de` are persisted locally in `usdb_config.json`.
   - Downloaded charts are cached as plain text in `usdb_cache/<id>.txt`.
