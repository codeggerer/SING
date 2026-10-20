/**
 * lib/jobs.js - Zero-Dependency Asynchronous Job Queue & Generation Worker (PLAN.md Phase 6.2 & 6.3)
 *
 * Implements:
 * - Single-concurrency worker for AI Karaoke Generation (to protect GPU/RAM)
 * - Persistent job storage in jobs/<id>.json
 * - Idempotency per song slug
 * - Progress mapping (resolve 5%, lyrics 10%, download 15%, separate 30%, align 15%, pitch 15%, write 10%)
 * - Server-Sent Events (SSE) streaming updates
 * - Clean job cancellation & process termination
 *
 * Zero external dependencies: native Node.js only.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { fetchLyrics } = require('./lyrics');
const { SONGS_DIR, listLibrarySongs } = require('./library');
const { createSongSlug } = require('./resolver');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const JOBS_DIR = path.join(PROJECT_ROOT, 'jobs');
const VENV_PYTHON = path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
const GENERATE_SCRIPT = path.join(PROJECT_ROOT, 'generate_karaoke.py');

if (!fs.existsSync(JOBS_DIR)) {
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
  } catch (_) {}
}

// In-memory state
const jobs = new Map();
const queue = [];
let isWorkerRunning = false;
let activeProcess = null;
const sseListeners = new Map(); // jobId -> Set<res>

// Enhanced PATH environment for subprocesses to locate yt-dlp & ffmpeg
function getExecutionEnv() {
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin'];
  const currentPath = process.env.PATH || '';
  const newPath = extraPaths.concat(currentPath.split(':')).filter(Boolean).join(':');
  return {
    ...process.env,
    PATH: newPath,
    PYTHONUNBUFFERED: '1',
  };
}

/**
 * Checks system readiness: yt-dlp, ffmpeg, python venv.
 */
function checkSystemHealth() {
  const env = getExecutionEnv();
  let ytDlpPath = null;
  let ffmpegPath = null;

  try {
    ytDlpPath = execFileSync('which', ['yt-dlp'], { env }).toString().trim();
  } catch (_) {}

  try {
    ffmpegPath = execFileSync('which', ['ffmpeg'], { env }).toString().trim();
  } catch (_) {}

  const pythonVenvAvailable = fs.existsSync(VENV_PYTHON);

  const isOk = !!(ytDlpPath && ffmpegPath && pythonVenvAvailable);

  return {
    status: isOk ? 'ok' : 'degraded',
    ytDlpAvailable: !!ytDlpPath,
    ytDlpPath,
    ffmpegAvailable: !!ffmpegPath,
    ffmpegPath,
    pythonVenvAvailable,
  };
}

/**
 * Downloads a binary file (such as cover art) from a remote URL.
 */
function downloadFile(sourceUrl, destPath) {
  return new Promise((resolve) => {
    if (!sourceUrl || !sourceUrl.startsWith('http')) return resolve(false);
    try {
      const parsed = new URL(sourceUrl);
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.get(sourceUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, sourceUrl).toString();
          return resolve(downloadFile(redirectUrl, destPath));
        }
        if (res.statusCode !== 200) return resolve(false);
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(true);
        });
        fileStream.on('error', () => resolve(false));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(8000, () => req.destroy());
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * Persists job state to disk.
 */
function persistJob(job) {
  job.updatedAt = Date.now();
  const filePath = path.join(JOBS_DIR, `${job.id}.json`);
  try {
    // Exclude runtime childProcess reference
    const { childProcess, ...serializable } = job;
    fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Emits SSE update to all connected listeners for a given job.
 */
function emitJobUpdate(job) {
  persistJob(job);
  const listeners = sseListeners.get(job.id);
  if (!listeners || listeners.size === 0) return;

  const payload = JSON.stringify({
    type: 'progress',
    job: {
      id: job.id,
      slug: job.slug,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message,
      canFallbackWhisper: !!job.canFallbackWhisper,
      result: job.result || null,
      error: job.error || null,
    },
  });

  for (const res of listeners) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (_) {}
  }
}

/**
 * Initializes existing jobs from disk on boot.
 */
function initJobs() {
  if (!fs.existsSync(JOBS_DIR)) return;
  const files = fs.readdirSync(JOBS_DIR);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(JOBS_DIR, f), 'utf8');
      const job = JSON.parse(raw);
      if (job && job.id) {
        // Any job that was active during crash/restart is marked as interrupted
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'error';
          job.error = 'Vorgang durch Server-Neustart abgebrochen.';
        }
        jobs.set(job.id, job);
      }
    } catch (_) {}
  }
}
initJobs();

/**
 * Creates or retrieves a job for given resolved track metadata and options.
 * Idempotent per slug!
 */
function createOrGetJob(resolved, options = {}) {
  const artist = (resolved.artist || 'Unknown').trim();
  const title = (resolved.title || 'Track').trim();
  const slug = resolved.slug || createSongSlug(artist, title);

  // 1. Check if the song is already generated in the library!
  const existingSongDir = path.join(SONGS_DIR, slug);
  const existingTxt = path.join(existingSongDir, 'song.txt');
  const existingInst = path.join(existingSongDir, 'instrumental.wav');

  if (fs.existsSync(existingTxt) && fs.existsSync(existingInst)) {
    let meta = {};
    const metaPath = path.join(existingSongDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {}
    }
    const cachedJobId = `cached_${slug}`;
    const cachedJob = {
      id: cachedJobId,
      slug,
      status: 'done',
      stage: 'done',
      progress: 100,
      message: 'Song bereits in der Bibliothek vorhanden!',
      resolved,
      options,
      result: {
        slug,
        title: meta.title || title,
        artist: meta.artist || artist,
        durationSec: meta.durationSec || resolved.durationSec || 0,
        chartUrl: `/songs/${encodeURIComponent(slug)}/song.txt`,
        instrumentalUrl: `/songs/${encodeURIComponent(slug)}/instrumental.wav`,
        coverUrl: fs.existsSync(path.join(existingSongDir, 'cover.jpg'))
          ? `/songs/${encodeURIComponent(slug)}/cover.jpg`
          : (meta.artworkUrl || null),
        syncType: meta.syncType || 'syllable',
        provider: meta.provider || 'spicylyrics',
        qualityScore: meta.qualityScore || 0.95,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    jobs.set(cachedJobId, cachedJob);
    return cachedJob;
  }

  // 2. Check if there's already an active (queued or running) job for this slug
  for (const existing of jobs.values()) {
    if (existing.slug === slug && (existing.status === 'queued' || existing.status === 'running')) {
      return existing;
    }
  }

  // 3. Create new job
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId,
    slug,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'In der Warteschlange...',
    resolved: {
      ...resolved,
      artist,
      title,
      slug,
    },
    options: {
      pitchEngine: options.pitchEngine || 'fcpe',
      separator: options.separator || 'demucs',
      quality: options.quality || 'balanced',
      device: options.device || 'auto',
      forceWhisper: !!options.forceWhisper,
      allowWhisperFallback: !!options.allowWhisperFallback,
      uploadedAudioPath: options.uploadedAudioPath || null,
    },
    lyricsSource: null,
    result: null,
    error: null,
    canFallbackWhisper: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(jobId, job);
  persistJob(job);

  queue.push(jobId);
  triggerWorker();

  return job;
}

/**
 * Gets a job by ID.
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Cancels a job.
 */
function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;

  if (job.status === 'queued') {
    const idx = queue.indexOf(jobId);
    if (idx !== -1) queue.splice(idx, 1);
    job.status = 'cancelled';
    job.message = 'Vorgang abgebrochen.';
    emitJobUpdate(job);
    return true;
  }

  if (job.status === 'running') {
    job.status = 'cancelled';
    job.message = 'Vorgang abgebrochen.';

    if (activeProcess) {
      try {
        activeProcess.kill('SIGTERM');
        setTimeout(() => {
          try {
            activeProcess.kill('SIGKILL');
          } catch (_) {}
        }, 2000);
      } catch (_) {}
    }

    emitJobUpdate(job);
    return true;
  }

  return false;
}

/**
 * Registers an HTTP Server-Sent Events (SSE) connection for a job.
 */
function registerJobSse(jobId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  if (!sseListeners.has(jobId)) {
    sseListeners.set(jobId, new Set());
  }
  const listeners = sseListeners.get(jobId);
  listeners.add(res);

  // Send current state immediately
  const currentJob = jobs.get(jobId);
  if (currentJob) {
    const payload = JSON.stringify({
      type: 'state',
      job: {
        id: currentJob.id,
        slug: currentJob.slug,
        status: currentJob.status,
        stage: currentJob.stage,
        progress: currentJob.progress,
        message: currentJob.message,
        canFallbackWhisper: !!currentJob.canFallbackWhisper,
        result: currentJob.result,
        error: currentJob.error,
      },
    });
    res.write(`data: ${payload}\n\n`);
  }

  // 15-second heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    listeners.delete(res);
  });
}

/**
 * Main queue runner.
 */
function triggerWorker() {
  if (isWorkerRunning) return;
  if (queue.length === 0) return;

  const nextJobId = queue.shift();
  const job = jobs.get(nextJobId);
  if (!job || job.status === 'cancelled') {
    return triggerWorker();
  }

  isWorkerRunning = true;
  runJobPipeline(job)
    .catch((err) => {
      if (job.status === 'cancelled') return;
      console.error(`[Job ${job.id}] Pipeline failure:`, err);
      job.status = 'error';
      job.error = err.message || 'Unerwarteter Fehler bei der Song-Generierung';
      emitJobUpdate(job);
    })
    .finally(() => {
      isWorkerRunning = false;
      activeProcess = null;
      triggerWorker();
    });
}

/**
 * Executes the complete 4-step generation pipeline for a single job:
 * 1. Lyrics retrieval (Node.js -> lyrics.json)
 * 2. Audio download (yt-dlp -> source.wav)
 * 3. AI Karaoke Generation (generate_karaoke.py --json-progress)
 * 4. Finalize (move files to songs/<slug>/, meta.json, cover.jpg)
 */
async function runJobPipeline(job) {
  const jobDir = path.join(JOBS_DIR, job.id);
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  job.status = 'running';
  job.stage = 'lyrics';
  job.progress = 5;
  job.message = 'Suche nach synchronisierten Song-Texten...';
  emitJobUpdate(job);

  const resolved = job.resolved;
  const options = job.options;
  const lyricsJsonPath = path.join(jobDir, 'lyrics.json');
  let lyricsDoc = null;

  // STEP 1: Lyrics Fetching (Node owns the lyrics provider keys)
  if (!options.forceWhisper) {
    try {
      lyricsDoc = await fetchLyrics({
        title: resolved.title,
        artist: resolved.artist,
        durationSec: resolved.durationSec || 0,
        spotifyTrackId: resolved.spotifyTrackId || '',
      });
    } catch (err) {
      console.warn(`[Job ${job.id}] Lyrics fetch warning:`, err.message);
    }
  }

  if (lyricsDoc) {
    fs.writeFileSync(lyricsJsonPath, JSON.stringify(lyricsDoc, null, 2), 'utf8');
    job.lyricsSource = lyricsDoc.source;
    job.progress = 15;
    job.message = `Lyrics gefunden (${lyricsDoc.source}, ${lyricsDoc.syncType}-Sync)!`;
    emitJobUpdate(job);
  } else {
    if (options.forceWhisper || options.allowWhisperFallback) {
      job.lyricsSource = 'whisper';
      job.progress = 15;
      job.message = 'Verwende automatische Whisper KI-Spracherkennung...';
      emitJobUpdate(job);
    } else {
      job.canFallbackWhisper = true;
      job.status = 'error';
      job.error =
        'Keine synchronisierten Lyrics gefunden. Möchtest du stattdessen die automatische Whisper-Transkription nutzen?';
      emitJobUpdate(job);
      return;
    }
  }

  if (job.status === 'cancelled') return;

  // STEP 2: Audio Acquisition (yt-dlp or uploaded file)
  job.stage = 'download';
  job.progress = 18;
  job.message = 'Bereite Audio vor...';
  emitJobUpdate(job);

  let sourceAudioPath = path.join(jobDir, 'source.wav');

  if (options.uploadedAudioPath && fs.existsSync(options.uploadedAudioPath)) {
    // Audio file was uploaded directly
    fs.copyFileSync(options.uploadedAudioPath, sourceAudioPath);
    job.progress = 30;
    job.message = 'Hochgeladene Audiodatei übernommen.';
    emitJobUpdate(job);
  } else {
    // Download via yt-dlp from YouTube
    const ytId = resolved.youtubeId;
    if (!ytId || !/^[\w-]{11}$/.test(ytId)) {
      throw new Error(`Ungültige YouTube Video ID: "${ytId}"`);
    }

    job.message = 'Lade Studio-Audio von YouTube herunter (yt-dlp)...';
    emitJobUpdate(job);

    await new Promise((resolve, reject) => {
      const args = [
        '-x',
        '--audio-format',
        'wav',
        '--audio-quality',
        '0',
        '--no-playlist',
        '--no-check-certificates',
        '-o',
        path.join(jobDir, 'source.%(ext)s'),
        `https://www.youtube.com/watch?v=${ytId}`,
      ];

      const proc = spawn('yt-dlp', args, { env: getExecutionEnv() });
      activeProcess = proc;
      job.childProcess = proc;

      proc.stdout.on('data', (data) => {
        const line = data.toString();
        // Parse yt-dlp percentage
        const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (m) {
          const pct = parseFloat(m[1]);
          job.progress = Math.min(29, Math.round(18 + (pct / 100) * 11));
          emitJobUpdate(job);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Check for created source.wav (or source.*)
          const files = fs.readdirSync(jobDir);
          const found = files.find((f) => f.startsWith('source.') && f.endsWith('.wav'));
          if (found) {
            sourceAudioPath = path.join(jobDir, found);
            resolve();
          } else {
            // Find any source.* and use it
            const anySource = files.find((f) => f.startsWith('source.'));
            if (anySource) {
              sourceAudioPath = path.join(jobDir, anySource);
              resolve();
            } else {
              reject(new Error('Audio-Download fehlgeschlagen: keine Audiodatei erzeugt'));
            }
          }
        } else {
          if (job.status === 'cancelled') {
            return reject(new Error('Vorgang abgebrochen'));
          }
          reject(new Error(`yt-dlp beendet mit Fehlercode ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Fehler beim Starten von yt-dlp: ${err.message}`));
      });
    });
  }

  if (job.status === 'cancelled') return;

  // STEP 3: Spawning Python AI Generator (generate_karaoke.py)
  job.stage = 'separate';
  job.progress = 30;
  job.message = 'Initialisiere KI-Stimmtrennung...';
  emitJobUpdate(job);

  if (!fs.existsSync(VENV_PYTHON)) {
    throw new Error('Python Virtual Environment nicht gefunden (./venv/bin/python fehlt)');
  }

  const pyArgs = [
    GENERATE_SCRIPT,
    sourceAudioPath,
    '--artist',
    resolved.artist,
    '--title',
    resolved.title,
    '--output_dir',
    jobDir,
    '--pitch-engine',
    options.pitchEngine || 'fcpe',
    '--separator',
    options.separator || 'demucs',
    '--quality',
    options.quality || 'balanced',
    '--json-progress',
  ];

  if (options.device && options.device !== 'auto') {
    pyArgs.push('--device', options.device);
  }

  if (fs.existsSync(lyricsJsonPath)) {
    pyArgs.push('--lyrics-json', lyricsJsonPath);
  }

  let finalGeneratorPayload = null;

  await new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, pyArgs, { env: getExecutionEnv() });
    activeProcess = proc;
    job.childProcess = proc;

    let leftover = '';

    proc.stdout.on('data', (chunk) => {
      const text = leftover + chunk.toString();
      const lines = text.split('\n');
      leftover = lines.pop(); // keep uncompleted line

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('{') || !line.endsWith('}')) continue;

        try {
          const ev = JSON.parse(line);
          if (ev.status === 'done') {
            finalGeneratorPayload = ev;
          } else if (ev.status === 'error') {
            return reject(new Error(ev.message || 'Fehler in KI-Pipeline'));
          } else if (ev.stage && typeof ev.fraction === 'number') {
            // Map stage fractions to overall progress
            // separate: 30 -> 60%
            // align:    60 -> 75%
            // pitch:    75 -> 90%
            // chart:    90 -> 98%
            let stageBase = 30;
            let stageSpan = 30;
            if (ev.stage === 'separate') {
              stageBase = 30;
              stageSpan = 30;
              job.stage = 'separate';
            } else if (ev.stage === 'align' || ev.stage === 'lyrics') {
              stageBase = 60;
              stageSpan = 15;
              job.stage = 'align';
            } else if (ev.stage === 'pitch') {
              stageBase = 75;
              stageSpan = 15;
              job.stage = 'pitch';
            } else if (ev.stage === 'chart' || ev.stage === 'write') {
              stageBase = 90;
              stageSpan = 8;
              job.stage = 'finalize';
            }
            job.progress = Math.min(98, Math.round(stageBase + ev.fraction * stageSpan));
            if (ev.message) job.message = ev.message;
            emitJobUpdate(job);
          }
        } catch (_) {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      // Stream stderr diagnostics if needed
      const msg = chunk.toString();
      if (msg.includes('OutOfMemoryError') || msg.includes('CUDA out of memory')) {
        reject(new Error('Speicherfehler (Out of Memory) während der KI-Verarbeitung'));
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        if (job.status === 'cancelled') {
          return reject(new Error('Vorgang abgebrochen'));
        }
        reject(new Error(`KI-Pipeline beendet mit Fehlercode ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Konnte Python-Prozess nicht ausführen: ${err.message}`));
    });
  });

  if (job.status === 'cancelled') return;

  // STEP 4: Finalization & Song Library Assembly
  job.stage = 'finalize';
  job.progress = 98;
  job.message = 'Erstelle Song-Bibliothek und Cover...';
  emitJobUpdate(job);

  const slug = job.slug;
  const targetSongDir = path.join(SONGS_DIR, slug);
  if (!fs.existsSync(targetSongDir)) {
    fs.mkdirSync(targetSongDir, { recursive: true });
  }

  // Find generated .txt and instrumental .wav in jobDir (or from finalGeneratorPayload)
  const jobFiles = fs.readdirSync(jobDir);
  const genTxt = jobFiles.find((f) => f.endsWith('.txt') && !f.includes('lyrics'));
  const genInst = jobFiles.find((f) => f.includes('[Instrumental]') || f.includes('instrumental') || f.includes('no_vocals'));
  const genVocals = jobFiles.find((f) => f.includes('[Vocals]') || f.includes('vocals'));

  if (!genTxt) {
    throw new Error('UltraStar Noten-Datei (.txt) wurde nicht generiert');
  }

  // Move or copy files to songs/<slug>/
  fs.copyFileSync(path.join(jobDir, genTxt), path.join(targetSongDir, 'song.txt'));
  if (genInst) {
    fs.copyFileSync(path.join(jobDir, genInst), path.join(targetSongDir, 'instrumental.wav'));
  }
  if (genVocals) {
    fs.copyFileSync(path.join(jobDir, genVocals), path.join(targetSongDir, 'vocals.wav'));
  }
  if (fs.existsSync(lyricsJsonPath)) {
    fs.copyFileSync(lyricsJsonPath, path.join(targetSongDir, 'lyrics.json'));
  }

  // Download cover art if available
  const coverPath = path.join(targetSongDir, 'cover.jpg');
  if (resolved.artworkUrl) {
    await downloadFile(resolved.artworkUrl, coverPath);
  }

  // Compute quality score based on syncType
  let qualityScore = 0.8;
  const syncType = lyricsDoc?.syncType || (options.forceWhisper ? 'whisper' : 'whisper');
  if (syncType === 'syllable') qualityScore = 0.98;
  else if (syncType === 'word' || syncType === 'line') qualityScore = 0.88;
  else qualityScore = 0.72;

  // Write meta.json
  const meta = {
    generator_version: '5.0',
    slug,
    title: resolved.title,
    artist: resolved.artist,
    durationSec: resolved.durationSec || 0,
    youtubeId: resolved.youtubeId || '',
    spotifyTrackId: resolved.spotifyTrackId || '',
    isrc: resolved.isrc || '',
    artworkUrl: resolved.artworkUrl || '',
    provider: lyricsDoc?.source || 'whisper',
    syncType,
    qualityScore,
    pitchEngine: options.pitchEngine || 'fcpe',
    separator: options.separator || 'demucs',
    hardware: finalGeneratorPayload?.hardware || null,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(targetSongDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  // Clean up source.wav in jobDir to save disk space
  try {
    if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath);
  } catch (_) {}

  // Complete job!
  job.status = 'done';
  job.stage = 'done';
  job.progress = 100;
  job.message = 'Fertig! Song ist jetzt spielbereit.';
  job.result = {
    slug,
    title: meta.title,
    artist: meta.artist,
    durationSec: meta.durationSec,
    chartUrl: `/songs/${encodeURIComponent(slug)}/song.txt`,
    instrumentalUrl: `/songs/${encodeURIComponent(slug)}/instrumental.wav`,
    coverUrl: fs.existsSync(coverPath)
      ? `/songs/${encodeURIComponent(slug)}/cover.jpg`
      : (resolved.artworkUrl || null),
    syncType,
    provider: meta.provider,
    qualityScore,
  };

  emitJobUpdate(job);
}

module.exports = {
  JOBS_DIR,
  checkSystemHealth,
  createOrGetJob,
  getJob,
  cancelJob,
  registerJobSse,
  triggerWorker,
};
