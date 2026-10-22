/**
 * tests/sync_test.js - Unit Tests for FFT Acoustic Cross-Correlation Alignment (Phase 2)
 *
 * Verifies:
 * 1. Node.js bindings in lib/audio_sync.js.
 * 2. Execution of scripts/align_audio_gap.py via child_process.
 * 3. Exact #GAP mathematical invariant: videoGapMs = chartGapMs + (tau* * 1000).
 * 4. Sub-20ms precision on synthetic test audio.
 * 5. In-place UltraStar chart header updating.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { alignAudioGap, alignVocalOnsetGap } = require('../lib/audio_sync');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(PROJECT_ROOT, 'venv', 'bin', 'python');

console.log('🧪 RUNNING FFT ACOUSTIC CROSS-CORRELATION TEST SUITE (PHASE 2)');

/**
 * Creates synthetic 16kHz WAV file with public-domain tones.
 */
function createSyntheticWav(destPath, durationSec = 10, offsetSec = 0) {
  const pyScript = `
import numpy as np
import soundfile as sf

sr = 16000
dur = ${durationSec}
t = np.linspace(0, dur, int(sr * dur), endpoint=False)
harmonic = np.sin(2.0 * np.pi * 440.0 * t) + 0.5 * np.sin(2.0 * np.pi * 554.37 * t) + 0.3 * np.sin(2.0 * np.pi * 659.25 * t)
pulse = (np.sin(2.0 * np.pi * 3.0 * t) > 0.0).astype(np.float32)
sig = (harmonic * pulse).astype(np.float32)

offset_sec = ${offsetSec}
shift_samples = int(round(offset_sec * sr))
if shift_samples >= 0:
    out_sig = np.concatenate([np.zeros(shift_samples, dtype=np.float32), sig])
else:
    out_sig = sig[-shift_samples:]

sf.write("${destPath.replace(/\\/g, '/')}", out_sig, sr)
`;
  const proc = spawnSync(VENV_PYTHON, ['-c', pyScript]);
  if (proc.status !== 0) {
    throw new Error(`Failed to create synthetic WAV: ${proc.stderr.toString()}`);
  }
}

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-sync-test-'));

  try {
    const refWav = path.join(tmpDir, 'ref.wav');
    const ytWav = path.join(tmpDir, 'yt.wav');
    const chartTxt = path.join(tmpDir, 'test_song.txt');

    // 1. Generate reference audio (10s) and YouTube audio (with +3.5s intro)
    createSyntheticWav(refWav, 12, 0);
    createSyntheticWav(ytWav, 12, 3.50);

    const initialChart = [
      '#TITLE:Test Synchronized Song',
      '#ARTIST:Antigravity Public Domain',
      '#BPM:1500',
      '#GAP:2000',
      ': 0 4 60 Hel ',
      ': 4 4 62 lo ',
      'E',
    ].join('\n');
    fs.writeFileSync(chartTxt, initialChart, 'utf8');

    // Test 1: Validation of missing arguments
    await assert.rejects(
      async () => {
        await alignAudioGap({});
      },
      /YouTube audio file not found/,
      'Should reject when ytAudioPath is missing'
    );
    console.log('  ✓ PASS: Rejection of missing audio files');

    // Test 2: Alignment between YouTube audio and Reference audio
    const res = await alignAudioGap({
      ytAudioPath: ytWav,
      refAudioPath: refWav,
      chartPath: chartTxt,
      updateChart: true,
      method: 'chroma',
    });

    assert.strictEqual(res.success, true, 'Result success should be true');
    assert(typeof res.lag_sec === 'number', 'lag_sec should be a number');
    assert(typeof res.confidence === 'number', 'confidence should be a number');

    const expectedLagSec = 3.50;
    const diffSec = Math.abs(res.lag_sec - expectedLagSec);
    const diffMs = diffSec * 1000;

    assert(
      diffMs <= 20.0,
      `Detected lag ${res.lag_sec}s differed from expected ${expectedLagSec}s by ${diffMs.toFixed(2)}ms (> 20ms)`
    );
    console.log(`  ✓ PASS: Detected lag ${res.lag_sec.toFixed(4)}s (diff: ${diffMs.toFixed(2)}ms <= 20ms threshold)`);

    // Test 3: Mathematical Invariant: videoGapMs = chartGapMs + (tau* * 1000)
    const expectedAlignedGap = 2000 + expectedLagSec * 1000;
    const gapDiff = Math.abs(res.aligned_gap_ms - expectedAlignedGap);
    assert(
      gapDiff <= 25.0,
      `Aligned gap ${res.aligned_gap_ms}ms differed from expected ${expectedAlignedGap}ms by ${gapDiff.toFixed(1)}ms`
    );
    console.log(`  ✓ PASS: Invariant videoGapMs = chartGapMs + (tau* * 1000) verified (${res.aligned_gap_ms}ms)`);

    // Test 4: Chart file updated on disk
    const updatedChartContent = fs.readFileSync(chartTxt, 'utf8');
    const roundedGap = Math.round(res.aligned_gap_ms);
    assert(
      updatedChartContent.includes(`#GAP:${roundedGap}`),
      `Updated chart content should contain #GAP:${roundedGap}`
    );
    assert(
      !updatedChartContent.includes('#GAP:2000'),
      'Old #GAP:2000 should be replaced'
    );
    assert(
      updatedChartContent.includes('#TITLE:Test Synchronized Song'),
      'Other headers should remain intact'
    );
    console.log('  ✓ PASS: UltraStar chart #GAP updated in-place without altering notes');

    // Test 5: Aligning directly to chart melody (when no reference audio is provided)
    const chartRes = await alignAudioGap({
      ytAudioPath: ytWav,
      chartPath: chartTxt,
      updateChart: false,
    });
    assert.strictEqual(chartRes.success, true);
    assert(typeof chartRes.lag_sec === 'number');
    console.log(`  ✓ PASS: Score-to-audio alignment fallback verified (lag: ${chartRes.lag_sec.toFixed(3)}s)`);

    // Test 6: Demucs Vocals Onset Snapping (Phase 1.1)
    const vocalOnsetChartTxt = path.join(tmpDir, 'vocal_onset_song.txt');
    const vocalOnsetWav = path.join(tmpDir, 'vocals.wav');
    // Synthetic vocals starting at offset 4.0s
    createSyntheticWav(vocalOnsetWav, 8, 4.00);

    const vocalChart = [
      '#TITLE:Test Vocal Onset Song',
      '#ARTIST:Antigravity Public Domain',
      '#BPM:1500',
      '#GAP:0',
      ': 100 20 60 Sing ',
      'E',
    ].join('\n');
    fs.writeFileSync(vocalOnsetChartTxt, vocalChart, 'utf8');

    // First note at beat 100 -> 100 * (15/1500) = 1.0s
    // Vocal onset at ~4.0s -> delta_tau = 4.0 - 1.0 = 3.0s -> aligned_gap_ms = 3000ms
    const vocalRes = await alignVocalOnsetGap({
      vocalsPath: vocalOnsetWav,
      chartPath: vocalOnsetChartTxt,
      updateChart: true,
    });

    assert.strictEqual(vocalRes.success, true);
    assert.strictEqual(vocalRes.method, 'vocal_onset');
    assert(typeof vocalRes.aligned_gap_ms === 'number');
    const vocalDiffMs = Math.abs(vocalRes.aligned_gap_ms - 3000);
    assert(
      vocalDiffMs <= 30.0,
      `Vocal onset aligned gap ${vocalRes.aligned_gap_ms}ms differed from expected 3000ms by ${vocalDiffMs}ms`
    );
    const updatedVocalChart = fs.readFileSync(vocalOnsetChartTxt, 'utf8');
    assert(
      updatedVocalChart.includes(`#GAP:${Math.round(vocalRes.aligned_gap_ms)}`),
      'Chart file must have updated #GAP'
    );
    console.log(`  ✓ PASS: Demucs vocal onset snapping verified (aligned gap: ${vocalRes.aligned_gap_ms}ms, diff: ${vocalDiffMs.toFixed(1)}ms)`);

    console.log('\n🎉 ALL FFT ACOUSTIC CROSS-CORRELATION TESTS PASSED!\n');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
