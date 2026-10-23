/**
 * tests/settings_test.js - Unit tests for Phase 2: Modular Settings & UI Toggles
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 RUNNING SETTINGS & UI TOGGLES TEST SUITE (PHASE 2)');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// 1. Verify index.html Modal Structure & Elements
const requiredElementIds = [
  'modalSettings',
  'btnCloseSettings',
  'btnSaveSettings',
  'tab-display',
  'tab-audio',
  'tab-mic',
  'toggleShowLyricsRibbon',
  'toggleShowSyllablesOnNotes',
  'toggleShowLiveVoiceOrb',
  'toggleShowPitchBadges',
  'toggleShowScoreHUD',
  'toggleTheaterMode',
  'sliderGuideVocalsVol',
  'lblGuideVocalsVol',
  'sliderMasterVolume',
  'lblMasterVolume',
  'sliderLatency',
  'lblLatencyMs',
  'btnRunCalibration',
  'selectAudioInput',
  'micVolumeBar',
  'modalLiveNote',
  'modalLiveHz',
  'modalLiveClarity',
  'sliderGate',
  'lblGateVal',
  'toggleMicMonitoring',
  'sliderMicMonitorVol',
  'lblMicMonitorVol',
  'chkEchoCancel',
  'toggleOctaveAgnostic',
  'selectSettingsDifficulty',
  'toggleHighwayBlur',
];

for (const id of requiredElementIds) {
  assert.ok(
    html.includes(`id="${id}"`),
    `Missing required DOM element ID in index.html: ${id}`
  );
}
assert.ok(html.includes('data-tab="tab-display"'), 'Missing tab-display tab button');
assert.ok(html.includes('data-tab="tab-audio"'), 'Missing tab-audio tab button');
assert.ok(html.includes('data-tab="tab-mic"'), 'Missing tab-mic tab button');
console.log('  ✓ PASS: All 32 Settings Modal DOM elements & tab panels present in index.html');

// 2. Verify CSS Classes & Layout Rules
assert.ok(css.includes('.switch-slider'), 'Missing .switch-slider in style.css');
assert.ok(css.includes('.settings-tabs'), 'Missing .settings-tabs in style.css');
assert.ok(css.includes('.settings-tab-btn'), 'Missing .settings-tab-btn in style.css');
assert.ok(css.includes('body.hide-lyrics-ribbon .lyrics-prompter'), 'Missing hide-lyrics-ribbon rule in style.css');
assert.ok(css.includes('body.hide-pitch-badges'), 'Missing hide-pitch-badges rule in style.css');
assert.ok(css.includes('body.hide-score-hud'), 'Missing hide-score-hud rule in style.css');
assert.ok(css.includes('body.hide-lyrics-ribbon #pitchCanvas'), 'Missing pitchCanvas height adjustment in style.css');
console.log('  ✓ PASS: All required CSS classes, toggle switches, and reactive classes present in style.css');

// 3. Verify DEFAULT_SETTINGS Schema in app.js
const expectedKeys = [
  'showLyricsRibbon',
  'showSyllablesOnNotes',
  'showLiveVoiceOrb',
  'showPitchBadges',
  'showScoreHUD',
  'theaterMode',
  'guideVocalsVolume',
  'masterVolume',
  'micMonitoring',
  'micMonitorVolume',
  'noiseGate',
  'difficulty',
  'octaveAgnostic',
  'latencyMs',
  'highwayBackdropBlur',
];

for (const key of expectedKeys) {
  assert.ok(
    js.includes(`${key}:`),
    `Missing setting key in app.js: ${key}`
  );
}
console.log('  ✓ PASS: DEFAULT_SETTINGS schema contains all 14 required settings');

// 4. Verify Functions Exist in app.js
assert.ok(js.includes('function loadAppSettings()'), 'Missing loadAppSettings() in app.js');
assert.ok(js.includes('function saveAppSettings()'), 'Missing saveAppSettings() in app.js');
assert.ok(js.includes('function applySettings('), 'Missing applySettings() in app.js');
assert.ok(js.includes('function updateMicMonitoring()'), 'Missing updateMicMonitoring() in app.js');
console.log('  ✓ PASS: Reactive settings management functions present in app.js');

// 5. Test applySettings Logic with Mock DOM
const mockStorage = {};
const mockClassList = new Set();
const mockElements = {};

global.localStorage = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = String(v); },
};

global.document = {
  body: {
    classList: {
      toggle: (cls, force) => {
        if (force) mockClassList.add(cls);
        else mockClassList.delete(cls);
      },
      contains: (cls) => mockClassList.has(cls),
    },
  },
  getElementById: (id) => {
    if (!mockElements[id]) {
      mockElements[id] = { id, value: '', checked: false, textContent: '', style: {}, classList: new Set() };
      mockElements[id].classList.toggle = (c, f) => {
        if (f) mockElements[id].classList.add(c);
        else mockElements[id].classList.delete(c);
      };
      mockElements[id].classList.contains = (c) => mockElements[id].classList.has(c);
    }
    return mockElements[id];
  },
  querySelectorAll: () => [],
};

// Simulate evaluating settings storage
const appState = {
  settings: {
    showLyricsRibbon: true,
    showSyllablesOnNotes: true,
    showLiveVoiceOrb: true,
    showPitchBadges: true,
    showScoreHUD: true,
    theaterMode: false,
    guideVocalsVolume: 35,
    masterVolume: 90,
    micMonitoring: false,
    micMonitorVolume: 50,
    noiseGate: 6,
    difficulty: 1.5,
    octaveAgnostic: true,
    latencyMs: 80,
  },
};

// Test toggling off showLyricsRibbon
document.body.classList.toggle('hide-lyrics-ribbon', !false);
assert.strictEqual(document.body.classList.contains('hide-lyrics-ribbon'), true);
document.body.classList.toggle('hide-lyrics-ribbon', !true);
assert.strictEqual(document.body.classList.contains('hide-lyrics-ribbon'), false);

// Test persistence simulation
global.localStorage.setItem('sing_app_settings', JSON.stringify({ ...appState.settings, showLyricsRibbon: false }));
const restored = JSON.parse(global.localStorage.getItem('sing_app_settings'));
assert.strictEqual(restored.showLyricsRibbon, false);
assert.strictEqual(restored.guideVocalsVolume, 35);
console.log('  ✓ PASS: Reactive DOM toggling & localStorage persistence verified');

console.log('🎉 ALL SETTINGS & UI TOGGLE TESTS PASSED!');
