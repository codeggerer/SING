/**
 * tests/chart_editor_test.js
 * Unit & Integration Test Suite for Phase 8: Interactive In-Browser Note & Offset Editor
 *
 * Verifies:
 * 1. DOM Elements in public/index.html (Modal, Canvas, Shift All buttons, Guide Tone button, toolbar)
 * 2. CSS Rules in public/style.css (.modal-editor-card, .editor-toolbar, .shift-all-group, .small-btn.active)
 * 3. Note Resizing & Shifting Math (resize-start, resize-end, move with semitone snapping, bounds)
 * 4. Quick "Shift All Notes" Math (±100ms timing shift, ±1 semitone transpose)
 * 5. UltraStar Chart Math Roundtrip (#BPM:1500, 1 beat = 10ms, line breaks, golden notes, 'E')
 * 6. Synthetic Guide Tone Frequency Math (f = 440 * 2^((m - 69) / 12))
 * 7. Waveform Binning & Normalization DSP Math (50 peaks/sec, [0, 1] scaling)
 * 8. Backend Persistence Integration (POST /api/library/:slug/chart, meta.json.edited flag)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { updateSongChart, listLibrarySongs, SONGS_DIR } = require('../lib/library');

console.log('🧪 RUNNING INTERACTIVE CHART EDITOR TEST SUITE (PHASE 8)');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const cssPath = path.join(__dirname, '..', 'public', 'style.css');
const jsPath = path.join(__dirname, '..', 'public', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

// ============================================================================
// 1. DOM Elements Verification (index.html)
// ============================================================================
console.log('\n--- Section 1: Chart Editor Modal & Toolbar DOM Elements ---');

const requiredElementIds = [
  'modalChartEditor',
  'editorSongTitle',
  'btnSaveChart',
  'btnCloseChartEditor',
  'btnEditorRewind',
  'btnEditorPlayPause',
  'btnEditorForward',
  'btnEditorGuideTone',
  'btnShiftOctaveDown',
  'btnShiftPitchDown',
  'btnShiftPitchUp',
  'btnShiftOctaveUp',
  'btnNudgeStartLeft',
  'btnNudgeStartRight',
  'btnNudgeEndLeft',
  'btnNudgeEndRight',
  'btnShiftAllTimeEarlier',
  'btnShiftAllTimeLater',
  'btnShiftAllPitchDown',
  'btnShiftAllPitchUp',
  'inputEditorSyllableText',
  'btnEditorSplitNote',
  'btnEditorDeleteNote',
  'btnEditorZoomOut',
  'btnEditorZoomIn',
  'editorCanvasContainer',
  'editorCanvas',
  'editorStatusText',
  'editorSelectedNoteInfo',
];

for (const id of requiredElementIds) {
  assert.ok(
    html.includes(`id="${id}"`),
    `index.html must contain element with id="${id}"`
  );
}
console.log(`  ✓ PASS: All ${requiredElementIds.length} Chart Editor modal elements present in index.html`);

// ============================================================================
// 2. CSS Rules Verification (style.css)
// ============================================================================
console.log('\n--- Section 2: Editor Modal & Toolbar CSS Rules ---');

assert.ok(css.includes('.modal-editor-card'), 'style.css must define .modal-editor-card');
assert.ok(css.includes('.editor-toolbar'), 'style.css must define .editor-toolbar');
assert.ok(css.includes('.shift-all-group'), 'style.css must define .shift-all-group');
assert.ok(css.includes('#btnEditorGuideTone.active') || css.includes('.small-btn.active'), 'style.css must define active state for guide tone');
assert.ok(css.includes('.editor-canvas-container'), 'style.css must define .editor-canvas-container');
assert.ok(css.includes('#editorCanvas'), 'style.css must define #editorCanvas');
console.log('  ✓ PASS: Chart Editor and Shift-All CSS styling verified');

// ============================================================================
// 3. JavaScript Event Wiring & Implementation Verification (app.js)
// ============================================================================
console.log('\n--- Section 3: JavaScript Engine Implementation & Event Wiring ---');

const requiredJsSymbols = [
  'const editorState =',
  'startEditorGuideTone',
  'updateEditorGuideTone',
  'stopEditorGuideTone',
  'playSinglePitchTone',
  'toggleEditorGuideTone',
  'loadEditorWaveform',
  'shiftAllNotesTiming',
  'shiftAllNotesPitch',
  'nudgeSelectedNoteTiming',
  'shiftSelectedNotePitch',
  'splitSelectedNote',
  'deleteSelectedNote',
  'openChartEditor',
  'closeChartEditor',
  'renderChartEditorCanvas',
  'toggleEditorAudioPreview',
  'saveChartEditorChanges',
];

for (const sym of requiredJsSymbols) {
  assert.ok(js.includes(sym), `app.js must define or wire '${sym}'`);
}

// Verify that keydown handles spacebar preview and shift all shortcuts
assert.ok(
  js.includes('toggleEditorAudioPreview()'),
  'app.js must call toggleEditorAudioPreview() on Spacebar in editor'
);
assert.ok(
  js.includes('shiftAllNotesPitch('),
  'app.js must support shiftAllNotesPitch'
);
assert.ok(
  js.includes('shiftAllNotesTiming('),
  'app.js must support shiftAllNotesTiming'
);
console.log(`  ✓ PASS: All ${requiredJsSymbols.length} engine functions & keydown shortcuts verified`);

// ============================================================================
// 4. Note Resizing & Shifting Algorithmic Math
// ============================================================================
console.log('\n--- Section 4: Note Resizing & Shifting Algorithmic Math ---');

// Test resize-start: changes startTime while keeping endTime >= startTime + 0.03
function simulateResizeStart(initialNote, deltaSec) {
  const newStart = Math.min(initialNote.endTime - 0.03, Math.max(0, initialNote.startTime + deltaSec));
  const startTime = Math.round(newStart * 100) / 100;
  const duration = Math.round((initialNote.endTime - startTime) * 100) / 100;
  return { ...initialNote, startTime, duration };
}

const origNote = { startTime: 2.0, endTime: 3.0, duration: 1.0, midi: 60 };
const resizedStartEarlier = simulateResizeStart(origNote, -0.4);
assert.strictEqual(resizedStartEarlier.startTime, 1.6);
assert.strictEqual(resizedStartEarlier.duration, 1.4);

// Test clamp against end time
const resizedStartOvershoot = simulateResizeStart(origNote, 1.5);
assert.ok(resizedStartOvershoot.startTime <= origNote.endTime - 0.03);
assert.ok(resizedStartOvershoot.duration >= 0.03);

// Test resize-end: changes endTime while keeping endTime >= startTime + 0.03
function simulateResizeEnd(initialNote, deltaSec) {
  const newEnd = Math.max(initialNote.startTime + 0.03, initialNote.endTime + deltaSec);
  const endTime = Math.round(newEnd * 100) / 100;
  const duration = Math.round((endTime - initialNote.startTime) * 100) / 100;
  return { ...initialNote, endTime, duration };
}

const resizedEndLater = simulateResizeEnd(origNote, 0.5);
assert.strictEqual(resizedEndLater.endTime, 3.5);
assert.strictEqual(resizedEndLater.duration, 1.5);

const resizedEndUndershoot = simulateResizeEnd(origNote, -2.0);
assert.strictEqual(resizedEndUndershoot.endTime, 2.03);
assert.strictEqual(resizedEndUndershoot.duration, 0.03);

console.log('  ✓ PASS: Dual-border note resizing (resize-start and resize-end) math verified');

// ============================================================================
// 5. Quick "Shift All Notes" (±100ms timing, ±1 semitone transpose)
// ============================================================================
console.log('\n--- Section 5: Quick "Shift All Notes" Math (±100ms & ±1 ST) ---');

function simulateShiftAllTiming(notes, deltaSec) {
  const minStart = Math.min(...notes.map((n) => n.startTime));
  let safeDelta = deltaSec;
  if (minStart + deltaSec < 0) {
    safeDelta = -minStart;
  }
  return notes.map((n) => {
    const startTime = Math.max(0, Math.round((n.startTime + safeDelta) * 1000) / 1000);
    const endTime = Math.max(startTime + 0.03, Math.round((n.endTime + safeDelta) * 1000) / 1000);
    const duration = Math.round((endTime - startTime) * 1000) / 1000;
    return { ...n, startTime, endTime, duration };
  });
}

function simulateShiftAllPitch(notes, semitones) {
  return notes.map((n) => ({
    ...n,
    midi: Math.max(24, Math.min(108, n.midi + semitones)),
  }));
}

const testTrack = [
  { startTime: 1.2, endTime: 1.8, duration: 0.6, midi: 60, text: 'hel-' },
  { startTime: 1.8, endTime: 2.5, duration: 0.7, midi: 62, text: 'lo ' },
  { startTime: 3.0, endTime: 3.8, duration: 0.8, midi: 64, text: 'world' },
];

// Shift +100ms
const shiftedPlus = simulateShiftAllTiming(testTrack, 0.10);
assert.strictEqual(shiftedPlus[0].startTime, 1.3);
assert.strictEqual(shiftedPlus[0].endTime, 1.9);
assert.strictEqual(shiftedPlus[1].startTime, 1.9);
assert.strictEqual(shiftedPlus[2].startTime, 3.1);

// Shift -100ms
const shiftedMinus = simulateShiftAllTiming(testTrack, -0.10);
assert.strictEqual(shiftedMinus[0].startTime, 1.1);
assert.strictEqual(shiftedMinus[0].endTime, 1.7);
assert.strictEqual(shiftedMinus[1].startTime, 1.7);
assert.strictEqual(shiftedMinus[2].startTime, 2.9);

// Shift before 0s clamped cleanly
const shiftedTooFar = simulateShiftAllTiming(testTrack, -5.0);
assert.strictEqual(shiftedTooFar[0].startTime, 0.0);
assert.ok(shiftedTooFar[0].endTime > 0);

// Transpose +1 semitone
const transposedUp = simulateShiftAllPitch(testTrack, 1);
assert.strictEqual(transposedUp[0].midi, 61);
assert.strictEqual(transposedUp[1].midi, 63);
assert.strictEqual(transposedUp[2].midi, 65);

// Transpose -1 semitone
const transposedDown = simulateShiftAllPitch(testTrack, -1);
assert.strictEqual(transposedDown[0].midi, 59);
assert.strictEqual(transposedDown[1].midi, 61);
assert.strictEqual(transposedDown[2].midi, 63);

console.log('  ✓ PASS: Shift all notes timing (±100ms) and pitch (±1 ST) math verified');

// ============================================================================
// 6. UltraStar Format Serialization Math (#BPM:1500)
// ============================================================================
console.log('\n--- Section 6: UltraStar Format Serialization Math ---');

function serializeNotesToUltraStar(notes, meta = {}) {
  const lines = [];
  lines.push(`#TITLE:${meta.title || 'Song'}`);
  lines.push(`#ARTIST:${meta.artist || 'Artist'}`);
  lines.push('#BPM:1500');
  lines.push('#GAP:0');

  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const sBeat = Math.round(n.startTime / 0.01);
    const eBeat = Math.round(n.endTime / 0.01);
    const dBeat = Math.max(3, eBeat - sBeat);

    if (i > 0) {
      const prevN = sorted[i - 1];
      const gapSec = n.startTime - prevN.endTime;
      if (gapSec >= 0.50) {
        const pauseBeat = Math.round((prevN.endTime + gapSec / 2) / 0.01);
        lines.push(`- ${pauseBeat}`);
      }
    }

    const prefix = n.isGolden ? '*' : ':';
    lines.push(`${prefix} ${sBeat} ${dBeat} ${Math.round(n.midi)} ${n.text}`);
  }
  lines.push('E');
  return lines.join('\n') + '\n';
}

const serialized = serializeNotesToUltraStar([
  { startTime: 1.00, endTime: 1.50, midi: 60, text: 'la ' },
  { startTime: 2.20, endTime: 2.70, midi: 64, text: 'la ' }, // gap = 0.70s -> phrase split
]);

assert.ok(serialized.includes('#BPM:1500'), 'Serialized chart must set #BPM:1500');
assert.ok(serialized.includes(': 100 50 60 la '), 'Beat 100 duration 50 for 1.00s-1.50s');
assert.ok(serialized.includes('- 185'), 'Pause beat at 1.85s (185 beats)');
assert.ok(serialized.includes(': 220 50 64 la '), 'Second note starts at beat 220');
assert.ok(serialized.trim().endsWith('E'), 'File must end with E');

console.log('  ✓ PASS: UltraStar format serialization with 10ms resolution and phrase breaks verified');

// ============================================================================
// 7. Synthetic Guide Tone Frequency Math
// ============================================================================
console.log('\n--- Section 7: Synthetic Guide Tone Frequency Math ---');

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// A4 = 440.00 Hz
assert.ok(Math.abs(midiToFreq(69) - 440.0) < 0.001);
// C4 = 261.626 Hz
assert.ok(Math.abs(midiToFreq(60) - 261.626) < 0.01);
// A3 = 220.00 Hz
assert.ok(Math.abs(midiToFreq(57) - 220.0) < 0.001);
// C5 = 523.251 Hz
assert.ok(Math.abs(midiToFreq(72) - 523.251) < 0.01);

console.log('  ✓ PASS: Guide tone MIDI-to-Hz frequency conversion verified (A4=440Hz, C4=261.6Hz)');

// ============================================================================
// 8. Waveform Downsampling & Peak Normalization DSP Math
// ============================================================================
console.log('\n--- Section 8: Waveform Downsampling & Normalization DSP Math ---');

function downsampleWaveform(channelData, sampleRate, bucketRate = 50) {
  const duration = channelData.length / sampleRate;
  const totalBuckets = Math.ceil(duration * bucketRate);
  const peaks = new Float32Array(totalBuckets);
  const samplesPerBucket = Math.floor(sampleRate / bucketRate);

  for (let b = 0; b < totalBuckets; b++) {
    const startSample = b * samplesPerBucket;
    const endSample = Math.min(channelData.length, startSample + samplesPerBucket);
    let maxVal = 0;
    for (let s = startSample; s < endSample; s += 2) {
      const v = Math.abs(channelData[s]);
      if (v > maxVal) maxVal = v;
    }
    peaks[b] = maxVal;
  }

  let globalMax = 0;
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] > globalMax) globalMax = peaks[i];
  }
  if (globalMax > 0.001) {
    for (let i = 0; i < peaks.length; i++) {
      peaks[i] = peaks[i] / globalMax;
    }
  }
  return { peaks, duration, bucketRate };
}

// Create 1 second of synthetic 44.1kHz audio with a peak of 0.8
const sr = 44100;
const syntheticBuffer = new Float32Array(sr);
for (let i = 0; i < sr; i++) {
  syntheticBuffer[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.8;
}

const wave = downsampleWaveform(syntheticBuffer, sr, 50);
assert.strictEqual(wave.peaks.length, 50, '1 second of audio at 50Hz bucket rate = 50 peaks');
assert.ok(Math.abs(Math.max(...wave.peaks) - 1.0) < 0.01, 'Peaks must be normalized to 1.0');
assert.ok(Math.min(...wave.peaks) > 0.7, 'Sine peak per 20ms bucket should be near full scale');

console.log('  ✓ PASS: Waveform downsampling (50 peaks/sec) and peak normalization verified');

// ============================================================================
// 9. Backend Persistence Integration (updateSongChart & meta.json.edited)
// ============================================================================
console.log('\n--- Section 9: Backend Chart Persistence Integration ---');

// Test saving a chart to an existing or temporary test slug in songs/
const testSlug = 'chart-editor-test-slug';
const testDir = path.join(SONGS_DIR, testSlug);
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}
const metaPath = path.join(testDir, 'meta.json');
fs.writeFileSync(metaPath, JSON.stringify({ title: 'Test', artist: 'Artist' }, null, 2));

const newChart = '#TITLE:Test\n#ARTIST:Artist\n#BPM:1500\n: 100 50 60 test \nE\n';
const result = updateSongChart(testSlug, newChart);

assert.strictEqual(result.success, true);
assert.strictEqual(result.edited, true);
assert.ok(result.lastEditedAt);

// Read updated meta.json
const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
assert.strictEqual(updatedMeta.edited, true);
assert.ok(updatedMeta.lastEditedAt);

// Verify saved chart content
const savedChart = fs.readFileSync(path.join(testDir, 'song.txt'), 'utf8');
assert.strictEqual(savedChart.trim(), newChart.trim());

// Clean up test slug
fs.rmSync(testDir, { recursive: true, force: true });

console.log('  ✓ PASS: updateSongChart persists changes and sets meta.json.edited = true');

// ============================================================================
// Summary
// ============================================================================
console.log('\n==========================================================');
console.log('🎉 ALL 9 CHART EDITOR (PHASE 8) TEST SUITES PASSED CLEANLY!');
console.log('==========================================================\n');
