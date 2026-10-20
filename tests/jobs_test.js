/**
 * tests/jobs_test.js - Unit tests for Job Queue & Song Library (Phase 6.2, 6.3, 6.4)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  checkSystemHealth,
  createOrGetJob,
  getJob,
  cancelJob,
} = require('../lib/jobs');
const {
  SONGS_DIR,
  listLibrarySongs,
  serveSongFile,
} = require('../lib/library');

console.log('🧪 RUNNING JOBS & LIBRARY TEST SUITE');

// 1. System Health Check
const health = checkSystemHealth();
assert.strictEqual(typeof health.status, 'string');
assert.strictEqual(typeof health.ytDlpAvailable, 'boolean');
assert.strictEqual(typeof health.ffmpegAvailable, 'boolean');
assert.strictEqual(typeof health.pythonVenvAvailable, 'boolean');
console.log('  ✓ PASS: checkSystemHealth (yt-dlp:', health.ytDlpAvailable, 'ffmpeg:', health.ffmpegAvailable, ')');

// 2. Job Creation & Idempotency
const dummyResolved = {
  title: 'Test Song',
  artist: 'Test Artist',
  durationSec: 180,
  artworkUrl: 'https://example.com/art.jpg',
  youtubeId: 'abcdefghijk',
  spotifyTrackId: '1234567890123456789012',
  slug: 'test-artist-test-song-job',
};

const job1 = createOrGetJob(dummyResolved, { forceWhisper: true });
assert.ok(job1.id.startsWith('job_'));
assert.strictEqual(job1.slug, 'test-artist-test-song-job');
assert.ok(['queued', 'running'].includes(job1.status));

// Idempotency: asking again for same track returns exact same job
const job2 = createOrGetJob(dummyResolved, { forceWhisper: true });
assert.strictEqual(job1.id, job2.id);
console.log('  ✓ PASS: createOrGetJob & Slug Idempotency');

// 3. Job Cancellation
const cancelled = cancelJob(job1.id);
assert.strictEqual(cancelled, true);
const retrieved = getJob(job1.id);
assert.strictEqual(retrieved.status, 'cancelled');
console.log('  ✓ PASS: cancelJob');

// 4. Library Catalog & Streaming
const testSlug = 'unit-test-artist-unit-test-title';
const testDir = path.join(SONGS_DIR, testSlug);
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

fs.writeFileSync(path.join(testDir, 'song.txt'), '#TITLE:Unit Test Title\n#ARTIST:Unit Test Artist\nE\n');
fs.writeFileSync(path.join(testDir, 'instrumental.wav'), Buffer.alloc(1024, 0));
fs.writeFileSync(
  path.join(testDir, 'meta.json'),
  JSON.stringify({
    title: 'Unit Test Title',
    artist: 'Unit Test Artist',
    durationSec: 200,
    syncType: 'syllable',
    provider: 'spicylyrics',
    qualityScore: 0.98,
    createdAt: new Date().toISOString(),
  })
);

const libList = listLibrarySongs();
const found = libList.find((s) => s.slug === testSlug);
assert.ok(found, 'Generated song should be present in listLibrarySongs');
assert.strictEqual(found.title, 'Unit Test Title');
assert.strictEqual(found.artist, 'Unit Test Artist');
assert.strictEqual(found.badgeType, 'Syllable-synced');
assert.strictEqual(found.hasInstrumental, true);
console.log('  ✓ PASS: listLibrarySongs');

// 5. HTTP Range Serving & Path Traversal Prevention
let statusCode = 0;
let headers = {};
let responseData = Buffer.alloc(0);

const mockRes = {
  writeHead(code, h) {
    statusCode = code;
    headers = h || {};
  },
  end(content) {
    if (content) responseData = Buffer.from(content);
  },
  write(chunk) {
    responseData = Buffer.concat([responseData, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  },
  on() {},
  once() {},
  emit() {},
};

// 5a. Path Traversal Test
serveSongFile({ headers: {} }, mockRes, '/songs/../../server.js');
assert.strictEqual(statusCode, 403, 'Path traversal attempt must be blocked with 403');
console.log('  ✓ PASS: serveSongFile path traversal protection');

// 5b. Range Request Test (HTTP 206)
const mockRangeReq = {
  headers: {
    range: 'bytes=0-15',
  },
};
serveSongFile(mockRangeReq, mockRes, `/songs/${testSlug}/instrumental.wav`);
assert.strictEqual(statusCode, 206, 'Range request should return 206 Partial Content');
assert.strictEqual(headers['Content-Range'], 'bytes 0-15/1024');
assert.strictEqual(headers['Content-Length'], 16);
assert.strictEqual(headers['Accept-Ranges'], 'bytes');
console.log('  ✓ PASS: serveSongFile HTTP 206 Range streaming');

// Clean up test directory
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch (_) {}

console.log('🎉 ALL JOBS & LIBRARY TESTS PASSED!');
