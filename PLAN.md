# PLAN.md – Karaoke Quality Overhaul + In-Browser Chart Generation

Audience: coding agents implementing this step by step. Read `AGENTS.md` first and respect its invariants:
- `server.js` stays dependency-free (only `http`, `https`, `fs`, `path`, `url`, plus `child_process`/`crypto`/`os` from the standard library).
- UltraStar output keeps `#BPM:1500`, 1 beat = 10 ms.
- Monosyllable protection and the `videoOffsetSec` formula stay unchanged.

Do the phases in order. Each phase lists **Files**, **Tasks** and **Done when**. Do not start a phase until the previous phase's "Done when" holds. Commit after each phase.

---

## 0. Problems to fix (from code review)

| # | Symptom | Root cause (file) |
|---|---|---|
| P1 | Pitch off by 1–2 semitones | pYIN / CREPE-tiny on a leaky Demucs stem. `snap_pitch_to_scale` snaps the already-rounded integer to a key guessed from the mix. `+12` octave hack on the 75th percentile. Unvoiced frames default to MIDI 60. No smoothing and no tuning-offset estimation. (`generate_karaoke.py`) |
| P2 | Two notes where there is one | `detect_melisma_pitches` splits any word of 450 ms or longer in the middle when the rounded halves differ by at least 1 semitone. Vibrato, scoops and octave glitches trigger it. |
| P3 | Wrong lyrics | Whisper `small` int8, no language hint, no known text. Ignores externally available lyrics. |
| P4 | Wrong word and syllable timing | Whisper word timestamps are off by 100–300 ms. Syllables get `w_dur / num_sylls`. The 160 ms and 10-beat minimums distort the result. |
| P5 | No way to measure | The optimizer tunes against one song. `usdb_cache/` is empty. |
| P6 | Generation is a CLI-only step | The user has to run Python by hand and find files manually. |

## 1. Target architecture

```
 URL / search text
        │
        ▼
 [Resolver]  → { title, artist, durationSec, spotifyTrackId?, youtubeId?, isrc? }
        │
        ├──► [Lyrics Provider Chain]  Spicy Lyrics → Spotify color-lyrics → LRCLIB → Whisper
        │         returns canonical LyricsDoc (syllable-timed if available)
        ├──► [Audio Fetch]  yt-dlp (YouTube id) → output/<jobId>/source.<ext>
        ▼
 [Separation] → vocals.wav / no_vocals.wav
        ▼
 [Alignment]  (only if the lyrics are not syllable-synced) forced alignment of known text
        ▼
 [Pitch]      f0 contour (RMVPE/FCPE or CREPE-full) + Basic Pitch note events
        ▼
 [Note builder + chart writer]  → songs/<slug>/ {song.txt, instrumental.wav, meta.json, lyrics.json}
        ▼
 [Server job queue + SSE progress]  → web UI (search / paste link → progress → play)
```

Key principle: **lyrics providers supply text and timing. The audio supplies pitch.** No lyrics API provides pitch. Pitch work is still needed, but note boundaries become reliable because the syllable boundaries are known.

---

## Phase 1 – Benchmark harness (P5) — DO THIS FIRST

**Files:** new `eval/` (`eval/eval.py`, `eval/metrics.py`, `eval/corpus/README.md`), update `tests/`.

**Tasks**
1. Build a corpus of 15–30 songs with ground truth in UltraStar `.txt` format (from USDB via the existing session; save to `eval/corpus/<slug>/{audio.mp3,truth.txt}`). Cover male, female, rap-ish, fast and slow, German and English. Ground-truth charts have a different `#BPM`/`#GAP`, so write `ultrastar_parser.py` that converts any UltraStar file to a list of `{start_sec, end_sec, pitch, text, type}`. Put the BPM/GAP math in one tested function.
2. In `metrics.py` implement:
   - **Pitch accuracy:** duration-weighted share of generated note time whose pitch is within ±0 and ±1 semitone of the truth (strict), and the same octave-agnostic (mod 12).
   - **Onset error:** median and P90 absolute error of the syllable start (ms) after matching via monotone DTW on syllable text.
   - **Duration error:** median relative error.
   - **Lyrics:** WER and CER of the normalized text (lowercase, punctuation stripped).
   - **False split rate:** share of truth syllables matched by more than 1 generated note.
3. `eval/eval.py --stage <pitch|lyrics|timing|all> --songs <glob>` prints a table and writes `eval/results/<git-sha>.json`. Allow running one stage with truth lyrics injected so stages can be tested independently (for example pitch with truth timings).
4. Record the **baseline** with the current pipeline in `eval/results/baseline.json`. Every later phase must show its delta against it in the commit message.
5. Retire the GA optimizer as the primary tuning route. Keep `optimizer.py` runnable, but stop treating `best_karaoke_params.json` as authoritative.

**Done when:** `python eval/eval.py --stage all` runs end to end on the corpus, `baseline.json` is committed, and unit tests for the parser and metrics pass.

---

## Phase 2 – Lyrics provider chain (P3, P4)

**Files:** new `lyrics_providers/` Python package for the offline pipeline and new `lib/lyrics.js` for `server.js` (single source of truth, see task 7), `server.js`, `tests/`.

### 2.1 Canonical data model (`LyricsDoc`)
```json
{
  "source": "spicylyrics|spotify|lrclib|whisper",
  "syncType": "syllable|word|line|static",
  "language": "de",
  "lines": [
    { "start": 12.34, "end": 15.80, "agent": "lead|background",
      "syllables": [ { "text": "Un-", "start": 12.34, "end": 12.62, "joinNext": true } ] }
  ]
}
```
- Times are in **seconds** (floats). Convert all provider units (ms) at the provider boundary.
- `joinNext: true` means the syllable belongs to the same word as the next one.
- For `line`/`static` sync, `syllables` is built later by the text/syllable engine (`split_syllables`), flagged `"derived": true`.

### 2.2 Providers (priority order)
1. **Spicy Lyrics** (`https://api.spicylyrics.org`, endpoint `GET /v1/lyrics/{spotifyTrackId}`, `Authorization: Bearer <key>`).
   - Read the official docs yourself before coding: `https://developers.spicylyrics.org/llms.txt` (**it could not be fetched while this plan was written, so the response schema below is unverified**). Save a real response sample under `tests/fixtures/spicylyrics_*.json` and write the parser against that sample.
   - Per the public summary, `syncType` is one of `Syllable`, `Line`, `Static`. The best available sync is returned. Syllable data is nested in lines with start/end times. Lead and background voices are probably distinguished. Verify all of this against the sample.
   - Keys: `sl_sk_…` (server-side) and `sl_pk_…` (browser, origin-restricted). Use a **server-side key only** and call from `server.js`. Never ship the key to the browser. Read it from env `SPICY_LYRICS_KEY` or the git-ignored `config.local.json`. Add it to `.gitignore`.
   - Needs a **Spotify track ID**. The Resolver (Phase 6.1) must therefore resolve one (Spotify link, or searching by artist, title and duration).
2. **Spotify color-lyrics** (fallback). `GET https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}?format=json&vocalRemoval=false&market=from_token` with headers `app-platform: WebPlayer` and `authorization: Bearer <user-session web-player token>`.
   - Client-credentials tokens do not work. A user-session web-player token is required. The existing PKCE flow in `public/app.js` yields a token that probably lacks the scope or is rejected, so **test this early**. If it fails, offer an optional `SPOTIFY_SP_DC` cookie setting that exchanges for a web-player token. Document the trade-off in the UI.
   - Expect mostly `LINE_SYNCED`. Use `syllables[]` only if non-empty. `startTimeMs` and `endTimeMs` are strings (convert with `Number`). An `endTimeMs` of `"0"` means "unknown": derive the end from the next line's start.
   - This is an unofficial endpoint. Wrap it in a feature flag (`ENABLE_SPOTIFY_COLOR_LYRICS`, default on only when a token is configured) and handle 401, 403 and 429 gracefully (skip to the next provider).
3. **LRCLIB** (already used in `server.js`). Use the `syncedLyrics` LRC (line sync). Match on artist, title and duration (±3 s) via `/api/get`, then `/api/search` as fallback.
4. **Whisper** (last resort, existing logic upgraded in Phase 4).

### 2.3 Tasks
1. Implement one `fetchLyrics({title, artist, durationSec, spotifyTrackId})` that tries providers in order and returns the first doc with the best `syncType` rank (`syllable > word > line > static`). If provider 1 returns only `line` sync, still try providers 2 and 3 for `syllable`, then keep the highest-ranked result.
2. Normalizers per provider → `LyricsDoc`. Handle: `\u200b`/BOM characters, `♪` instrumental markers (drop), empty lines, CRLF, `(background vocals)` parentheses (set `agent: "background"`, and give background the option to be excluded from scoring).
3. Quality gate before trusting a doc: line starts monotonic, no syllable longer than 4 s unless held note, doc coverage ≥ 70% of audio duration, language detected (use a simple stop-word check, or Whisper `info.language` on the first 30 s).
4. **Sanity-check lyrics against audio.** Run Whisper `tiny`/`base` on 3 × 20 s windows of the vocal stem and compute CER against the doc text at those times. If CER > 0.6 in the majority, **drop** the doc as a mismatch (wrong version or remix) and fall through. Also compare provider duration to audio duration and compute a global offset by cross-correlating the doc onsets with the vocal RMS envelope. Store as `lyricsOffsetSec`.
5. Disk cache: `lyrics_cache/<provider>/<trackId>.json`, TTL 30 days, negative-cache misses 24 h.
6. Rate-limit and timeout every call (8 s) and send a descriptive `User-Agent`.
7. **Share implementation between Node and Python.** Providers live in Node (the server owns the keys). The Python pipeline receives the finished `lyrics.json` via `--lyrics-json <path>` and never calls providers itself. A standalone CLI run without it falls back to Whisper.
8. Tests (`tests/`): fixture-based parser tests for every provider including missing-field cases, provider fallback order test with mocked `fetchUrl`.

**Done when:** for 10 corpus songs, `fetchLyrics` returns a doc and `eval --stage lyrics` shows a WER drop vs the baseline. At least the syllable-synced ones show an onset error median < 80 ms against truth.

---

## Phase 3 – Pipeline refactor (enabler)

**Files:** split `generate_karaoke.py` into a package `karaoke/`:
`separate.py`, `lyrics_io.py`, `align.py`, `pitch.py`, `notes.py`, `chart.py`, `pipeline.py`, `config.py`. Keep `generate_karaoke.py` as a thin CLI wrapper that preserves the existing flags.

**Tasks**
1. Move code as-is first (no behavior change). Run `unittest` and the eval baseline: the metrics must match the baseline.
2. Delete dead code after the `return` in `_analyze_pitch_pyin`.
3. Stage cache keyed by `sha1(audio)` + stage parameters: `output/<hash>/{vocals.wav,no_vocals.wav,f0.npz,words.json,...}`.
4. `pipeline.run(job)` takes a `progress(stage, fraction, message)` callback. The CLI prints it. The server (Phase 6) relays it.
5. Machine-readable mode: `--json-progress` prints one JSON line per progress event to stdout, and the final result paths in the last line.
6. Add `torch.device` selection helper (MPS → CUDA → CPU).

**Done when:** CLI behavior is unchanged, eval baseline reproduced, and the stages are importable separately.

---

## Phase 4 – Alignment & timing (P4)

**Files:** `karaoke/align.py`, `karaoke/lyrics_io.py`, `karaoke/notes.py`.

Case matrix:

| Lyrics available | What to do |
|---|---|
| `syllable` sync | Use as-is after offset correction (Phase 2.3 task 4) and snap to audio (below). |
| `word` or `line` sync | Forced-align text against the vocal stem → word timings (below). |
| none / mismatch | Whisper with `large-v3-turbo` (or `large-v3` on GPU/MPS), fixed `language`, `word_timestamps=True`, `condition_on_previous_text=False`, `vad_filter=True`. Then run the same forced aligner on the Whisper text. |

**Tasks**
1. **Forced aligner**: use `ctc-forced-aligner` (MMS) or `whisperx` alignment (wav2vec2 German/English). Input: vocals stem + known text split per line (use the line timing as a window prior with ±1.5 s margin). Output: word and, via the phoneme or character level, syllable boundaries. Evaluate both libraries on the benchmark (`eval --stage timing`) and keep the better one. Make the choice configurable.
2. **Syllable timing without provider data**: distribute the word's duration using the **vowel nucleus**, not equal split. Use character-level CTC spans if the aligner provides them, else a weighted split (vowel-containing syllable weight 1.0, onset-consonant clusters +0.15 per consonant, with the last syllable of the word and words before a pause getting +20 % for lengthening).
3. **Audio-based snapping** of every syllable start (provider or aligned): look in a ±120 ms window for the strongest of (a) onset-strength peak (`librosa.onset.onset_detect` on the vocal stem), (b) unvoiced→voiced transition in the f0 contour. Move the start only if the evidence is clear (peak strength above a percentile threshold). Never reorder syllables. Keep min 30 ms between them.
4. **Remove the arbitrary clamps:** drop `max(end, start+0.16)`, the 10-beat and 8-beat minimums, and the +6-beat word gap. Replace with: resolve overlaps only, minimum duration 3 beats (30 ms), minimum gap 1 beat. Visual separation is a UI concern (see Phase 7).
5. **Note end** = min(syllable end from provider/aligner, last voiced frame within the syllable + 40 ms). A note must not extend across a silent gap > 120 ms.
6. **Line breaks (`- <beat>`)**: use provider/LRC line boundaries. Else break where the pause ≥ 0.6 s or the line has ≥ 8 words.
7. Keep monosyllable protection for derived syllables.

**Done when:** `eval --stage timing`: median onset error < 70 ms and P90 < 200 ms on songs with syllable-synced lyrics; and no regression on the others. Record numbers in the commit.

---

## Phase 5 – Pitch (P1, P2) and Basic Pitch decision

**Files:** `karaoke/pitch.py`, `karaoke/notes.py`, `karaoke/separate.py`.

### 5.1 Better input
1. Offer a stronger vocal separator via `audio-separator` (Mel-Band RoFormer / MDX23C vocal model) as an alternative to Demucs, selected by `--separator {demucs,roformer}`. Optionally run a de-reverb model on the vocal stem. Benchmark both; default to the winner.
2. Backing vocals produce double tones. Prefer a "lead vs backing" model if available, or use the provider's `agent: background` ranges to **mask** backing sections in the pitch pass (do not score them as notes).

### 5.2 f0 tracker (primary)
- Candidates in order of preference: **RMVPE**, **FCPE** (both singing-oriented), `torchcrepe` `full` with Viterbi decoding, pYIN (fallback).
- Interface: `track_f0(audio, sr) -> {t, f0_hz, voiced_prob}` with 10 ms hop. Implement one adapter per tracker and select by `--pitch-engine`. Choose the default by the benchmark (`eval --stage pitch` with truth timings injected, so pitch is evaluated in isolation).
- Replace unvoiced default `60` with `NaN`. Every consumer must handle `NaN`.

### 5.3 Contour cleanup (`clean_f0`)
1. Mask frames with `voiced_prob < 0.5` or RMS below −45 dBFS relative to the file peak.
2. 5-frame median filter. Remove isolated voiced runs < 5 frames.
3. **Octave-jump repair** by continuity: if a frame is ≈ ±12 st (±1 st tolerance) from the median of its voiced neighbours (±15 frames), shift it by ∓12.
4. **Global tuning estimate:** histogram of `(midi − round(midi)) × 100` in cents weighted by voiced prob; take the circular mean of the mode. Subtract it before rounding (clamp ±50 cents).
5. Convert to MIDI float; keep float until the final rounding.
6. **Vibrato suppression:** low-pass at ~5 Hz (Butterworth on the voiced runs) before taking per-note medians.

### 5.4 Note building (`notes.py`) — fix for P2
For each syllable window `[s, e]` (from Phase 4):
1. Core region: skip the first 20 % (consonant onset) and last 10 %, but at least 30 ms must remain. Use voiced frames only.
2. Pitch = weighted median of the cleaned MIDI floats (weights = voiced prob × RMS), then round.
3. **Split only if all of these hold** (all thresholds are config constants, tuned on the benchmark):
   - syllable duration ≥ 500 ms,
   - segment the cleaned contour with a change-point step detector (for example a 2-state Viterbi on the contour, or ruptures `Pelt`). Both plateaus ≥ 150 ms,
   - plateau medians differ by **≥ 2 semitones** (not 1) and each plateau has a std-dev < 0.6 st,
   - Basic Pitch (below) or the second tracker agrees on the change when available.
   Otherwise one note. Never create two notes for a glide or vibrato.
4. If the provider gives a tilde/melisma marker (`~`, repeated vowel), allow the split there with lower thresholds (≥ 1 semitone plateau).
5. Unvoiced syllables (all frames `NaN`): inherit the neighbour in the same phrase (previous, or next if first), mark as such in debug output.

### 5.5 Key and scale — soft prior only
1. Detect the key from the **vocal stem** and from the full mix. If they agree, confidence high. Otherwise lower the confidence.
2. Replace hard snapping: for each note, if `|midi_float − nearest_scale_tone| ≤ 0.35 st` snap to that scale tone. Otherwise keep the rounded measured pitch (accidentals and borrowed notes are legitimate). No snap at all when key confidence < 0.6.
3. Delete the `p75 ≥ 64 → +12` hack. Octave handling now lives in the contour repair (5.3). As a last global check: if the median MIDI of the whole song is < 45 or > 84, shift by whole octaves.

### 5.6 Basic Pitch — evaluate, then decide

Assessment: Basic Pitch (Spotify, polyphonic and instrument-agnostic, ~17k params) is **not expected to beat RMVPE/FCPE/CREPE-full for raw f0 on an isolated monophonic voice**. It quantizes pitch bends, is trained mostly on instruments and is weaker on breathy or fast vocals. Its useful strengths for us are the **note-event output (onset, offset, pitch)** and its **onset posteriorgram**, which can serve as an independent check against the contour tracker.

Plan: integrate as an **optional second opinion**, keep it only if the benchmark says so.
1. Add `karaoke/basicpitch_adapter.py` (`pip install basic-pitch`, use the ONNX or CoreML runtime on macOS to avoid TensorFlow weight). Output: note events `(start, end, midi, amplitude)` plus the onset probability curve.
2. Use it for two things only: (a) agreement vote for the split decision in 5.4 step 3, (b) tie-breaker for octave decisions when the f0 tracker and Basic Pitch disagree by exactly 12 st (prefer the one with the higher confidence, never average).
3. Benchmark matrix on `eval --stage pitch`: {RMVPE, FCPE, CREPE-full} × {with, without Basic Pitch voting}. Adopt Basic Pitch only if it gives ≥ 2 percentage points of strict pitch accuracy or reduces the false-split rate by ≥ 25 % relative. Otherwise leave the adapter in the repo, off by default (`--use-basic-pitch`).

**Done when (targets on the benchmark, relative to baseline):** strict ±1 st accuracy +15 points or more, false-split rate halved, and octave-agnostic accuracy ≥ 90 %. If a target is not reached, document the measured value and the best next lever in `eval/results/NOTES.md` instead of changing the target.

---

## Phase 6 – In-browser song generation (P6)

### 6.1 Resolver (`server.js`: `POST /api/resolve`)
Input: `{ "input": "<url or search text>" }`. Output: `{ title, artist, durationSec, artworkUrl, spotifyTrackId?, youtubeId?, isrc? }`.
- Spotify track URL or URI → parse the 22-char ID. Fetch metadata through the Spotify Web API when a token exists, else the oEmbed endpoint (`https://open.spotify.com/oembed?url=...`) plus the page `<meta>` tags for title, artist and artwork. Then find a YouTube match.
- YouTube URL (`watch?v=`, `youtu.be`, `music.youtube.com`) → video ID. Metadata from YouTube oEmbed or the existing scraping route. Title/artist parse (`Artist - Title (Official Video)` cleanup: strip brackets, `ft.`, `official`, `lyrics`). Then resolve a Spotify track ID by searching (Spotify Web API search if a token exists; else iTunes search + ISRC → ID, else skip: the lyrics chain then falls through to LRCLIB).
- Free text → reuse the existing search endpoints (`/api/search`, LRCLIB, iTunes) and return a list so the UI can let the user pick.
- Compare durations (±5 s) when matching YouTube to Spotify to avoid live and remix versions. Return `confidence`.

### 6.2 Audio fetch
- Use `yt-dlp` (`-x --audio-format wav` or `-f bestaudio`) spawned via `child_process.spawn` (no shell, args as an array, validate the video ID with `/^[\w-]{11}$/` before use). Write to `songs/<slug>/source.*`. Spotify audio is DRM-protected and **must not** be ripped. Only the matched YouTube audio is used. Check `yt-dlp` and `ffmpeg` at startup and expose the status in `/api/health`, with a clear UI message when missing.
- Also allow uploading an audio file (multipart without dependencies: stream the body to disk with a size cap of 80 MB, `Content-Type: audio/*`).

### 6.3 Job system (zero-dependency)
- In-memory job map persisted to `jobs/<id>.json`. One worker at a time (concurrency 1 for GPU/RAM), the rest queued.
- Endpoints:
  - `POST /api/jobs` `{ resolved, options }` → `{ jobId }`. Idempotent per `slug` (return the existing job or the finished song).
  - `GET /api/jobs/:id` → `{ status: queued|running|done|error, stage, progress, message, result? }`.
  - `GET /api/jobs/:id/events` → **Server-Sent Events** (native `http` supports it) streaming progress. Fallback: client polls every 2 s.
  - `POST /api/jobs/:id/cancel` → kill the child process tree.
- The worker: (1) `fetchLyrics` in Node → `lyrics.json`, (2) yt-dlp download, (3) spawn `./venv/bin/python generate_karaoke.py --json-progress --lyrics-json ... --audio ...`, parse stdout JSON lines → progress, (4) validate the result and move to `songs/<slug>/`.
- Stages and progress weights: resolve 5 %, lyrics 10 %, download 15 %, separate 30 %, align 15 %, pitch 15 %, write 10 %.
- Failure modes must produce readable messages: no lyrics found (offer Whisper fallback button), video unavailable, yt-dlp missing, Python venv missing, Demucs OOM.
- Only spawn with fixed argument arrays. Never interpolate user text into a shell string. Sanitize `slug` to `[a-z0-9-_]`, and make sure resolved paths stay inside `songs/`.

### 6.4 Song library
- `songs/<slug>/{song.txt,vocals.wav?,instrumental.wav,source.*,lyrics.json,meta.json,cover.jpg}` where `meta.json` has the `generator_version`, provider used, sync type and the eval-style quality score (fraction of syllables from provider timing).
- `GET /api/library` lists finished songs. `GET /songs/<slug>/...` serves files (path-safe static handler, Range support for audio).
- The playback side must be able to use `instrumental.wav` (or the YouTube video with offset) as before. Reuse the existing custom `.txt` loader code path in `public/app.js` and feed it from the library.

### 6.5 UI (`public/index.html`, `public/app.js`, `public/style.css`)
1. A new "Add song" panel in the lobby: one input accepting a link or search text, plus a results list. A "Generate" button per item.
2. Progress cards with stage names, a progress bar fed by SSE (with polling fallback), a cancel button, and error text with a retry.
3. A "Your generated songs" section from `/api/library`, with a badge: `Syllable-synced`, `Line-synced`, `AI-aligned` so users can see expected quality.
4. Settings: Spicy Lyrics key status, optional Spotify token status (`/api/lyrics/status` returns booleans only, never secrets), separator and pitch engine selects (advanced), and a "force Whisper" toggle.
5. Keep USDB login and search as an **optional** extra source. It is no longer the default path. Charts from USDB bypass generation.

**Done when:** pasting a Spotify or YouTube link in the browser produces a playable song with no terminal use, progress is visible, cancel works, and re-submitting the same link opens the cached song instantly.

---

## Phase 7 – Quality-of-life & safety net

1. **Chart editor** in the stage view (or a separate screen): shows the pitch contour with notes. Drag to shift a note's pitch ±1/±12 semitones and nudge start/end. Saves back to `songs/<slug>/song.txt` (`POST /api/library/:slug/chart`). Mark `meta.json.edited = true`.
2. **Render-time spacing:** UI draws a small visual gap between notes. The chart data is no longer modified for visuals (replaces the removed +6-beat rule).
3. **Debug export:** `--debug-dir` writes `contour.png` (f0, notes, syllable edges, lyrics), `report.json` (per-syllable evidence: pitch, plateaus, why-split), useful for agents debugging a bad song.
4. **Regression gate:** `npm test` (or a script `scripts/check.sh`) runs `node tests/engine_test.js`, `python -m unittest`, and `eval --stage all --songs "fast/*"` on a 3-song subset. It fails if a metric regresses by more than 2 points.
5. Update `README.md` and `AGENTS.md` (file map, new endpoints, new commands, new requirements). Pin versions in `requirements.txt`; add `yt-dlp`, `audio-separator`, `ctc-forced-aligner` (or `whisperx`), `basic-pitch` (optional), `ruptures`, `jiwer`.

---

## Cross-cutting rules for implementing agents

- Never commit secrets. Keys come from env or `config.local.json` (git-ignored). The server only reports whether a key is set.
- Respect provider terms and rate limits. Spotify color-lyrics is an unofficial endpoint, so keep it behind a flag and never make it a hard dependency. Do not download audio from Spotify. Do not redistribute lyrics: keep caches local and git-ignored (`lyrics_cache/`, `songs/`, `jobs/`, `output/`).
- Every new threshold is a named constant in `karaoke/config.py` with a comment on the benchmark that justified it.
- Every phase ends with: tests green, eval numbers recorded, `AGENTS.md` updated if invariants or commands changed.
- Prefer small, reviewable commits (one task each). If a verification step in this plan fails (for example the Spicy schema differs, or the Spotify token is rejected), write down the finding in `docs/decisions.md` and adapt the next steps. Do not guess.

## Open items to confirm with the project owner

1. Spicy Lyrics API key: who owns it and what are the rate limits? (Needed before Phase 2 can be tested end to end.)
2. Is a Spotify web-player token (`sp_dc` cookie) acceptable as an optional setting for the color-lyrics fallback?
3. Hardware target for the pipeline: Apple MPS or CPU only? (Decides `large-v3` vs `large-v3-turbo` and RMVPE vs FCPE as default.)
4. Is `yt-dlp` allowed as a runtime dependency, or must audio come from user uploads only?
