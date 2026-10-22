/**
 * lib/audio_sync.js - FFT Acoustic Cross-Correlation Alignment Gateway (MASTER_OVERHAUL_PLAN Phase 2)
 *
 * Provides Node.js bindings to `karaoke/sync.py` and `scripts/align_audio_gap.py` for
 * sub-20ms YouTube #GAP alignment.
 *
 * Invariants:
 * - Zero external npm dependencies (native child_process, fs, path).
 * - videoGapMs = chartGapMs + (tau* * 1000)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
const ALIGN_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'align_audio_gap.py');

/**
 * Returns environment variables ensuring virtualenv and system tools are accessible.
 */
function getExecutionEnv() {
  const env = { ...process.env };
  const binPaths = [
    path.join(PROJECT_ROOT, 'venv', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  env.PATH = `${binPaths.join(':')}:${env.PATH || ''}`;
  return env;
}

/**
 * Aligns YouTube audio to Reference studio audio (or an UltraStar score chart),
 * or aligns Demucs vocal onset directly to the first note of the chart.
 *
 * @param {Object} options
 * @param {string} [options.ytAudioPath] Path to YouTube audio file (WAV/MP3/M4A)
 * @param {string} [options.refAudioPath] Path to Reference studio audio file
 * @param {string} [options.vocalsPath] Path to Demucs vocals.wav stem for onset alignment
 * @param {string} [options.chartPath] Path to UltraStar .txt score chart file
 * @param {number} [options.chartGapMs] Explicit chart gap in milliseconds
 * @param {boolean} [options.updateChart=false] Update #GAP directly in the chart file
 * @param {string} [options.outChartPath] Path to write the updated chart to
 * @param {string} [options.method='hybrid'] Method: 'hybrid', 'chroma', 'gcc_phat', 'onset', 'vocal_onset'
 * @param {number} [options.maxDurationSec=120.0] Max seconds of audio to compare
 * @param {number} [options.minConfidence=0.40] Minimum acceptable confidence threshold
 * @returns {Promise<Object>} Alignment result { success, lagSec, lagMs, confidence, originalGapMs, alignedGapMs, method, details }
 */
async function alignAudioGap(options = {}) {
  const {
    ytAudioPath,
    refAudioPath,
    vocalsPath,
    chartPath,
    chartGapMs,
    updateChart = false,
    outChartPath,
    method = 'hybrid',
    maxDurationSec = 120.0,
    minConfidence = 0.40,
  } = options;

  const isVocalOnset = method === 'vocal_onset' || (vocalsPath && !refAudioPath);

  if (!isVocalOnset) {
    if (!ytAudioPath || !fs.existsSync(ytAudioPath)) {
      throw new Error(`YouTube audio file not found: "${ytAudioPath}"`);
    }

    if (!refAudioPath && !chartPath) {
      throw new Error('Must provide either refAudioPath or chartPath for alignment');
    }

    if (refAudioPath && !fs.existsSync(refAudioPath)) {
      throw new Error(`Reference audio file not found: "${refAudioPath}"`);
    }
  } else {
    const targetVocals = vocalsPath || ytAudioPath;
    if (!targetVocals || !fs.existsSync(targetVocals)) {
      throw new Error(`Vocals audio file not found: "${targetVocals}"`);
    }
    if (!chartPath) {
      throw new Error('Must provide chartPath for vocal onset alignment');
    }
  }

  if (chartPath && !fs.existsSync(chartPath)) {
    throw new Error(`UltraStar chart file not found: "${chartPath}"`);
  }

  const pythonExec = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

  const pyArgs = [
    ALIGN_SCRIPT,
    '--method', isVocalOnset ? 'vocal_onset' : method,
    '--max-duration', String(maxDurationSec),
    '--min-confidence', String(minConfidence),
    '--output-json',
  ];

  if (ytAudioPath) {
    pyArgs.push('--yt-audio', ytAudioPath);
  }

  if (vocalsPath) {
    pyArgs.push('--vocals-audio', vocalsPath);
  }

  if (refAudioPath) {
    pyArgs.push('--ref-audio', refAudioPath);
  }

  if (chartPath) {
    pyArgs.push('--chart', chartPath);
  }

  if (typeof chartGapMs === 'number') {
    pyArgs.push('--chart-gap', String(chartGapMs));
  }

  if (updateChart) {
    pyArgs.push('--update-chart');
  }

  if (outChartPath) {
    pyArgs.push('--out-chart', outChartPath);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExec, pyArgs, { env: getExecutionEnv() });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // Exit code 0: success
      // Exit code 2: success with low confidence
      try {
        const firstBrace = stdout.indexOf('{');
        const lastBrace = stdout.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const jsonStr = stdout.slice(firstBrace, lastBrace + 1);
          const data = JSON.parse(jsonStr);

          if (code === 0 || code === 2) {
            return resolve({
              success: true,
              lowConfidence: code === 2,
              ...data,
            });
          } else {
            return reject(new Error(data.message || `Alignment exited with code ${code}: ${stderr.trim()}`));
          }
        }

        if (code === 0) {
          return resolve({ success: true, raw: stdout });
        }
        reject(new Error(`align_audio_gap error (code ${code}): ${stderr.trim() || stdout.trim()}`));
      } catch (e) {
        if (code === 0) {
          return resolve({ success: true, raw: stdout });
        }
        reject(new Error(`align_audio_gap error (code ${code}): ${stderr.trim() || stdout.trim()}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python align process: ${err.message}`));
    });
  });
}

/**
 * Helper to snap Demucs vocal onset directly to the first note of the UltraStar chart.
 *
 * @param {Object} options
 * @param {string} options.vocalsPath Path to Demucs vocals.wav
 * @param {string} options.chartPath Path to UltraStar song.txt
 * @param {number} [options.chartGapMs] Explicit chart gap in milliseconds
 * @param {boolean} [options.updateChart=true] Update #GAP directly in the chart file
 * @param {string} [options.outChartPath] Path to write the updated chart to
 * @param {number} [options.maxDurationSec=120.0] Max seconds of audio to analyze
 * @returns {Promise<Object>}
 */
async function alignVocalOnsetGap(options = {}) {
  const {
    vocalsPath,
    chartPath,
    chartGapMs,
    updateChart = true,
    outChartPath,
    maxDurationSec = 120.0,
  } = options;

  return alignAudioGap({
    vocalsPath,
    chartPath,
    chartGapMs,
    updateChart,
    outChartPath,
    method: 'vocal_onset',
    maxDurationSec,
  });
}

/**
 * Auto-detects studio vs. live audio offset between vocals.wav and lyrics.json (Phase 2.2):
 * offset = t_vocal_first - t_lyric_first
 *
 * @param {Object} options
 * @param {string} options.vocalsPath Path to vocals.wav
 * @param {string} options.lyricsJsonPath Path to lyrics.json
 * @param {number} [options.maxDurationSec=120.0]
 * @returns {Promise<{ success: boolean, studioOffsetSec: number, vocalFirstSec: number, lyricFirstSec: number, offsetMs: number }>}
 */
async function measureStudioOffset(options = {}) {
  const {
    vocalsPath,
    lyricsJsonPath,
    maxDurationSec = 120.0,
  } = options;

  if (!vocalsPath || !fs.existsSync(vocalsPath)) {
    throw new Error(`Vocals audio file not found: "${vocalsPath}"`);
  }
  if (!lyricsJsonPath || !fs.existsSync(lyricsJsonPath)) {
    throw new Error(`Lyrics file not found: "${lyricsJsonPath}"`);
  }

  const pythonExec = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

  const pyArgs = [
    ALIGN_SCRIPT,
    '--vocals-audio', vocalsPath,
    '--lyrics-json', lyricsJsonPath,
    '--measure-studio-offset',
    '--max-duration', String(maxDurationSec),
    '--output-json',
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExec, pyArgs, { env: getExecutionEnv() });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      try {
        const firstBrace = stdout.indexOf('{');
        const lastBrace = stdout.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const jsonStr = stdout.slice(firstBrace, lastBrace + 1);
          const data = JSON.parse(jsonStr);
          if (data.success) {
            return resolve(data);
          }
          if (code === 0) {
            return resolve(data);
          }
          return reject(new Error(data.message || `measureStudioOffset failed (code ${code}): ${stderr.trim()}`));
        }

        if (code === 0) {
          return resolve({ success: false, raw: stdout });
        }
        reject(new Error(`measureStudioOffset error (code ${code}): ${stderr.trim() || stdout.trim()}`));
      } catch (e) {
        reject(new Error(`measureStudioOffset parse error: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python process for measureStudioOffset: ${err.message}`));
    });
  });
}

module.exports = {
  alignAudioGap,
  alignVocalOnsetGap,
  measureStudioOffset,
};
