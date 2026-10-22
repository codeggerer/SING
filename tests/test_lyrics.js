/**
 * tests/test_lyrics.js - Unit Tests for Lyrics Provider Chain & Normalizers
 * (PLAN.md Phase 2)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  normalizeSpicyLyrics,
  normalizeSpotifyColorLyrics,
  normalizeLrclib,
  parseAppleMusicTtml,
  validateLyricsDoc,
  rankSyncType,
  detectLanguage,
  cleanText,
  TokenBucket,
} = require('../lib/lyrics');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

let testsPassed = 0;
let testsTotal = 0;

function it(name, fn) {
  testsTotal++;
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function runTests() {
  console.log(`====================================================`);
  console.log(`🎤 LYRICS PROVIDER CHAIN & NORMALIZER TESTS (Phase 2)`);
  console.log(`====================================================\n`);

  console.log(`--- Test Suite 1: Spicy Lyrics Normalizer & Fixtures ---`);

  it('Normalizes Spicy Lyrics syllable-synced fixture correctly', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'spicylyrics_syllable.json'), 'utf8')
    );
    const doc = normalizeSpicyLyrics(raw);

    assert.ok(doc, 'Should return a valid LyricsDoc');
    assert.strictEqual(doc.source, 'spicylyrics');
    assert.strictEqual(doc.syncType, 'syllable');
    assert.strictEqual(doc.language, 'de');
    assert.strictEqual(doc.lines.length, 2);

    const line0 = doc.lines[0];
    assert.strictEqual(line0.start, 12.34);
    assert.strictEqual(line0.end, 15.8);
    assert.strictEqual(line0.agent, 'lead');
    assert.strictEqual(line0.syllables.length, 8);

    const syl0 = line0.syllables[0];
    assert.strictEqual(syl0.text, 'Un-');
    assert.strictEqual(syl0.start, 12.34);
    assert.strictEqual(syl0.end, 12.62);
    assert.strictEqual(syl0.joinNext, true);

    const line1 = doc.lines[1];
    assert.strictEqual(line1.agent, 'background');
  });

  it('Normalizes official Spicy Lyrics API v1 real payload fixture (Lead & Background Content)', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'spicylyrics_real_sample.json'), 'utf8')
    );
    const doc = normalizeSpicyLyrics(raw);

    assert.ok(doc, 'Should return a valid LyricsDoc');
    assert.strictEqual(doc.source, 'spicylyrics');
    assert.strictEqual(doc.syncType, 'syllable');
    assert.ok(doc.lines.length > 20, 'Should extract all vocal and background lines');

    // First line should be "Tonight, I'm gonna have myself a real good time"
    const line0 = doc.lines[0];
    assert.strictEqual(line0.start, 0.0);
    assert.strictEqual(line0.agent, 'lead');
    assert.ok(line0.syllables.length >= 8);
    assert.strictEqual(line0.syllables[0].text, 'Tonight,');

    // Check that background lines were extracted and tagged as background
    const bgLines = doc.lines.filter((l) => l.agent === 'background');
    assert.ok(bgLines.length > 0, 'Should extract background lines');
    assert.strictEqual(bgLines[0].agent, 'background');

    // Check syllable joinNext handling (e.g. "grav" + "i" + "ty")
    const joinedSyllables = doc.lines
      .flatMap((l) => l.syllables)
      .filter((s) => s.joinNext);
    assert.ok(joinedSyllables.length > 0, 'Should preserve joinNext for multi-syllable words');
  });

  it('Normalizes Spicy Lyrics line-synced fixture correctly', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'spicylyrics_line.json'), 'utf8')
    );
    const doc = normalizeSpicyLyrics(raw);

    assert.ok(doc);
    assert.strictEqual(doc.source, 'spicylyrics');
    assert.strictEqual(doc.syncType, 'line');
    assert.strictEqual(doc.language, 'en');
    assert.strictEqual(doc.lines.length, 2);
    assert.strictEqual(doc.lines[0].start, 10.0);
    assert.strictEqual(doc.lines[0].end, 14.0);
  });

  console.log(`\n--- Test Suite 2: Spotify Color-Lyrics Normalizer ---`);

  it('Normalizes Spotify color-lyrics v2 fixture and resolves endTimeMs "0"', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'spotify_color_lyrics.json'), 'utf8')
    );
    const doc = normalizeSpotifyColorLyrics(raw);

    assert.ok(doc);
    assert.strictEqual(doc.source, 'spotify');
    assert.strictEqual(doc.syncType, 'line');
    assert.strictEqual(doc.language, 'en');
    assert.strictEqual(doc.lines.length, 3);

    // First line had endTimeMs = "0", should be derived from second line start (13.8s)
    assert.strictEqual(doc.lines[0].start, 10.5);
    assert.strictEqual(doc.lines[0].end, 13.8);

    // Third line is background: "(Back to you)"
    assert.strictEqual(doc.lines[2].agent, 'background');
    assert.strictEqual(doc.lines[2].end, 21.0);
  });

  console.log(`\n--- Test Suite 3: LRCLIB Normalizer & LRC Parsing ---`);

  it('Parses LRC timestamps, strips musical notes, and detects background agent', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'lrclib_get.json'), 'utf8')
    );
    const doc = normalizeLrclib(raw);

    assert.ok(doc);
    assert.strictEqual(doc.source, 'lrclib');
    assert.strictEqual(doc.syncType, 'line');
    // Note: line 4 with '♪' must be dropped! Total lines should be 3
    assert.strictEqual(doc.lines.length, 3);

    assert.strictEqual(doc.lines[0].start, 10.5);
    assert.strictEqual(doc.lines[1].start, 15.2);
    assert.strictEqual(doc.lines[2].agent, 'background');
  });

  console.log(`\n--- Test Suite 4: Text Cleaning & Language Detection ---`);

  it('Strips zero-width spaces, BOM, and carriage returns', () => {
    const raw = '\uFEFF\u200BHello world\r\n\u200D';
    assert.strictEqual(cleanText(raw), 'Hello world');
  });

  it('Detects German vs English based on stop words', () => {
    const deLines = [
      { words: 'Ich gehe in die Schule und ich sehe das' },
      { words: 'Es ist ein schöner Tag' },
    ];
    assert.strictEqual(detectLanguage(deLines), 'de');

    const enLines = [
      { words: 'Today is gonna be the day that they throw it' },
      { words: 'I do not believe that anybody feels the way I do' },
    ];
    assert.strictEqual(detectLanguage(enLines), 'en');
  });

  console.log(`\n--- Test Suite 5: Quality Gate & Validation ---`);

  it('Passes valid document through Quality Gate', () => {
    const validDoc = {
      lines: [
        { start: 5.0, end: 8.0, words: 'First line' },
        { start: 9.0, end: 12.0, words: 'Second line' },
      ],
    };
    const res = validateLyricsDoc(validDoc);
    assert.strictEqual(res.valid, true);
  });

  it('Rejects non-monotonic lines', () => {
    const badDoc = {
      lines: [
        { start: 10.0, end: 12.0, words: 'First line' },
        { start: 8.0, end: 11.0, words: 'Backwards in time' },
      ],
    };
    const res = validateLyricsDoc(badDoc);
    assert.strictEqual(res.valid, false);
    assert.ok(res.reason.includes('Non-monotonic'));
  });

  it('Rejects doc with syllable > 4.0s in multi-syllable word', () => {
    const badDoc = {
      lines: [
        {
          start: 5.0,
          end: 15.0,
          words: 'Long word',
          syllables: [
            { text: 'A', start: 5.0, end: 6.0 },
            { text: 'B', start: 6.0, end: 12.0 }, // 6s duration!
          ],
        },
      ],
    };
    const res = validateLyricsDoc(badDoc);
    assert.strictEqual(res.valid, false);
    assert.ok(res.reason.includes('exceeds 4.0s'));
  });

  it('Rejects low audio coverage (< 70%)', () => {
    const shortDoc = {
      lines: [
        { start: 10.0, end: 30.0, words: 'Short 20s section' },
      ],
    };
    // 20s coverage out of 100s audio = 20%
    const res = validateLyricsDoc(shortDoc, { durationSec: 100 });
    assert.strictEqual(res.valid, false);
    assert.ok(res.reason.includes('below required 70%'));
  });

  it('Accepts track with long instrumental intro and outro measured against active vocal region', () => {
    // 200s audio, intro 45s, outro 45s, vocal section 45s -> 155s (110s duration)
    // Under raw duration: 110 / 200 = 55% (< 70%), but relative to active vocal region: 100%
    const introOutroDoc = {
      lines: [
        { start: 45.0, end: 50.0, words: 'Verse 1 begins after long guitar intro' },
        { start: 100.0, end: 110.0, words: 'Chorus in the middle' },
        { start: 150.0, end: 155.0, words: 'Final line before long outro solo' },
      ],
    };
    const res = validateLyricsDoc(introOutroDoc, { durationSec: 200 });
    assert.strictEqual(res.valid, true);

    // Also supports explicit vocalStartSec / vocalEndSec
    const resExplicit = validateLyricsDoc(introOutroDoc, {
      durationSec: 200,
      vocalStartSec: 45.0,
      vocalEndSec: 155.0,
    });
    assert.strictEqual(resExplicit.valid, true);
  });

  console.log(`\n--- Test Suite 6: Sync Rank & Rate Limiter ---`);

  it('Ranks sync types correctly (syllable > word > line > static)', () => {
    assert.strictEqual(rankSyncType('syllable'), 4);
    assert.strictEqual(rankSyncType('word'), 3);
    assert.strictEqual(rankSyncType('line'), 2);
    assert.strictEqual(rankSyncType('static'), 1);
    assert.ok(rankSyncType('syllable') > rankSyncType('line'));
  });

  it('Token bucket consumes tokens and regulates rate', async () => {
    const bucket = new TokenBucket({ maxPerSec: 2, maxPerMin: 5 });
    assert.strictEqual(bucket.secTokens, 2);
    await bucket.acquire();
    assert.strictEqual(bucket.secTokens, 1);
    await bucket.acquire();
    assert.strictEqual(bucket.secTokens, 0);
  });

  console.log(`\n--- Test Suite 7: Apple Music TTML Parser & Syllable Precision (Phase 3) ---`);

  it('Parses Apple Music TTML with millisecond syllable bounds and background vocals', () => {
    const ttmlRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'apple_music_syllable.ttml'), 'utf8');
    const doc = parseAppleMusicTtml(ttmlRaw);

    assert.ok(doc, 'Should return a valid LyricsDoc from TTML');
    assert.strictEqual(doc.source, 'apple');
    assert.strictEqual(doc.syncType, 'syllable');
    assert.strictEqual(doc.title, 'Hello World');
    assert.strictEqual(doc.artist, 'Test Artist');
    assert.strictEqual(doc.lines.length, 2);

    const line0 = doc.lines[0];
    assert.strictEqual(line0.start, 12.34);
    assert.strictEqual(line0.startTime, 12.34);
    assert.strictEqual(line0.end, 14.4);
    assert.strictEqual(line0.endTime, 14.4);
    assert.strictEqual(line0.agent, 'lead');
    assert.strictEqual(line0.words, 'Hel-lo world');
    assert.strictEqual(line0.text, 'Hel-lo world');
    assert.strictEqual(line0.syllables.length, 3);

    const s0 = line0.syllables[0];
    assert.strictEqual(s0.text, 'Hel-');
    assert.strictEqual(s0.start, 12.34);
    assert.strictEqual(s0.startTime, 12.34);
    assert.strictEqual(s0.end, 12.8);
    assert.strictEqual(s0.endTime, 12.8);
    assert.strictEqual(s0.joinNext, true);

    const s1 = line0.syllables[1];
    assert.strictEqual(s1.text, 'lo ');
    assert.strictEqual(s1.start, 12.8);
    assert.strictEqual(s1.startTime, 12.8);
    assert.strictEqual(s1.end, 13.5);
    assert.strictEqual(s1.endTime, 13.5);
    assert.strictEqual(s1.joinNext, false);

    const s2 = line0.syllables[2];
    assert.strictEqual(s2.text, 'world');
    assert.strictEqual(s2.start, 13.6);
    assert.strictEqual(s2.startTime, 13.6);
    assert.strictEqual(s2.end, 14.4);
    assert.strictEqual(s2.endTime, 14.4);
    assert.strictEqual(s2.joinNext, false);

    const line1 = doc.lines[1];
    assert.strictEqual(line1.agent, 'background');
    assert.strictEqual(line1.start, 17.1);
    assert.strictEqual(line1.startTime, 17.1);
    assert.strictEqual(line1.end, 20.5);
    assert.strictEqual(line1.endTime, 20.5);
  });

  console.log(`\n--- Test Suite 8: SpicyLyrics Compact Syllable Schema c: [{ s, t, e }] (Phase 3) ---`);

  it('Parses SpicyLyrics compact syllable format c: [{ s, t, e }]', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'spicylyrics_compact_syllable.json'), 'utf8')
    );
    const doc = normalizeSpicyLyrics(raw);

    assert.ok(doc, 'Should parse compact schema');
    assert.strictEqual(doc.source, 'spicylyrics');
    assert.strictEqual(doc.syncType, 'syllable');
    assert.strictEqual(doc.artist, 'Test Artist');
    assert.strictEqual(doc.title, 'Hello World');
    assert.strictEqual(doc.lines.length, 2);

    const line0 = doc.lines[0];
    assert.strictEqual(line0.agent, 'lead');
    assert.strictEqual(line0.start, 12.0);
    assert.strictEqual(line0.startTime, 12.0);
    assert.strictEqual(line0.end, 16.8);
    assert.strictEqual(line0.endTime, 16.8);
    assert.strictEqual(line0.syllables.length, 3);
    assert.strictEqual(line0.syllables[0].text, 'Hel-');
    assert.strictEqual(line0.syllables[0].start, 12.34);
    assert.strictEqual(line0.syllables[0].startTime, 12.34);
    assert.strictEqual(line0.syllables[0].end, 12.8);
    assert.strictEqual(line0.syllables[0].endTime, 12.8);
    assert.strictEqual(line0.syllables[0].joinNext, true);

    const line1 = doc.lines[1];
    assert.strictEqual(line1.agent, 'background');
    assert.strictEqual(line1.start, 17.1);
    assert.strictEqual(line1.startTime, 17.1);
  });

  console.log(`\n--- Test Suite 9: Canonical LyricsDoc Schema Dual Compatibility (Phase 3) ---`);

  it('Verifies LyricsDoc canonical schema contains artist, title, startTime, endTime, and text', () => {
    const canonicalDoc = {
      artist: 'Queen',
      title: 'Bohemian Rhapsody',
      syncType: 'syllable',
      lines: [
        {
          startTime: 12.34,
          endTime: 16.8,
          text: 'Hello world',
          syllables: [
            { text: 'Hel-', startTime: 12.34, endTime: 12.8 },
            { text: 'lo ', startTime: 12.8, endTime: 13.5 },
            { text: 'world', startTime: 13.6, endTime: 14.4 },
          ],
        },
      ],
    };

    // Quality gate should validate successfully using startTime and endTime
    const val = validateLyricsDoc(canonicalDoc);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(canonicalDoc.artist, 'Queen');
    assert.strictEqual(canonicalDoc.title, 'Bohemian Rhapsody');
    assert.strictEqual(canonicalDoc.lines[0].startTime, 12.34);
    assert.strictEqual(canonicalDoc.lines[0].text, 'Hello world');
  });

  console.log(`\n====================================================`);
  console.log(`TOTAL RESULTS: ${testsPassed} PASSED, ${testsTotal - testsPassed} FAILED`);
  console.log(`====================================================`);

  if (testsPassed !== testsTotal) {
    process.exit(1);
  }
}

runTests();
