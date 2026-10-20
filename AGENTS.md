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
| [`server.js`](./server.js) | Node.js (CommonJS) | **Zero-dependency API Gateway & Static Server**. Handles USDB session auth, LRCLIB/iTunes search proxying, YouTube metadata scraping, `/api/resolve`, `/api/jobs` queue, `/api/library` catalog, and static file delivery. |
| [`lib/lyrics.js`](./lib/lyrics.js) | Node.js (CommonJS) | **Multi-Provider Lyrics Engine**. Normalizes canonical `LyricsDoc`, manages Spicy Lyrics, Spotify Color-Lyrics, LRCLIB fallback, token buckets, and rate limits. |
| [`lib/resolver.js`](./lib/resolver.js) | Node.js (CommonJS) | **Track & URL Resolver**. Dispatches Spotify URLs, YouTube URLs, and free-text queries to canonical track metadata with duration matching and confidence scoring. |
| [`lib/jobs.js`](./lib/jobs.js) | Node.js (CommonJS) | **Job Queue & Generation Worker**. Single-concurrency worker for GPU/RAM protection, persistent job states, Server-Sent Events (SSE) streaming, and process cancellation. |
| [`lib/library.js`](./lib/library.js) | Node.js (CommonJS) | **Song Library & Streaming Engine**. Scans generated songs in `songs/<slug>/`, parses `meta.json`, serves audio with HTTP 206 Range streaming support, and handles chart editing updates via `updateSongChart()` (`POST /api/library/:slug/chart`). |
| [`public/app.js`](./public/app.js) | JavaScript (ES6+) | **Main Game Engine & Client DSP**. Implements Web Audio API MPM pitch detector, 60 FPS canvas highway with render-time spacing, YouTube/Spotify players, local instrumental playback, in-browser AI generator UI, interactive Chart Editor (`#modalChartEditor`), and scoring. |
| [`public/index.html`](./public/index.html) | HTML5 | **Single-Page Application Shell**. UI for lobby/search, stage arena, HUD, settings modals, Chart Editor modal, and custom `.txt` loader. |
| [`public/style.css`](./public/style.css) | CSS3 | **Dark Glassmorphism UI**. Glowing neon accents, responsive arena grid, particle canvas styling, and Chart Editor piano roll styles. |
| [`public/ultrastar_index.json`](./public/ultrastar_index.json) | JSON | **Pre-Indexed Catalog**. 6,682 curated songs with title, artist, YouTube video ID, BPM, and initial gap values. |
| [`generate_karaoke.py`](./generate_karaoke.py) | Python 3.11 | **AI Karaoke Pipeline CLI**. Thin wrapper over `karaoke` package with `--json-progress`, `--quality`, `--device`, `--debug-dir`, and stage caching. |
| [`karaoke/`](./karaoke/) | Python 3.11 | **Modular AI Karaoke Engine**. Modular package: `separate.py`, `lyrics_io.py`, `align.py`, `pitch.py`, `notes.py`, `chart.py`, `pipeline.py`, `hardware.py`, `cache.py`, `debug_export.py`, `config.py`. |
| [`scripts/check.sh`](./scripts/check.sh) | Bash | **Continuous Regression Gate**. Executes Node.js tests, Python unit tests, and AI benchmark evaluation on `fast/*` subset, failing if any accuracy metric regresses > 2%. |
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

### 6. Strict Copyright Protection & Zero-Piracy Invariant
- **No Copyrighted Audio or Media in Git**: Never track, add, or commit proprietary audio files (`*.mp3`, `*.wav`, `*.m4a`, `*.flac`, `*.ogg`, `*.aac`, etc.) or Demucs separated stems (`output/htdemucs/`, etc.). All audio extensions must remain strictly ignored in `.gitignore`.
- **No Commercial Lyrics or Charts in Git**: Never commit full commercial lyrics or UltraStar charts of copyrighted songs to the repository. The local chart cache (`usdb_cache/`) and output directory (`output/`) must stay git-ignored.
- **Public Domain Test Fixtures Only**: Unit tests (`tests/engine_test.js`, `tests/test_karaoke_pipeline.py`) and ground-truth sample templates (`ground_truth_sample.json`) must strictly use public-domain songs (e.g., *Aura Lea*, *Twinkle Twinkle Little Star*) or synthetic audio models (NumPy sine waves). Never paste commercial lyrics into test code.
- **No Hardcoded Credentials or API Keys**: Never commit credentials, passwords, or session cookies (`usdb_config.json`, `.env`, `config.local.json`). Always use `.env.example` as a template and ensure real secrets remain git-ignored.
- **Pre-Commit Verification Rule**: Always run `git status` before committing to confirm that no audio, lyrics, or credential files are staged.

---

## 🛠️ Developer & Agent Command Cheat Sheet

### Web Server & Tests
```bash
# Start Web Server (serves on http://localhost:3000)
node server.js

# Run Complete JavaScript Test Suite (Validates Resolver, Job Queue, Library, and Engine DSP)
npm test

# Run End-to-End Regression Gate (Node.js + Python + AI Benchmark fast/* subset)
bash scripts/check.sh
# or: npm run test:regression

# Run Individual Test Suites
npm run test:resolver
npm run test:jobs
npm run test:engine
```

### Python AI Pipeline & Tests
```bash
# Run All Python Unit Tests
./venv/bin/python -m unittest discover tests

# Generate UltraStar Chart from Audio (FCPE neural singing pitch)
./venv/bin/python generate_karaoke.py "song.mp3" --artist "Artist" --title "Title" --pitch-engine fcpe

# Generate with Debug Export (writes contour.png & report.json to ./debug_out)
./venv/bin/python generate_karaoke.py "song.mp3" --artist "Artist" --title "Title" --debug-dir ./debug_out

# Generate with Neural Pitch (TorchCREPE on GPU/MPS)
./venv/bin/python generate_karaoke.py "song.mp3" --artist "Artist" --title "Title" --pitch-engine crepe --crepe-model tiny

# Generate with machine-readable progress streaming (for server / SSE relay)
./venv/bin/python generate_karaoke.py "song.mp3" --artist "Artist" --title "Title" --json-progress

# Run AI Evaluation Benchmark against Ground-Truth Corpus
./venv/bin/python eval/eval.py --stage all --songs "fast/*" --check-regression eval/results/baseline.json

# Run Genetic Parameter Optimization
./venv/bin/python optimizer.py "song.mp3" --ground-truth ground_truth_sample.json
```

### Local Audio Acquisition (yt-dlp) for Pipeline Testing
To test the AI generator or optimizer locally on any song, download the audio using `yt-dlp`. Because `*.mp3`, `*.wav`, and `output/` are in `.gitignore`, these files remain strictly local and will never be tracked or committed to git:

```bash
# 1. Download audio from a YouTube video URL as MP3
yt-dlp -x --audio-format mp3 -o "test_song.mp3" "https://www.youtube.com/watch?v=VIDEO_ID"

# 2. Or download by search query directly
yt-dlp -x --audio-format mp3 -o "test_song.mp3" "ytsearch1:Artist Title Official Audio"

# 3. Run AI karaoke generator on the downloaded local file
./venv/bin/python generate_karaoke.py "test_song.mp3" --artist "Artist Name" --title "Song Title"

# Generated outputs will land in ./output/ (git-ignored):
# - ./output/Artist Name - Song Title.txt
# - ./output/Artist Name - Song Title [Instrumental].wav
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
