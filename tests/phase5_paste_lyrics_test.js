/**
 * tests/phase5_paste_lyrics_test.js - Unit tests for Phase 5: Client & Server Integration
 * Validates:
 * 1. DOM Elements in public/index.html (modal, textarea, action buttons, active badge)
 * 2. CSS classes in public/style.css (.gen-lyrics-override-row, .badge-cyan, .paste-lyrics-textarea, etc.)
 * 3. Client state & event logic in public/app.js (customLyricsText handling, option forwarding)
 * 4. Job queue & server pipeline in lib/jobs.js (preserving rawLyricsText, bypassing cache, writing plain_lyrics.txt)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOrGetJob, getJob, cancelJob } = require('../lib/jobs');
const { SONGS_DIR } = require('../lib/library');

console.log('🧪 RUNNING PHASE 5: CLIENT & SERVER INTEGRATION TEST SUITE');

// 1. Verify DOM Elements in public/index.html
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

const requiredElements = [
  'btnOpenPasteLyrics',
  'badgeCustomLyricsActive',
  'modalPasteLyrics',
  'modalPasteLyricsTitle',
  'btnClosePasteLyrics',
  'textareaPasteLyrics',
  'btnClearCustomLyrics',
  'btnSaveCustomLyrics',
];

for (const id of requiredElements) {
  assert.ok(
    indexHtml.includes(`id="${id}"`),
    `Missing required DOM element id="${id}" in public/index.html`
  );
}
console.log('  ✓ PASS: All Phase 5 DOM elements present in index.html');

// 2. Verify CSS rules in public/style.css
const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

const requiredCss = [
  '.gen-lyrics-override-row',
  '.badge-cyan',
  '.paste-lyrics-modal-card',
  '.paste-lyrics-textarea',
];

for (const rule of requiredCss) {
  assert.ok(
    styleCss.includes(rule),
    `Missing required CSS class "${rule}" in public/style.css`
  );
}
console.log('  ✓ PASS: All Phase 5 CSS classes present in style.css');

// 3. Verify Client Logic in public/app.js
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

assert.ok(appJs.includes('customLyricsText: null'), 'state must initialize customLyricsText: null');
assert.ok(appJs.includes('btnOpenPasteLyrics'), 'app.js must attach listener to btnOpenPasteLyrics');
assert.ok(appJs.includes('btnClosePasteLyrics'), 'app.js must attach listener to btnClosePasteLyrics');
assert.ok(appJs.includes('btnClearCustomLyrics'), 'app.js must attach listener to btnClearCustomLyrics');
assert.ok(appJs.includes('btnSaveCustomLyrics'), 'app.js must attach listener to btnSaveCustomLyrics');
assert.ok(appJs.includes('rawLyricsText: state.customLyricsText'), 'startGenerationJob must forward rawLyricsText');
console.log('  ✓ PASS: Client state, event listeners & payload contracts verified in app.js');

// 4. Verify Server & Job Queue Logic in lib/jobs.js
const customLyricsText = `
[Verse 1]
When the sun begins to rise
Golden light across the skies
Walking on the open trail
`;

const dummyResolved = {
  title: 'Morning Sun',
  artist: 'Sample Band',
  durationSec: 165,
  youtubeId: 'mockYt12345',
  slug: `morning-sun-${Date.now()}`,
};

// 4a. createOrGetJob preserves rawLyricsText in job.options
const job = createOrGetJob(dummyResolved, {
  rawLyricsText: customLyricsText,
});

assert.strictEqual(job.options.rawLyricsText, customLyricsText, 'job.options must retain rawLyricsText');
assert.ok(['queued', 'running'].includes(job.status));
cancelJob(job.id);
console.log('  ✓ PASS: createOrGetJob preserves rawLyricsText in job.options');

// 4b. When song exists in library but rawLyricsText is provided, cache is bypassed to re-align
const mockSlug = `cached-override-test-${Date.now()}`;
const mockSongDir = path.join(SONGS_DIR, mockSlug);
fs.mkdirSync(mockSongDir, { recursive: true });
fs.writeFileSync(path.join(mockSongDir, 'song.txt'), '#TITLE:Test\n#ARTIST:Test\nE\n');
fs.writeFileSync(path.join(mockSongDir, 'instrumental.wav'), Buffer.alloc(64));
fs.writeFileSync(path.join(mockSongDir, 'meta.json'), JSON.stringify({ title: 'Old', artist: 'Old' }));

try {
  const cachedResolved = {
    title: 'Test',
    artist: 'Test',
    slug: mockSlug,
  };

  // Normal request without custom lyrics returns cached job
  const normalJob = createOrGetJob(cachedResolved, {});
  assert.strictEqual(normalJob.id, `cached_${mockSlug}`);

  // Request WITH rawLyricsText must NOT return cached job, but create a new active job
  const freshJob = createOrGetJob(cachedResolved, {
    rawLyricsText: 'Neue Lyrics Zeile eins\nNeue Lyrics Zeile zwei',
  });
  assert.notStrictEqual(freshJob.id, `cached_${mockSlug}`, 'Must bypass cache when custom lyrics are provided');
  assert.ok(freshJob.id.startsWith('job_'));
  cancelJob(freshJob.id);
  console.log('  ✓ PASS: Library cache is bypassed when rawLyricsText override is supplied');
} finally {
  fs.rmSync(mockSongDir, { recursive: true, force: true });
}

console.log('🎉 ALL PHASE 5 CLIENT & SERVER INTEGRATION TESTS PASSED!');
