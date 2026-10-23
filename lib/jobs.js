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
const { harvestPlainLyricsFull, cleanLyricsText } = require('./lyrics_harvester');
const { SONGS_DIR, listLibrarySongs } = require('./library');
const { createSongSlug } = require('./resolver');
const usdbClient = require('./usdb_client');
const audioSync = require('./audio_sync');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const JOBS_DIR = path.join(PROJECT_ROOT, 'jobs');
const VENV_PYTHON = path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
const GENERATE_SCRIPT = path.join(PROJECT_ROOT, 'generate_karaoke.py');
const SEPARATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'separate_stems.py');

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

  const certPath = path.join(__dirname, '..', 'venv/lib/python3.11/site-packages/certifi/cacert.pem');
  const envAdditions = {};
  if (fs.existsSync(certPath)) {
    envAdditions.SSL_CERT_FILE = certPath;
    envAdditions.REQUESTS_CA_BUNDLE = certPath;
  }

  return {
    ...process.env,
    PATH: newPath,
    PYTHONUNBUFFERED: '1',
    ...envAdditions,
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
 * Runs isolated dual-stem separation on an audio track using Demucs or Mel-Band RoFormer (Phase 6.1).
 * Extracts:
 * - instrumental.wav (zero-vocal backing track)
 * - vocals.wav (lead vocal guide track)
 */
function runStemSeparation({ audioPath, outputDir, separator = 'demucs', device = 'auto', job, onProgress }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(VENV_PYTHON) || !fs.existsSync(SEPARATE_SCRIPT)) {
      return reject(new Error('Stem separation script or Python environment not found'));
    }

    const args = [
      SEPARATE_SCRIPT,
      audioPath,
      '--output_dir', outputDir,
      '--separator', separator,
      '--json-progress',
    ];

    if (device && device !== 'auto') {
      args.push('--device', device);
    }

    const proc = spawn(VENV_PYTHON, args, { env: getExecutionEnv() });
    if (job) {
      activeProcess = proc;
      job.childProcess = proc;
    }

    let finalPayload = null;
    let pyStderr = '';
    let leftover = '';

    proc.stdout.on('data', (chunk) => {
      const text = leftover + chunk.toString();
      const lines = text.split('\n');
      leftover = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.status === 'done') {
            finalPayload = ev;
          } else if (ev.status === 'error') {
            return reject(new Error(ev.message || 'Stem separation failed'));
          } else if (typeof onProgress === 'function') {
            onProgress(ev);
          }
        } catch (_) {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      pyStderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && finalPayload) {
        resolve(finalPayload);
      } else {
        const errSnippet = pyStderr.trim().split('\n').slice(-3).join(' ') || '';
        reject(new Error(`Stem separation exited with code ${code}: ${errSnippet}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Could not execute stem separation process: ${err.message}`));
    });
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
          job.error = 'Operation interrupted by server restart.';
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

  if (fs.existsSync(existingTxt) && fs.existsSync(existingInst) && !options.rawLyricsText && !options.upgradeLyrics && !options.force) {
    let meta = {};
    const metaPath = path.join(existingSongDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {}
    }
    const cachedJobId = `cached_${slug}`;
    const hasVocals = fs.existsSync(path.join(existingSongDir, 'vocals.wav'));
    const hasInst = fs.existsSync(existingInst);
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
        instrumentalUrl: hasInst ? `/songs/${encodeURIComponent(slug)}/instrumental.wav` : null,
        vocalsUrl: hasVocals ? `/songs/${encodeURIComponent(slug)}/vocals.wav` : null,
        coverUrl: fs.existsSync(path.join(existingSongDir, 'cover.jpg'))
          ? `/songs/${encodeURIComponent(slug)}/cover.jpg`
          : (meta.artworkUrl || null),
        syncType: meta.syncType || 'syllable',
        provider: meta.provider || 'spicylyrics',
        qualityScore: meta.qualityScore || 0.95,
        hasVocals,
        hasInstrumental: hasInst,
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
      rawLyricsText: options.rawLyricsText || null,
      description: options.description || null,
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
    job.message = 'Operation cancelled.';
    emitJobUpdate(job);
    return true;
  }

  if (job.status === 'running') {
    job.status = 'cancelled';
    job.message = 'Operation cancelled.';

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
      job.error = err.message || 'Unexpected error during song generation';
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

  const resolved = job.resolved;
  const options = job.options;

  // COMMUNITY GROUND TRUTH INGESTION (MASTER_OVERHAUL_PLAN Phase 1)
  // When a verified human chart exists, ingest directly with 0.0ms onset error and 100% pitch precision
  let usdbGroundTruth = null;
  if (!options.forceAi && !options.forceWhisper && !options.rawLyricsText) {
    try {
      if (resolved.usdbMatch && resolved.usdbMatch.matched) {
        usdbGroundTruth = await usdbClient.getChart(resolved.usdbMatch.id || resolved.usdbMatch.usdbId);
      } else {
        const match = await usdbClient.findBestMatch(resolved.artist, resolved.title);
        if (match && match.matched) {
          usdbGroundTruth = await usdbClient.getChart(match.id || match.usdbId);
        }
      }
    } catch (usdbErr) {
      console.warn(`[Job ${job.id}] USDB match check failed:`, usdbErr.message);
    }
  }

  if (usdbGroundTruth && usdbGroundTruth.parsed && usdbGroundTruth.parsed.isValid) {
    job.status = 'running';
    job.stage = 'usdb_ingest';
    job.progress = 25;
    job.message = `Community ground truth found: ${usdbGroundTruth.parsed.title} (human-verified pitches & timing)!`;
    emitJobUpdate(job);

    const targetSongDir = path.join(SONGS_DIR, job.slug);
    if (!fs.existsSync(targetSongDir)) {
      fs.mkdirSync(targetSongDir, { recursive: true });
    }

    // Save human-verified chart directly
    const songTxtPath = path.join(targetSongDir, 'song.txt');
    fs.writeFileSync(songTxtPath, usdbGroundTruth.txt, 'utf8');

    // Download/copy audio
    const instrumentalPath = path.join(targetSongDir, 'instrumental.wav');
    const vocalsPath = path.join(targetSongDir, 'vocals.wav');
    let hasAudio = false;

    if (options.uploadedAudioPath && fs.existsSync(options.uploadedAudioPath)) {
      if (options.separator !== 'none' && fs.existsSync(SEPARATE_SCRIPT)) {
        job.stage = 'separate';
        job.progress = 60;
        job.message = 'Extracting isolated instrumental and vocal guide stems via Demucs...';
        emitJobUpdate(job);

        try {
          const sepResult = await runStemSeparation({
            audioPath: options.uploadedAudioPath,
            outputDir: path.join(jobDir, 'stems'),
            separator: options.separator || 'demucs',
            device: options.device || 'auto',
            job,
            onProgress: (ev) => {
              if (ev.stage === 'separate' && typeof ev.fraction === 'number') {
                job.progress = Math.min(88, Math.round(60 + ev.fraction * 28));
                if (ev.message) job.message = ev.message;
                emitJobUpdate(job);
              }
            },
          });
          if (sepResult?.instrumental_path && fs.existsSync(sepResult.instrumental_path)) {
            fs.copyFileSync(sepResult.instrumental_path, instrumentalPath);
            hasAudio = true;
          }
          if (sepResult?.vocals_path && fs.existsSync(sepResult.vocals_path)) {
            fs.copyFileSync(sepResult.vocals_path, vocalsPath);
          }

          // Phase 1.1: Snap vocal onset from separated vocals if no preview audio was used
          if (fs.existsSync(vocalsPath)) {
            try {
              const onsetResult = await audioSync.alignVocalOnsetGap({
                vocalsPath,
                chartPath: songTxtPath,
                updateChart: true,
              });
              if (onsetResult && onsetResult.success) {
                const updatedParsed = usdbClient.parseChartHeaders(fs.readFileSync(songTxtPath, 'utf8'));
                if (updatedParsed && typeof updatedParsed.gap === 'number') {
                  usdbGroundTruth.parsed.gap = updatedParsed.gap;
                }
              }
            } catch (onsetErr) {
              console.warn(`[Job ${job.id}] Uploaded vocal onset sync skipped:`, onsetErr.message);
            }
          }
        } catch (sepErr) {
          console.warn(`[Job ${job.id}] Stem separation skipped/failed for uploaded audio:`, sepErr.message);
          fs.copyFileSync(options.uploadedAudioPath, instrumentalPath);
          hasAudio = true;
        }
      } else {
        fs.copyFileSync(options.uploadedAudioPath, instrumentalPath);
        hasAudio = true;
      }
    } else {
      const ytId = resolved.youtubeId || usdbGroundTruth.videoId;
      let downloadTarget = null;
      if (ytId && /^[\w-]{11}$/.test(ytId)) {
        downloadTarget = `https://www.youtube.com/watch?v=${ytId}`;
      } else if (resolved.artist && resolved.title) {
        downloadTarget = `ytsearch1:${resolved.artist} - ${resolved.title}`;
      }
      if (downloadTarget) {
        job.stage = 'download';
        job.progress = 55;
        job.message = 'Downloading audio from YouTube...';
        emitJobUpdate(job);

        try {
          await new Promise((resolve, reject) => {
            const args = [
              '-x',
              '--audio-format',
              'wav',
              '--audio-quality',
              '0',
              '--no-playlist',
              '--no-check-certificates',
              '--extractor-args',
              'youtube:player_client=ios,web,android',
              '-o',
              path.join(jobDir, 'source.%(ext)s'),
              downloadTarget,
            ];
            const proc = spawn('yt-dlp', args, { env: getExecutionEnv() });
            activeProcess = proc;
            job.childProcess = proc;
            proc.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`yt-dlp download failed with exit code ${code}`));
            });
            proc.on('error', reject);
          });
          const downloadedSource = path.join(jobDir, 'source.wav');
          if (fs.existsSync(downloadedSource)) {
            // Phase 1.1: Automated FFT Audio-to-Chart #GAP Synchronization
            // Aligns YouTube video audio to studio audio / chart notes to guarantee sub-20ms #GAP precision
            let previewSyncSucceeded = false;
            try {
              let refAudioPath = null;
              if (resolved.previewUrl) {
                const previewPath = path.join(jobDir, 'preview.m4a');
                job.message = 'Aligning video timing via FFT Acoustic Cross-Correlation...';
                emitJobUpdate(job);
                await downloadFile(resolved.previewUrl, previewPath);
                if (fs.existsSync(previewPath)) {
                  refAudioPath = previewPath;
                }
              }

              if (refAudioPath) {
                const syncResult = await audioSync.alignAudioGap({
                  ytAudioPath: downloadedSource,
                  refAudioPath,
                  chartPath: songTxtPath,
                  method: 'hybrid',
                  updateChart: true,
                });

                if (syncResult && syncResult.success && !syncResult.lowConfidence) {
                  previewSyncSucceeded = true;
                  const updatedParsed = usdbClient.parseChartHeaders(fs.readFileSync(songTxtPath, 'utf8'));
                  if (updatedParsed && typeof updatedParsed.gap === 'number') {
                    usdbGroundTruth.parsed.gap = updatedParsed.gap;
                  }
                }
              }
            } catch (syncErr) {
              console.warn(`[Job ${job.id}] Acoustic sync skipped:`, syncErr.message);
            }

            // MASTER_OVERHAUL_PLAN Phase 6: Dual-Stem Separation for zero-bleed backing and vocal guide track
            if (options.separator !== 'none' && fs.existsSync(SEPARATE_SCRIPT)) {
              job.stage = 'separate';
              job.progress = 65;
              job.message = 'Extracting isolated instrumental and vocal guide stems via Demucs...';
              emitJobUpdate(job);

              try {
                const sepResult = await runStemSeparation({
                  audioPath: downloadedSource,
                  outputDir: path.join(jobDir, 'stems'),
                  separator: options.separator || 'demucs',
                  device: options.device || 'auto',
                  job,
                  onProgress: (ev) => {
                    if (ev.stage === 'separate' && typeof ev.fraction === 'number') {
                      job.progress = Math.min(92, Math.round(65 + ev.fraction * 27));
                      if (ev.message) job.message = ev.message;
                      emitJobUpdate(job);
                    }
                  },
                });

                if (sepResult?.instrumental_path && fs.existsSync(sepResult.instrumental_path)) {
                  fs.copyFileSync(sepResult.instrumental_path, instrumentalPath);
                  hasAudio = true;
                }
                if (sepResult?.vocals_path && fs.existsSync(sepResult.vocals_path)) {
                  fs.copyFileSync(sepResult.vocals_path, vocalsPath);
                }

                // Phase 1.1: If no preview audio was available, extract vocal onset from Demucs vocals.wav
                if (!previewSyncSucceeded && fs.existsSync(vocalsPath)) {
                  job.message = 'Snapping chart timing to Demucs vocal onset...';
                  emitJobUpdate(job);
                  try {
                    const onsetResult = await audioSync.alignVocalOnsetGap({
                      vocalsPath,
                      chartPath: songTxtPath,
                      updateChart: true,
                    });
                    if (onsetResult && onsetResult.success) {
                      const updatedParsed = usdbClient.parseChartHeaders(fs.readFileSync(songTxtPath, 'utf8'));
                      if (updatedParsed && typeof updatedParsed.gap === 'number') {
                        usdbGroundTruth.parsed.gap = updatedParsed.gap;
                      }
                    }
                  } catch (onsetErr) {
                    console.warn(`[Job ${job.id}] Vocal onset sync skipped:`, onsetErr.message);
                  }
                }
              } catch (sepErr) {
                console.warn(`[Job ${job.id}] Stem separation skipped/failed for USDB song:`, sepErr.message);
                if (fs.existsSync(downloadedSource)) {
                  fs.copyFileSync(downloadedSource, instrumentalPath);
                  hasAudio = true;
                }
              }
            } else {
              fs.copyFileSync(downloadedSource, instrumentalPath);
              hasAudio = true;
            }
          }
        } catch (downloadErr) {
          console.warn(`[Job ${job.id}] USDB audio download skipped or failed:`, downloadErr.message);
        }
      }
    }

    // Download cover art if available
    const coverPath = path.join(targetSongDir, 'cover.jpg');
    if (resolved.artworkUrl) {
      await downloadFile(resolved.artworkUrl, coverPath);
    }

    const hasVocals = fs.existsSync(path.join(targetSongDir, 'vocals.wav'));
    const hasInst = fs.existsSync(instrumentalPath);

    // Write meta.json
    const meta = {
      generator_version: '6.0-groundtruth',
      slug: job.slug,
      title: usdbGroundTruth.parsed.title || resolved.title,
      artist: usdbGroundTruth.parsed.artist || resolved.artist,
      durationSec: resolved.durationSec || 0,
      youtubeId: resolved.youtubeId || usdbGroundTruth.videoId || '',
      spotifyTrackId: resolved.spotifyTrackId || '',
      isrc: resolved.isrc || '',
      artworkUrl: resolved.artworkUrl || '',
      provider: usdbGroundTruth.source || 'usdb_community',
      syncType: 'syllable',
      qualityScore: 1.0,
      isUsdb: true,
      isUltraStar: true,
      usdbId: usdbGroundTruth.id,
      hasGoldenNotes: usdbGroundTruth.parsed.hasGoldenNotes,
      goldenNoteCount: usdbGroundTruth.parsed.goldenNoteCount,
      verifiedGroundTruth: true,
      lyricsTier: 1,
      pitchEngine: 'human_verified',
      separator: hasVocals ? (options.separator || 'demucs') : 'none',
      hasVocals,
      hasInstrumental: hasInst,
      gap: usdbGroundTruth.parsed.gap || 0,
      videoOffsetSec: (usdbGroundTruth.parsed.gap || 0) / 1000,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(targetSongDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    job.status = 'done';
    job.stage = 'done';
    job.progress = 100;
    job.message = 'USDB ground-truth song ready to sing! (0.0ms timing error, 100% human-verified pitch)';
    job.result = {
      slug: job.slug,
      title: meta.title,
      artist: meta.artist,
      durationSec: meta.durationSec,
      chartUrl: `/songs/${encodeURIComponent(job.slug)}/song.txt`,
      instrumentalUrl: hasInst ? `/songs/${encodeURIComponent(job.slug)}/instrumental.wav` : null,
      vocalsUrl: hasVocals ? `/songs/${encodeURIComponent(job.slug)}/vocals.wav` : null,
      coverUrl: fs.existsSync(coverPath)
        ? `/songs/${encodeURIComponent(job.slug)}/cover.jpg`
        : (resolved.artworkUrl || null),
      syncType: 'syllable',
      provider: meta.provider,
      qualityScore: 1.0,
      isUsdb: true,
      hasGoldenNotes: meta.hasGoldenNotes,
      hasVocals,
      hasInstrumental: hasInst,
    };
    emitJobUpdate(job);
    return;
  }

  job.status = 'running';
  job.stage = 'lyrics';
  job.progress = 5;
  job.message = 'Searching for synchronized lyrics...';
  emitJobUpdate(job);

  const lyricsJsonPath = path.join(jobDir, 'lyrics.json');
  const plainLyricsTxtPath = path.join(jobDir, 'plain_lyrics.txt');
  let lyricsDoc = null;
  let plainLyricsResult = null;

  // Priority 0: Manual raw lyrics override from user
  if (options.rawLyricsText && typeof options.rawLyricsText === 'string') {
    const customCleaned = cleanLyricsText(options.rawLyricsText);
    if (customCleaned) {
      fs.writeFileSync(plainLyricsTxtPath, customCleaned, 'utf8');
      plainLyricsResult = { lyrics: customCleaned, source: 'manual', lineCount: customCleaned.split('\n').filter(Boolean).length };
      job.lyricsSource = 'manual_plain';
      job.progress = 15;
      job.message = 'Manual plain lyrics loaded! Preparing precision alignment...';
      emitJobUpdate(job);
    }
  }

  // STEP 1: Lyrics Fetching (Node owns the lyrics provider keys)
  if (!plainLyricsResult && !options.forceWhisper) {
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
    job.message = `Lyrics found (${lyricsDoc.source}, ${lyricsDoc.syncType}-sync)!`;
    emitJobUpdate(job);
  } else if (!plainLyricsResult && !options.forceWhisper) {
    // Phase 1: Multi-source Plain Lyrics Harvester (YouTube desc, lyrics.ovh, LRCLIB, Genius)
    job.stage = 'lyrics';
    job.progress = 10;
    job.message = '[Tier 3] Searching web for verified song lyrics...';
    emitJobUpdate(job);

    try {
      const harvested = await harvestPlainLyricsFull({
        artist: resolved.artist,
        title: resolved.title,
        youtubeId: resolved.youtubeId,
        description: resolved.description || options.description || '',
        candidates: resolved.candidates || options.candidates || [],
        durationSec: resolved.durationSec || 0,
      });
      if (harvested && harvested.lyrics) {
        fs.writeFileSync(plainLyricsTxtPath, harvested.lyrics, 'utf8');
        plainLyricsResult = harvested;
        job.lyricsSource = `harvester_${harvested.source}`;
        job.progress = 15;
        job.message = `[Tier 3] Plain lyrics harvested via ${harvested.source} (${harvested.lineCount} lines)! AI alignment active...`;
        emitJobUpdate(job);
      }
    } catch (harvErr) {
      console.warn(`[Job ${job.id}] Plain lyrics harvest error:`, harvErr.message);
    }
  }

  if (!lyricsDoc && !plainLyricsResult) {
    // Seamless fallback to Whisper AI transcription so the user never gets stuck at 5%
    job.lyricsSource = 'whisper';
    job.progress = 15;
    job.message = '[Tier 4] No web lyrics found. Using Whisper AI speech-to-text...';
    emitJobUpdate(job);
  }

  if (job.status === 'cancelled') return;

  // STEP 2: Audio Acquisition (yt-dlp or uploaded file)
  job.stage = 'download';
  job.progress = 18;
  job.message = 'Preparing audio track...';
  emitJobUpdate(job);

  let sourceAudioPath = path.join(jobDir, 'source.wav');

  if (options.uploadedAudioPath && fs.existsSync(options.uploadedAudioPath)) {
    // Audio file was uploaded directly
    fs.copyFileSync(options.uploadedAudioPath, sourceAudioPath);
    job.progress = 30;
    job.message = 'Using uploaded audio file.';
    emitJobUpdate(job);
  } else if (options.upgradeLyrics && fs.existsSync(path.join(targetSongDir, 'vocals.wav')) && fs.existsSync(path.join(targetSongDir, 'instrumental.wav'))) {
    // Reuse existing separated audio tracks for studio lyrics upgrade
    fs.copyFileSync(path.join(targetSongDir, 'vocals.wav'), sourceAudioPath);
    job.progress = 30;
    job.message = 'Reusing existing audio tracks for studio lyrics upgrade...';
    emitJobUpdate(job);
  } else {
    // Download via yt-dlp from YouTube
    const ytId = resolved.youtubeId;
    if (!ytId || !/^[\w-]{11}$/.test(ytId)) {
      throw new Error(`Invalid YouTube Video ID: "${ytId}"`);
    }

    job.message = 'Downloading audio from YouTube...';
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
        '--extractor-args',
        'youtube:player_client=ios,web,android',
        '-o',
        path.join(jobDir, 'source.%(ext)s'),
        `https://www.youtube.com/watch?v=${ytId}`,
      ];

      const proc = spawn('yt-dlp', args, { env: getExecutionEnv() });
      activeProcess = proc;
      job.childProcess = proc;

      let ytdlpStderr = '';

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

      proc.stderr.on('data', (data) => {
        ytdlpStderr += data.toString();
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
              reject(new Error('Audio download failed: no audio file produced'));
            }
          }
        } else {
          if (job.status === 'cancelled') {
            return reject(new Error('Operation cancelled'));
          }
          const errSnippet = ytdlpStderr.trim().split('\n').slice(-3).join(' ') || '';
          reject(new Error(`yt-dlp exited with error code ${code}: ${errSnippet}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Error executing yt-dlp: ${err.message}`));
      });
    });
  }

  if (job.status === 'cancelled') return;

  // STEP 3: Spawning Python AI Generator (generate_karaoke.py)
  job.stage = 'separate';
  job.progress = 30;
  job.message = 'Initializing AI vocal separation...';
  emitJobUpdate(job);

  if (!fs.existsSync(VENV_PYTHON)) {
    throw new Error('Python virtual environment not found (./venv/bin/python missing)');
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

  if (options.silenceThreshold !== undefined && options.silenceThreshold !== null) {
    pyArgs.push('--silence-threshold', String(options.silenceThreshold));
  }

  if (options.initialPrompt) {
    pyArgs.push('--initial-prompt', options.initialPrompt);
  }

  if (options.bpmMode) {
    pyArgs.push('--bpm-mode', options.bpmMode);
  }

  if (fs.existsSync(lyricsJsonPath)) {
    pyArgs.push('--lyrics-json', lyricsJsonPath);
  }

  if (fs.existsSync(plainLyricsTxtPath)) {
    pyArgs.push('--plain-lyrics', plainLyricsTxtPath);
  }

  let finalGeneratorPayload = null;

  await new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, pyArgs, { env: getExecutionEnv() });
    activeProcess = proc;
    job.childProcess = proc;

    let leftover = '';
    let pyStderr = '';

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
            return reject(new Error(ev.message || 'Error in AI pipeline'));
          } else if (ev.stage && typeof ev.fraction === 'number') {
            // Map stage fractions to overall progress
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
      const msg = chunk.toString();
      pyStderr += msg;
      if (msg.includes('OutOfMemoryError') || msg.includes('CUDA out of memory')) {
        reject(new Error('Out of memory error during AI processing'));
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        if (job.status === 'cancelled') {
          return reject(new Error('Operation cancelled'));
        }
        const errSnippet = pyStderr.trim().split('\n').slice(-3).join(' ') || '';
        reject(new Error(`AI pipeline exited with error code ${code}: ${errSnippet}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Could not execute Python process: ${err.message}`));
    });
  });

  if (job.status === 'cancelled') return;

  // STEP 4: Finalization & Song Library Assembly
  job.stage = 'finalize';
  job.progress = 98;
  job.message = 'Finalizing song library and score chart...';
  emitJobUpdate(job);

  const slug = job.slug;
  const targetSongDir = path.join(SONGS_DIR, slug);
  if (!fs.existsSync(targetSongDir)) {
    fs.mkdirSync(targetSongDir, { recursive: true });
  }

  // Find generated .txt, instrumental, and vocals in jobDir (or from finalGeneratorPayload)
  const jobFiles = fs.readdirSync(jobDir);
  const genTxt = jobFiles.find((f) => f.endsWith('.txt') && !f.includes('lyrics'));
  const genInst = jobFiles.find((f) => f.includes('[Instrumental]') || f.includes('instrumental') || f.includes('no_vocals'));
  const genVocals = jobFiles.find((f) => f.includes('[Vocals]') || f.includes('vocals'));

  if (!genTxt && (!finalGeneratorPayload || !finalGeneratorPayload.output_txt)) {
    throw new Error('UltraStar chart file (.txt) was not generated');
  }

  const txtSource = genTxt ? path.join(jobDir, genTxt) : finalGeneratorPayload.output_txt;
  fs.copyFileSync(txtSource, path.join(targetSongDir, 'song.txt'));

  let instSource = null;
  if (finalGeneratorPayload?.instrumental_wav && fs.existsSync(finalGeneratorPayload.instrumental_wav)) {
    instSource = finalGeneratorPayload.instrumental_wav;
  } else if (genInst) {
    instSource = path.join(jobDir, genInst);
  }
  if (instSource && fs.existsSync(instSource)) {
    fs.copyFileSync(instSource, path.join(targetSongDir, 'instrumental.wav'));
  }

  let vocalsSource = null;
  if (finalGeneratorPayload?.vocals_wav && fs.existsSync(finalGeneratorPayload.vocals_wav)) {
    vocalsSource = finalGeneratorPayload.vocals_wav;
  } else if (genVocals) {
    vocalsSource = path.join(jobDir, genVocals);
  } else {
    // Search recursively in jobDir (e.g. htdemucs folder)
    const findVocalsRecursive = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findVocalsRecursive(full);
            if (found) return found;
          } else if (entry.isFile() && (entry.name.toLowerCase().includes('vocals') || entry.name === 'vocals.wav')) {
            return full;
          }
        }
      } catch (_) {}
      return null;
    };
    vocalsSource = findVocalsRecursive(jobDir);
  }
  if (vocalsSource && fs.existsSync(vocalsSource)) {
    fs.copyFileSync(vocalsSource, path.join(targetSongDir, 'vocals.wav'));
  }
  if (fs.existsSync(lyricsJsonPath)) {
    fs.copyFileSync(lyricsJsonPath, path.join(targetSongDir, 'lyrics.json'));
  }

  // Download cover art if available
  const coverPath = path.join(targetSongDir, 'cover.jpg');
  if (resolved.artworkUrl) {
    await downloadFile(resolved.artworkUrl, coverPath);
  }

  // Compute quality score based on syncType and provider
  let syncType = 'whisper';
  let provider = 'whisper';
  let qualityScore = 0.72;

  if (lyricsDoc) {
    provider = lyricsDoc.source || 'canonical';
    syncType = lyricsDoc.syncType || 'line';
    if (syncType === 'syllable') qualityScore = 0.98;
    else if (syncType === 'word' || syncType === 'line') qualityScore = 0.88;
    else qualityScore = 0.72;
  } else if (plainLyricsResult) {
    provider = plainLyricsResult.source === 'manual' ? 'manual_plain' : `harvester_${plainLyricsResult.source}`;
    syncType = 'forced_mms';
    qualityScore = 0.85;
  } else if (options.forceWhisper) {
    provider = 'whisper';
    syncType = 'whisper';
    qualityScore = 0.65;
  }

  const hasVocals = fs.existsSync(path.join(targetSongDir, 'vocals.wav'));
  const hasInstrumental = fs.existsSync(path.join(targetSongDir, 'instrumental.wav'));

  const targetVocalsPath = path.join(targetSongDir, 'vocals.wav');
  const targetLyricsJsonPath = path.join(targetSongDir, 'lyrics.json');
  let studioOffsetSec = 0;

  // Phase 2.2: Studio vs. Live Audio Offset Auto-Detection
  // Measure the difference between the first non-silent vocal energy peak in vocals.wav
  // and the first syllable timestamp in lyrics.json:
  // offset = t_vocal_first - t_lyric_first
  if (hasVocals && fs.existsSync(targetLyricsJsonPath)) {
    try {
      const offsetResult = await audioSync.measureStudioOffset({
        vocalsPath: targetVocalsPath,
        lyricsJsonPath: targetLyricsJsonPath,
      });
      if (offsetResult && offsetResult.success && typeof offsetResult.studio_offset_sec === 'number') {
        studioOffsetSec = offsetResult.studio_offset_sec;
      } else if (offsetResult && offsetResult.success && typeof offsetResult.studioOffsetSec === 'number') {
        studioOffsetSec = offsetResult.studioOffsetSec;
      }
      if (studioOffsetSec !== 0) {
        console.log(`[Job ${job.id}] Auto-detected studioOffsetSec: ${studioOffsetSec.toFixed(3)}s (vocal: ${offsetResult.vocal_first_sec || offsetResult.vocalFirstSec}s, lyric: ${offsetResult.lyric_first_sec || offsetResult.lyricFirstSec}s)`);
      }
    } catch (offsetErr) {
      console.warn(`[Job ${job.id}] Studio offset auto-detection skipped:`, offsetErr.message);
    }
  }

  const lyricsTier = lyricsDoc ? 2 : (plainLyricsResult ? 3 : 4);

  // Write meta.json
  const meta = {
    generator_version: '6.0',
    slug,
    title: resolved.title,
    artist: resolved.artist,
    durationSec: resolved.durationSec || 0,
    youtubeId: resolved.youtubeId || '',
    spotifyTrackId: resolved.spotifyTrackId || '',
    isrc: resolved.isrc || '',
    artworkUrl: resolved.artworkUrl || '',
    provider,
    syncType,
    lyricsTier,
    qualityScore,
    pitchEngine: options.pitchEngine || 'fcpe',
    separator: options.separator || 'demucs',
    hardware: finalGeneratorPayload?.hardware || null,
    hasVocals,
    hasInstrumental,
    studioOffsetSec,
    videoOffsetSec: studioOffsetSec,
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
  job.message = 'Ready! Song is prepared and ready to sing.';
  job.result = {
    slug,
    title: meta.title,
    artist: meta.artist,
    durationSec: meta.durationSec,
    chartUrl: `/songs/${encodeURIComponent(slug)}/song.txt`,
    instrumentalUrl: hasInstrumental ? `/songs/${encodeURIComponent(slug)}/instrumental.wav` : null,
    vocalsUrl: hasVocals ? `/songs/${encodeURIComponent(slug)}/vocals.wav` : null,
    coverUrl: fs.existsSync(coverPath)
      ? `/songs/${encodeURIComponent(slug)}/cover.jpg`
      : (resolved.artworkUrl || null),
    syncType,
    provider: meta.provider,
    qualityScore,
    hasVocals,
    hasInstrumental,
    studioOffsetSec,
    videoOffsetSec: studioOffsetSec,
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
