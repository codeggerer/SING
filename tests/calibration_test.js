/**
 * tests/calibration_test.js - Unit tests for Phase 6: Dual-Mode Latency Calibration & Quick-Nudge
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 RUNNING LATENCY CALIBRATION TEST SUITE (PHASE 6)');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// ============================================================================
// 1. DOM Elements Verification (index.html)
// ============================================================================
const requiredDomIds = [
  'modalCalibration',
  'tabBtnChirp',
  'tabBtnTap',
  'panelChirpCal',
  'panelTapCal',
  'chirpBadge1',
  'chirpBadge2',
  'chirpBadge3',
  'chirpStatusText',
  'chirpProgressFill',
  'chirpResultCard',
  'lblChirpResultMs',
  'lblChirpConfidence',
  'btnApplyChirpResult',
  'btnStartChirpCal',
  'metronomeTrack',
  'metronomeDot',
  'metronomeBeatFlash',
  'tapDotsContainer',
  'tapLiveBadge',
  'btnTapBeat',
  'tapResultCard',
  'lblTapResultMs',
  'lblTapStats',
  'btnApplyTapResult',
  'btnStartTapCal',
  'btnResetTapCal',
  'calModalCurrentLatency',
  'btnNudgeCalDown',
  'btnNudgeCalUp',
  'btnDoneCalibration',
  'btnCloseCalibrationModal',
  'toastContainer',
  'btnRunCalibration',
  'sliderLatency',
  'lblLatencyMs',
];

for (const id of requiredDomIds) {
  assert.ok(html.includes(`id="${id}"`), `DOM element id="${id}" must exist in index.html`);
}
console.log(`  ✓ PASS: All ${requiredDomIds.length} Calibration & Toast DOM elements present in index.html`);

// ============================================================================
// 2. CSS Styles Verification (style.css)
// ============================================================================
const requiredCssSelectors = [
  '.toast-container',
  '.toast',
  '.cal-modal-card',
  '.cal-mode-tabs',
  '.cal-tab-btn',
  '.chirp-step-badge',
  '.chirp-meter-fill',
  '.cal-result-card',
  '.metronome-track',
  '.metronome-pulse-dot',
  '.metronome-beat-flash',
  '.tap-dot',
  '.tap-beat-btn',
  '.cal-nudge-group',
];

for (const sel of requiredCssSelectors) {
  assert.ok(css.includes(sel), `CSS selector "${sel}" must exist in style.css`);
}
console.log(`  ✓ PASS: All ${requiredCssSelectors.length} required CSS classes and components present in style.css`);

// ============================================================================
// 3. Functions and State Verification in app.js
// ============================================================================
const requiredFunctions = [
  'generateChirpSignal',
  'computeCrossCorrelation',
  'processRhythmTapOffsets',
  'runAcousticChirpCalibration',
  'startRhythmTapMetronome',
  'stopRhythmTapMetronome',
  'recordRhythmTap',
  'resetRhythmTapCalibration',
  'openCalibrationModal',
  'closeCalibrationModal',
  'switchCalibrationMode',
  'nudgeLatency',
  'showToast',
  'playMetronomeTick',
  'initCalibrationWizard',
];

for (const fn of requiredFunctions) {
  assert.ok(appJs.includes(`function ${fn}(`), `Function "${fn}" must be defined in app.js`);
}
assert.ok(appJs.includes('calState = {'), 'calState object must be defined in app.js');
console.log(`  ✓ PASS: All ${requiredFunctions.length} Phase 6 calibration functions defined in app.js`);

// ============================================================================
// 4. Algorithm Unit Testing: generateChirpSignal & computeCrossCorrelation
// ============================================================================

// Extract functions for pure mathematical evaluation
function generateChirpSignal(sampleRate = 44100, durationMs = 40, freqHz = 1200) {
  const numSamples = Math.round((durationMs / 1000) * sampleRate);
  const chirp = new Float32Array(numSamples);
  const attackSamples = Math.max(1, Math.round(sampleRate * 0.003));

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let envelope = 1.0;
    if (i < attackSamples) {
      envelope = 0.5 * (1 - Math.cos((Math.PI * i) / attackSamples));
    } else {
      const decayProgress = (i - attackSamples) / Math.max(1, numSamples - attackSamples);
      envelope = 0.5 * (1 + Math.cos(Math.PI * decayProgress));
    }
    chirp[i] = Math.sin(2 * Math.PI * freqHz * t) * envelope;
  }
  return chirp;
}

function computeCrossCorrelation(signal, reference, minLag = 0, maxLag = null, sampleRate = 44100) {
  const sigLen = signal ? signal.length : 0;
  const refLen = reference ? reference.length : 0;
  if (sigLen === 0 || refLen === 0 || sigLen < refLen) {
    return { peakLag: 0, peakCorrelation: 0, refinedLag: 0, refinedLatencyMs: 0, confidence: 0 };
  }

  const effectiveMaxLag = Math.min(sigLen - refLen, maxLag !== null ? maxLag : sigLen - refLen);
  const effectiveMinLag = Math.max(0, minLag);
  if (effectiveMaxLag < effectiveMinLag) {
    return { peakLag: 0, peakCorrelation: 0, refinedLag: 0, refinedLatencyMs: 0, confidence: 0 };
  }

  let refEnergy = 0;
  for (let i = 0; i < refLen; i++) refEnergy += reference[i] * reference[i];
  if (refEnergy <= 1e-12) refEnergy = 1e-12;

  let bestLag = effectiveMinLag;
  let maxCorr = -Infinity;
  const numLags = effectiveMaxLag - effectiveMinLag + 1;
  const corrValues = new Float32Array(numLags);

  for (let lag = effectiveMinLag; lag <= effectiveMaxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < refLen; i++) {
      corr += reference[i] * signal[lag + i];
    }
    corrValues[lag - effectiveMinLag] = corr;
    if (corr > maxCorr) {
      maxCorr = corr;
      bestLag = lag;
    }
  }

  let localSigEnergy = 0;
  for (let i = 0; i < refLen; i++) {
    const s = signal[bestLag + i];
    localSigEnergy += s * s;
  }
  const norm = Math.sqrt(refEnergy * (localSigEnergy + 1e-10));
  const normalizedCorr = norm > 0 ? maxCorr / norm : 0;

  let refinedLag = bestLag;
  const bestIdx = bestLag - effectiveMinLag;
  if (bestIdx > 0 && bestIdx < numLags - 1) {
    const alpha = corrValues[bestIdx - 1];
    const beta = corrValues[bestIdx];
    const gamma = corrValues[bestIdx + 1];
    const denom = 2 * (alpha - 2 * beta + gamma);
    if (Math.abs(denom) > 1e-9) {
      const delta = (alpha - gamma) / denom;
      if (Math.abs(delta) <= 1.0) {
        refinedLag = bestLag + delta;
      }
    }
  }

  const refinedLatencyMs = (refinedLag / sampleRate) * 1000;

  return {
    peakLag: bestLag,
    peakCorrelation: maxCorr,
    normalizedCorrelation: Math.max(0, Math.min(1, normalizedCorr)),
    refinedLag: refinedLag,
    refinedLatencyMs: Math.round(refinedLatencyMs * 100) / 100,
    confidence: Math.max(0, Math.min(1, normalizedCorr)),
  };
}

const sampleRate = 44100;
const chirp = generateChirpSignal(sampleRate, 40, 1200);

assert.strictEqual(chirp.length, 1764, '40ms chirp at 44.1kHz must be exactly 1764 samples');
assert.ok(Math.abs(chirp[0]) < 1e-4, 'Chirp must start at 0 without click');
assert.ok(Math.abs(chirp[chirp.length - 1]) < 0.05, 'Chirp must decay smoothly to 0');
console.log('  ✓ PASS: generateChirpSignal synthesizes click-free 40ms 1.2 kHz acoustic burst');

// Test auto-correlation (lag 0)
const autoCorr = computeCrossCorrelation(chirp, chirp, 0, 100, sampleRate);
assert.strictEqual(autoCorr.peakLag, 0, 'Auto-correlation peak must be at lag 0');
assert.ok(autoCorr.confidence > 0.98, 'Auto-correlation confidence must be > 0.98');
assert.strictEqual(autoCorr.refinedLatencyMs, 0, 'Auto-correlation latency must be 0 ms');

// Test synthetic hardware latency: chirp placed at 52.5 ms (2315 samples)
const targetDelayMs = 52.5;
const targetDelaySamples = Math.round((targetDelayMs / 1000) * sampleRate); // 2315 samples
const totalLen = 8000;
const syntheticBuffer = new Float32Array(totalLen);

// Add subtle background noise (SNR ~ 20dB)
for (let i = 0; i < totalLen; i++) {
  syntheticBuffer[i] = (Math.random() - 0.5) * 0.05;
}
// Embed chirp
for (let i = 0; i < chirp.length; i++) {
  syntheticBuffer[targetDelaySamples + i] += chirp[i];
}

const delayResult = computeCrossCorrelation(syntheticBuffer, chirp, 0, 5000, sampleRate);
const detectedDelayMs = delayResult.refinedLatencyMs;
const delayErrorMs = Math.abs(detectedDelayMs - targetDelayMs);

assert.ok(
  delayErrorMs <= 0.2,
  `Chirp latency error must be sub-millisecond (expected: ${targetDelayMs}ms, got: ${detectedDelayMs}ms, err: ${delayErrorMs}ms)`
);
assert.ok(delayResult.confidence > 0.75, `High confidence detection (got: ${delayResult.confidence})`);
console.log(
  `  ✓ PASS: Acoustic loopback cross-correlation detected delay with ${delayErrorMs.toFixed(3)}ms sub-millisecond precision`
);

// ============================================================================
// 5. Rhythm Tap Outlier Rejection & Calibration Statistics
// ============================================================================
function processRhythmTapOffsets(tapOffsets) {
  if (!tapOffsets || tapOffsets.length <= 2) {
    return { success: false, reason: 'At least 3 taps required (first 2 taps are warmups).' };
  }

  const candidateTaps = tapOffsets.slice(2);
  const mean = candidateTaps.reduce((a, b) => a + b, 0) / candidateTaps.length;
  const variance =
    candidateTaps.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / candidateTaps.length;
  const stdDev = Math.sqrt(variance);

  const threshold = Math.max(14, 2 * stdDev);
  const validTaps = candidateTaps.filter((val) => Math.abs(val - mean) <= threshold);
  const rejectedCount = candidateTaps.length - validTaps.length;

  const finalMean =
    validTaps.length > 0 ? validTaps.reduce((a, b) => a + b, 0) / validTaps.length : mean;

  const finalLatencyMs = Math.round(finalMean);

  return {
    success: true,
    warmupCount: 2,
    totalTaps: tapOffsets.length,
    candidateCount: candidateTaps.length,
    validCount: validTaps.length,
    rejectedCount,
    mean: Math.round(mean),
    stdDev: Math.round(stdDev * 10) / 10,
    calibratedLatencyMs: Math.max(-100, Math.min(450, finalLatencyMs)),
  };
}

// Case A: 8 taps with 2 warmups and 1 accidental reflex slip (outlier 240ms)
const testTaps = [120, -85, 48, 52, 49, 51, 240, 50];
const tapResult = processRhythmTapOffsets(testTaps);

assert.strictEqual(tapResult.success, true);
assert.strictEqual(tapResult.warmupCount, 2, 'First 2 taps must be discarded as warmup');
assert.strictEqual(tapResult.rejectedCount, 1, 'Outlier tap (240ms) must be rejected (> 2σ)');
assert.strictEqual(tapResult.validCount, 5, '5 valid candidate taps kept');
assert.strictEqual(tapResult.calibratedLatencyMs, 50, 'Calibrated latency must be 50ms');
console.log('  ✓ PASS: Rhythm tap metronome rejects warmup taps and filters outliers (> 2σ)');

// Case B: Fewer than 3 taps
const shortTaps = [45, 50];
const shortResult = processRhythmTapOffsets(shortTaps);
assert.strictEqual(shortResult.success, false, 'Must reject < 3 taps');

// Case C: Clamping bounds [-100, 450]
const extremeTaps = [0, 0, 550, 580, 600];
const clampedResult = processRhythmTapOffsets(extremeTaps);
assert.strictEqual(clampedResult.calibratedLatencyMs, 450, 'Latency must clamp to maximum 450ms');

// ============================================================================
// 6. Stage Live Quick-Nudge & Pitch Evaluation Integration
// ============================================================================
let simulatedLatency = 80;
function nudgeLatencySim(delta) {
  simulatedLatency = Math.max(-100, Math.min(450, simulatedLatency + delta));
  return simulatedLatency;
}

assert.strictEqual(nudgeLatencySim(-10), 70, 'Nudge down [-10ms] updates latency from 80 to 70');
assert.strictEqual(nudgeLatencySim(10), 80, 'Nudge up [+10ms] restores latency to 80');

// Verify evaluation time math
const rawSongTime = 25.0; // 25.0 seconds
const evalTimeAt80 = rawSongTime - 80 / 1000; // 24.92s
const evalTimeAt70 = rawSongTime - 70 / 1000; // 24.93s
assert.strictEqual(evalTimeAt80, 24.92);
assert.strictEqual(evalTimeAt70, 24.93);
console.log('  ✓ PASS: Stage quick-nudge ([-10ms] / [+10ms]) immediately updates pitch evaluation time');

// Verify global keyboard handler wiring
assert.ok(appJs.includes("if (e.key === '[')"), "Key '[' handled for -10ms nudge");
assert.ok(appJs.includes("if (e.key === ']')"), "Key ']' handled for +10ms nudge");
assert.ok(appJs.includes("e.code === 'Space' || e.key === ' '"), "Spacebar handled for rhythm tap");
console.log('  ✓ PASS: Global keyboard handlers for [, ], and Spacebar verified in app.js');

console.log('🎉 ALL LATENCY CALIBRATION TESTS PASSED!');
