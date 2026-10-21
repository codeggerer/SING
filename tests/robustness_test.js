/**
 * SING! Karaoke Studio - Phase 7 Test Suite
 * Toast Notification System, Keybindings & Robustness Verification
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('🧪 RUNNING TOAST SYSTEM, KEYBINDINGS & ROBUSTNESS TEST SUITE (PHASE 7)');

const appJsPath = path.join(__dirname, '../public/app.js');
const styleCssPath = path.join(__dirname, '../public/style.css');
const indexHtmlPath = path.join(__dirname, '../public/index.html');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const styleCss = fs.readFileSync(styleCssPath, 'utf8');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// 1. Zero alert() calls in public/app.js
function testZeroBrowserAlerts() {
  const alertMatches = appJs.match(/\balert\s*\(/g);
  assert.strictEqual(
    alertMatches,
    null,
    `Found blocking alert() calls in app.js: ${alertMatches ? alertMatches.length : 0}`
  );
  console.log('  ✓ PASS: Zero alert() calls present in public/app.js');
}

// 2. Toast Notification System Structure & Styles
function testToastSystem() {
  // Check HTML toast container
  assert(indexHtml.includes('id="toastContainer"'), 'index.html must have #toastContainer');

  // Check CSS styles for all toast states
  const requiredCss = [
    '.toast-container',
    '.toast',
    '.toast.toast-hiding',
    '.toast.toast-info',
    '.toast.toast-success',
    '.toast.toast-warning',
    '.toast.toast-error',
    '@keyframes toastSlideIn',
  ];
  for (const selector of requiredCss) {
    assert(styleCss.includes(selector), `style.css missing toast rule: ${selector}`);
  }

  // Check showToast function in app.js
  assert(appJs.includes('function showToast('), 'app.js must declare showToast()');
  assert(appJs.includes("toast.className = `toast toast-${type}`"), 'showToast must apply toast type class');
  assert(appJs.includes('toast-icon'), 'showToast must attach toast-icon');
  assert(appJs.includes('toast-message'), 'showToast must attach toast-message');

  console.log('  ✓ PASS: Toast container, CSS classes (info, success, warning, error), and showToast verified');
}

// 3. Stage Keybindings
function testKeybindings() {
  // Check keyboard listener handles all required keys
  assert(appJs.includes("e.code === 'Space' || e.key === ' '"), 'Keydown listener must handle Spacebar');
  assert(appJs.includes("e.key === 'r' || e.key === 'R'"), 'Keydown listener must handle R for restart');
  assert(appJs.includes("e.key === 's' || e.key === 'S'"), 'Keydown listener must handle S for skip intro');
  assert(appJs.includes("e.key === 'm' || e.key === 'M'"), 'Keydown listener must handle M for microphone toggle');
  assert(appJs.includes("e.key === '['"), 'Keydown listener must handle [ for nudge down');
  assert(appJs.includes("e.key === ']'"), 'Keydown listener must handle ] for nudge up');
  assert(appJs.includes("e.key === 'Escape' || e.key === 'Esc'"), 'Keydown listener must handle Esc');

  // Check that input typing & system browser shortcuts are not trapped
  assert(appJs.includes("['INPUT', 'TEXTAREA', 'SELECT'].includes(targetTag)"), 'Keydown must ignore input fields');
  assert(appJs.includes('e.ctrlKey || e.metaKey || e.altKey'), 'Keydown must ignore meta/ctrl/alt shortcuts');

  // Check actions called by keybindings
  assert(appJs.includes('togglePlayPause()'), 'Spacebar must call togglePlayPause');
  assert(appJs.includes('restartSong()'), 'R key must call restartSong');
  assert(appJs.includes('skipToFirstVocals()'), 'S key must call skipToFirstVocals');
  assert(appJs.includes('toggleMicrophone()'), 'M key must call toggleMicrophone');
  assert(appJs.includes('nudgeLatency(-10)'), '[ key must nudge -10ms');
  assert(appJs.includes('nudgeLatency(10)'), '] key must nudge +10ms');
  assert(appJs.includes('leaveStageToLobby()'), 'Esc key must return to lobby when stage active');

  console.log('  ✓ PASS: Standard karaoke keybindings (Space, R, S, M, [, ], Esc) verified');
}

// 4. YouTube Embed Error Graceful Fallback & Audio-Only Stage Mode
function testYouTubeEmbedErrorHandling() {
  assert(appJs.includes('handleYouTubeEmbedFallback(errEv.data)'), 'YouTube onError must dispatch to handleYouTubeEmbedFallback');
  assert(appJs.includes('function handleYouTubeEmbedFallback('), 'app.js must declare handleYouTubeEmbedFallback');

  // Verify lyric/alternate video fallback
  assert(
    appJs.includes('state.ytCurrentIndex + 1 < state.ytVideoList.length'),
    'Fallback must check for next video in state.ytVideoList'
  );
  assert(
    appJs.includes('Video restricted by label – Switching to lyric video') ||
    appJs.includes('Video restricted by label – Trying alternate version'),
    'Fallback must notify user when switching to alternate video'
  );

  // Verify audio-only studio audio fallback
  assert(appJs.includes('function enableAudioOnlyStageMode('), 'app.js must declare enableAudioOnlyStageMode');
  assert(
    appJs.includes('Video restricted by label – Playing studio audio.'),
    'Audio fallback must show toast: "Video restricted by label – Playing studio audio."'
  );

  // Verify audio-only styling in style.css
  const audioOnlyStyles = [
    '.audio-only-backdrop',
    '.audio-only-card',
    '.audio-only-art',
    '.audio-only-badge',
    '.audio-only-title',
    '.audio-only-artist',
  ];
  for (const s of audioOnlyStyles) {
    assert(styleCss.includes(s), `style.css missing audio-only rule: ${s}`);
  }

  console.log('  ✓ PASS: YouTube embed error (150/101) fallback to lyric video & studio audio mode verified');
}

// Run all test suites
try {
  testZeroBrowserAlerts();
  testToastSystem();
  testKeybindings();
  testYouTubeEmbedErrorHandling();
  console.log('🎉 ALL TOAST, KEYBINDING & ROBUSTNESS TESTS PASSED!\n');
} catch (err) {
  console.error('❌ PHASE 7 TEST FAILED:', err.message);
  process.exit(1);
}
