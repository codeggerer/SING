/**
 * tests/tier_consistency_phase5_test.js - Unit tests for Phase 5 of TIER_CONSISTENCY_AND_QUALITY_PLAN.md:
 * Cross-Tier Musicality & Live Stage Polishing
 *
 * Validates:
 * 1. UI Tier Transparency & Badges (Tier 1 Gold, Tier 2 Green, Tier 3 Cyan, Tier 4 Pink)
 * 2. 1-Click Upgrade Flow (#btnUpgradeLyrics, upgradeLyrics: true)
 * 3. Cache-bypass in lib/jobs.js on upgradeLyrics
 * 4. Explicit meta.lyricsTier recording and exposure in lib/library.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOrGetJob, getJob, cancelJob } = require('../lib/jobs');
const { SONGS_DIR, listLibrarySongs } = require('../lib/library');

console.log('🧪 RUNNING TIER CONSISTENCY PHASE 5 TEST SUITE');

// 1. Verify DOM Elements in public/index.html
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

const requiredElements = [
  'previewLyricsTierBadge',
  'btnUpgradeLyrics',
];

for (const id of requiredElements) {
  assert.ok(
    indexHtml.includes(`id="${id}"`),
    `Missing required DOM element id="${id}" in public/index.html`
  );
}
console.log('  ✓ PASS: All Phase 5 DOM elements present in index.html (previewLyricsTierBadge, btnUpgradeLyrics)');

// 2. Verify CSS rules in public/style.css
const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

const requiredCss = [
  '.badge-gold',
  '.badge-green',
  '.badge-cyan',
  '.badge-pink',
  '.upgrade-lyrics-btn',
];

for (const rule of requiredCss) {
  assert.ok(
    styleCss.includes(rule),
    `Missing required CSS class "${rule}" in public/style.css`
  );
}
console.log('  ✓ PASS: All 4-tier color badges (.badge-gold, .badge-green, .badge-cyan, .badge-pink, .upgrade-lyrics-btn) present in style.css');

// 3. Verify Client Logic & Contracts in public/app.js
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// Tier badge text contracts
assert.ok(
  appJs.includes('★ Tier 1: USDB Ground Truth (100% Timing & Pitch)'),
  'app.js must display "★ Tier 1: USDB Ground Truth (100% Timing & Pitch)" for Tier 1'
);
assert.ok(
  appJs.includes('✓ Tier 2: Studio Syllable-Sync'),
  'app.js must display "✓ Tier 2: Studio Syllable-Sync" for Tier 2'
);
assert.ok(
  appJs.includes('✓ Tier 3: Web Lyrics'),
  'app.js must display "✓ Tier 3: Web Lyrics" for Tier 3'
);
assert.ok(
  appJs.includes('⚡ Tier 4: Whisper AI Speech-to-Text'),
  'app.js must display "⚡ Tier 4: Whisper AI Speech-to-Text" for Tier 4'
);

// Upgrade button listener and flow
assert.ok(
  appJs.includes('btnUpgradeLyrics'),
  'app.js must reference btnUpgradeLyrics'
);
assert.ok(
  appJs.includes('upgradeLyrics: true'),
  'app.js must dispatch { upgradeLyrics: true } on upgrade button click'
);
console.log('  ✓ PASS: All Phase 5 tier badge labels, color contracts & upgrade flow verified in app.js');

// 4. Verify Server & Job Queue Logic in lib/jobs.js
const testSlug = 'test-upgrade-tier4-song';
const songDir = path.join(SONGS_DIR, testSlug);
if (!fs.existsSync(songDir)) {
  fs.mkdirSync(songDir, { recursive: true });
}

// Create a simulated Tier 4 cached library song
const fakeMeta = {
  generator_version: '6.0',
  slug: testSlug,
  title: 'Upgrade Test Track',
  artist: 'Test Artist',
  provider: 'whisper',
  syncType: 'none',
  lyricsTier: 4,
};
fs.writeFileSync(path.join(songDir, 'meta.json'), JSON.stringify(fakeMeta, null, 2), 'utf8');
fs.writeFileSync(path.join(songDir, 'song.txt'), '#TITLE:Upgrade Test Track\n#ARTIST:Test Artist\n#BPM:1500\n: 100 20 60 test\nE\n', 'utf8');
fs.writeFileSync(path.join(songDir, 'instrumental.wav'), 'RIFF....WAVE', 'utf8');
fs.writeFileSync(path.join(songDir, 'vocals.wav'), 'RIFF....WAVE', 'utf8');

const resolvedSong = {
  title: 'Upgrade Test Track',
  artist: 'Test Artist',
  slug: testSlug,
  durationSec: 120,
};

// Test A: Normal request should return cached library song
const cachedJob = createOrGetJob(resolvedSong, {});
assert.strictEqual(cachedJob.id, `cached_${testSlug}`, 'Normal request should hit library cache');
console.log('  ✓ PASS: Normal job request returns cached library song');

// Test B: Request with upgradeLyrics: true MUST bypass cache
const upgradeJob = createOrGetJob(resolvedSong, { upgradeLyrics: true });
assert.notStrictEqual(upgradeJob.id, `cached_${testSlug}`, 'upgradeLyrics request MUST bypass cached library song');
assert.strictEqual(upgradeJob.status, 'queued', 'Upgraded job should enter queue');
cancelJob(upgradeJob.id);
console.log('  ✓ PASS: Request with upgradeLyrics: true cleanly bypasses Tier 4 library cache');

// Test C: Verify listLibrarySongs exposes lyricsTier 4 for this song
const libSongs = listLibrarySongs();
const foundSong = libSongs.find((s) => s.slug === testSlug);
assert.ok(foundSong, 'Song must be listed in library');
assert.strictEqual(foundSong.lyricsTier, 4, 'Cached Tier 4 song must report lyricsTier === 4');
assert.strictEqual(foundSong.badgeType, 'Whisper-AI', 'Cached Tier 4 song must have badgeType Whisper-AI');
console.log('  ✓ PASS: listLibrarySongs correctly reports lyricsTier: 4 and badgeType: Whisper-AI');

// Cleanup
try {
  fs.rmSync(songDir, { recursive: true, force: true });
} catch (_) {}

console.log('🎉 ALL TIER CONSISTENCY PHASE 5 TESTS PASSED!\n');
