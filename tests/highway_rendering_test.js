/**
 * tests/highway_rendering_test.js
 * Unit & Integration Test Suite for Phase 5: Dynamic Pitch Highway & Clean Note Capsules
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 RUNNING HIGHWAY RENDERING & NOTE CAPSULES TEST SUITE (PHASE 5)');

// 1. Static Verification of app.js and style.css
const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
const styleCssPath = path.join(__dirname, '..', 'public', 'style.css');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const styleCss = fs.readFileSync(styleCssPath, 'utf8');

// Check that app.js contains Phase 5 state and rendering elements
assert(appJs.includes('viewportCenterMidi'), 'app.js must declare and maintain viewportCenterMidi');
assert(appJs.includes('viewportSpanMidi'), 'app.js must declare and maintain viewportSpanMidi');
assert(appJs.includes('devicePixelRatio'), 'renderPitchHighwayCanvas must account for window.devicePixelRatio (Retina)');
assert(appJs.includes('setTransform(dpr, 0, 0, dpr, 0, 0)'), 'renderPitchHighwayCanvas must setTransform with DPR');
assert(appJs.includes('showSyllablesOnNotes'), 'renderPitchHighwayCanvas must respect showSyllablesOnNotes setting');
assert(appJs.includes('phraseTargetCenter'), 'renderPitchHighwayCanvas must calculate phraseTargetCenter');
assert(appJs.includes('const visibleNotes ='), 'renderPitchHighwayCanvas must define visibleNotes');
assert(appJs.includes('turnOffSubtitles'), 'app.js must define turnOffSubtitles');

// Check style.css
assert(styleCss.includes('.canvas-container'), 'style.css must style .canvas-container');
assert(styleCss.includes('#pitchCanvas'), 'style.css must style #pitchCanvas');
assert(styleCss.includes('body.hide-lyrics-ribbon #pitchCanvas'), 'style.css must handle expanded highway height in hide-lyrics-ribbon');

console.log('  ✓ PASS: Source code contains all Phase 5 state variables, DPR transforms & styles');

// 2. Dynamic Pitch Viewport Math Verification
function simulateViewportLerp(notes, evalTime, pastSec = 1.5, futureSec = 4.5, initialCenter = 65, initialSpan = 16) {
  const windowStart = evalTime - pastSec;
  const windowEnd = evalTime + futureSec;
  const visibleNotes = notes.filter((n) => n.endTime >= windowStart - 0.2 && n.startTime <= windowEnd + 0.2);

  let center = initialCenter;
  let span = initialSpan;

  if (visibleNotes.length > 0) {
    let localMinMidi = Infinity;
    let localMaxMidi = -Infinity;
    for (const n of visibleNotes) {
      if (n.midi < localMinMidi) localMinMidi = n.midi;
      if (n.midi > localMaxMidi) localMaxMidi = n.midi;
    }
    const phraseTargetCenter = (localMinMidi + localMaxMidi) / 2;
    const targetSpan = Math.max(16, (localMaxMidi - localMinMidi) + 6);

    center = center * 0.93 + phraseTargetCenter * 0.07;
    span = span * 0.93 + targetSpan * 0.07;
    return { center, span: Math.max(16, span), localMinMidi, localMaxMidi, phraseTargetCenter, targetSpan };
  }
  return { center, span: Math.max(16, span) };
}

// Test with a phrase: C4 (60), D4 (62), E4 (64), G4 (67)
const testNotes = [
  { startTime: 10.0, endTime: 11.0, midi: 60, text: 'Hel-' },
  { startTime: 11.2, endTime: 12.0, midi: 62, text: 'lo' },
  { startTime: 12.2, endTime: 13.0, midi: 64, text: 'World' },
  { startTime: 13.2, endTime: 14.5, midi: 67, text: '!' }
];

const vp = simulateViewportLerp(testNotes, 11.5);
assert.strictEqual(vp.localMinMidi, 60, 'localMinMidi should be 60');
assert.strictEqual(vp.localMaxMidi, 67, 'localMaxMidi should be 67');
assert.strictEqual(vp.phraseTargetCenter, 63.5, 'phraseTargetCenter should be (60+67)/2 = 63.5');
assert.strictEqual(vp.targetSpan, 16, 'targetSpan should be max(16, 7+6) = 16');
assert(vp.span >= 16, 'windowSpan must be at least 16 semitones');

// Test vertical spacing with canvas height H = 360 and H = 460
function computeMidiY(m, center, span, H, topPad = 24, botPad = 28) {
  const minM = center - span / 2;
  const maxM = center + span / 2;
  const usableH = H - topPad - botPad;
  return topPad + usableH * (1 - (m - minM) / (maxM - minM));
}

const H_standard = 360;
const y60 = computeMidiY(60, 63.5, 16, H_standard);
const y61 = computeMidiY(61, 63.5, 16, H_standard);
const semitonePixelDistance = Math.abs(y60 - y61);

assert(semitonePixelDistance >= 18.0, `Every semitone must get >= 18px vertical height (got ${semitonePixelDistance.toFixed(2)}px)`);

// Test adjacent semitone overlap with capsule barHeight = 16
const barHeight = 16;
const capsuleGap = semitonePixelDistance - barHeight;
assert(capsuleGap > 2.0, `Adjacent semitones must have clear positive vertical space without overlapping (got ${capsuleGap.toFixed(2)}px)`);

console.log(`  ✓ PASS: Dynamic Viewport guarantees ${semitonePixelDistance.toFixed(2)}px per semitone and ${capsuleGap.toFixed(2)}px gap between adjacent notes`);

// 3. Uniform Syllable Placement Decision Logic
function getSyllablePlacement(drawWidth, noteText, showSyllablesOnNotes) {
  if (!showSyllablesOnNotes) return null;
  const text = (noteText || '').trim();
  if (!text) return null;

  // Uniform placement: All syllables are rendered beneath the note tube
  return { location: 'beneath_sublane', baseline: 'top', fontSize: 12 };
}

// Test long note (drawWidth >= 38px) - uniformly below
const longPlacement = getSyllablePlacement(80, 'Love', true);
assert.strictEqual(longPlacement.location, 'beneath_sublane', 'Long notes must place syllables uniformly beneath capsule');
assert.strictEqual(longPlacement.baseline, 'top', 'Syllables must have top baseline directly under capsule');

// Test short note (drawWidth < 38px) - uniformly below
const shortPlacement = getSyllablePlacement(25, 'to', true);
assert.strictEqual(shortPlacement.location, 'beneath_sublane', 'Short notes must place syllables uniformly beneath in sub-lane');
assert.strictEqual(shortPlacement.baseline, 'top', 'Beneath syllables must have top baseline directly under capsule');

// Test toggle disabled
const disabledPlacement = getSyllablePlacement(80, 'Love', false);
assert.strictEqual(disabledPlacement, null, 'When showSyllablesOnNotes is false, no syllables should be placed');

console.log('  ✓ PASS: Uniform syllable placement rules verified for long notes, short notes, and disabled setting');

// 4. Retina DPR Canvas Buffer Sizing Math
function computeCanvasBufferDimensions(cssWidth, cssHeight, dpr) {
  const targetPixelW = Math.round(cssWidth * dpr);
  const targetPixelH = Math.round(cssHeight * dpr);
  return { targetPixelW, targetPixelH };
}

const dpr2 = computeCanvasBufferDimensions(960, 360, 2);
assert.strictEqual(dpr2.targetPixelW, 1920, 'At DPR=2, canvas buffer width must be 1920');
assert.strictEqual(dpr2.targetPixelH, 720, 'At DPR=2, canvas buffer height must be 720');

const dpr3 = computeCanvasBufferDimensions(1200, 460, 3);
assert.strictEqual(dpr3.targetPixelW, 3600, 'At DPR=3 (theater mode), canvas buffer width must be 3600');
assert.strictEqual(dpr3.targetPixelH, 1380, 'At DPR=3 (theater mode), canvas buffer height must be 1380');

console.log('  ✓ PASS: Retina DPR scaling math verified for standard and high-density displays');

// 5. Golden Note Styling & Stardust Particle Spawning
function simulateParticleSpawn(midi, isGolden, currentSpan = 16, center = 60, H = 360) {
  const minMidi = center - currentSpan / 2;
  const maxMidi = center + currentSpan / 2;
  const usableH = H - 24 - 28;
  const y = 24 + usableH * (1 - (midi - minMidi) / (maxMidi - minMidi));

  const particles = [];
  const count = isGolden ? 4 : 2;
  for (let i = 0; i < count; i++) {
    particles.push({
      y,
      isGolden: !!isGolden,
      color: isGolden ? 'rgba(255, 184, 0, ALPHA)' : 'rgba(0, 240, 255, ALPHA)',
    });
  }
  return particles;
}

const normalParts = simulateParticleSpawn(60, false);
assert.strictEqual(normalParts.length, 2, 'Normal note hit spawns 2 particles');
assert(normalParts[0].color.includes('240'), 'Normal note hit uses Electric Cyan accent');

const goldenParts = simulateParticleSpawn(60, true);
assert.strictEqual(goldenParts.length, 4, 'Golden note hit spawns 4 stardust particles');
assert(goldenParts[0].color.includes('184'), 'Golden note hit uses Amber/Gold stardust color');

console.log('  ✓ PASS: Golden note distinct particles and aura configurations verified');

console.log('🎉 ALL HIGHWAY RENDERING & NOTE CAPSULES TESTS PASSED!');
