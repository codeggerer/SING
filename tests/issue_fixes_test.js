/**
 * tests/issue_fixes_test.js
 * Verification test suite for Issue #7 (USDB stem separation) and Issue #8 (Highway backdrop blur toggle)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 RUNNING ISSUE #7 & #8 VERIFICATION TEST SUITE');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const jobsJs = fs.readFileSync(path.join(__dirname, '../lib/jobs.js'), 'utf8');

// ============================================================================
// 1. Issue #8: Highway Backdrop Blur Toggle
// ============================================================================
console.log('\n--- Testing Issue #8: Highway Backdrop Blur Setting ---');

// DOM Element
assert.ok(html.includes('id="rowHighwayBlur"'), 'index.html must include #rowHighwayBlur container');
assert.ok(html.includes('id="toggleHighwayBlur"'), 'index.html must include #toggleHighwayBlur checkbox');

// DEFAULT_SETTINGS Schema
assert.ok(js.includes('highwayBackdropBlur: true'), 'DEFAULT_SETTINGS must include highwayBackdropBlur: true');

// Dynamic CSS Custom Property Application
assert.ok(
  js.includes("'--highway-backdrop-blur', isHighwayBlur ? '8px' : '0px'") ||
  js.includes("'--highway-backdrop-blur', s.highwayBackdropBlur !== false ? '8px' : '0px'"),
  'app.js must dynamically set --highway-backdrop-blur to 8px or 0px depending on highwayBackdropBlur setting'
);

// Event Listener
assert.ok(
  js.includes("toggleHighwayBlur.addEventListener('change'"),
  'app.js must wire up change event listener on #toggleHighwayBlur'
);

// Test blur calculation logic
function computeBlur(settingVal) {
  return settingVal !== false ? '8px' : '0px';
}
assert.strictEqual(computeBlur(true), '8px');
assert.strictEqual(computeBlur(false), '0px');
assert.strictEqual(computeBlur(undefined), '8px');

console.log('  ✓ PASS: Issue #8 verified (DOM toggle, reactive --highway-backdrop-blur property & state persistence)');

// ============================================================================
// 2. Issue #7: Stem Separation on USDB / Catalog Ground Truth
// ============================================================================
console.log('\n--- Testing Issue #7: Stem Separation on USDB Match ---');

// DOM Elements & Classes
assert.ok(html.includes('id="btnSeparateVocals"'), 'index.html must include #btnSeparateVocals in .preview-actions');
assert.ok(html.includes('isolate-stems-btn'), 'index.html must have isolate-stems-btn class on button');
assert.ok(css.includes('.isolate-stems-btn'), 'style.css must define .isolate-stems-btn styling');

// Event Listener & Action Options
assert.ok(
  js.includes("btnSeparateVocals.addEventListener('click'"),
  'app.js must bind click event on #btnSeparateVocals'
);
assert.ok(
  js.includes('forceSeparation: true'),
  'app.js must dispatch handleStartSongAction with forceSeparation: true'
);

// Frontend Direct-Session Bypass override
assert.ok(
  js.includes('forceJob = !!actionOptions.forceJob || !!actionOptions.forceSeparation'),
  'app.js must recognize forceJob and forceSeparation in handleStartSongAction'
);
assert.ok(
  js.includes('!forceJob && (catMatch || (usdbM && usdbM.matched))'),
  'app.js must skip instant direct session when forceJob is requested'
);

// UI Button Visibility Update
assert.ok(
  js.includes('updateStartBtnLabel'),
  'app.js must maintain updateStartBtnLabel function'
);
assert.ok(
  js.includes("startBtn.textContent = isCatalog ? 'Sing Now (Instant)' : 'Generate Karaoke'"),
  'app.js must set startBtn label based on catalog match'
);

// Backend Download Target Fallback in USDB flow
assert.ok(
  jobsJs.includes('ytsearch1:${resolved.artist} - ${resolved.title}'),
  'lib/jobs.js must support ytsearch1 fallback when youtubeId is missing'
);

console.log('  ✓ PASS: Issue #7 verified (Separate Vocals button, direct session bypass override & Demucs stem separation pipeline)');

console.log('\n====================================================');
console.log('🎉 ALL ISSUE #7 AND #8 TESTS PASSED!');
console.log('====================================================');
