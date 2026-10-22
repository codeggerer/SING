/**
 * tests/test_lyrics_harvester.js - Test Suite for Plain-Text Lyrics Harvester (Phase 1)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  cleanLyricsText,
  extractLyricsFromDescription,
  extractGeniusContainers,
  extractSnippetLyrics,
  fetchYouTubeDescription,
  fetchLyricsOvh,
  fetchLrclibPlain,
  fetchGeniusPlain,
  fetchDuckDuckGoSnippet,
  harvestPlainLyrics,
  harvestPlainLyricsFull,
} = require('../lib/lyrics_harvester');

console.log('\n====================================================');
console.log('🌾 RUNNING PLAIN-TEXT LYRICS HARVESTER TEST SUITE (PHASE 1)');
console.log('====================================================\n');

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

(async () => {
  // --- Test Suite 1: Text Cleaning & Normalization ---
  console.log('--- Test Suite 1: Text Cleaning & Normalization ---');

  test('Strips section headers in brackets and parentheses ([Intro], (Hook), Verse 1:)', () => {
    const raw = `
[Intro]
(Hook)
Verse 1:
Komm mit mir und wir singen laut
[Bridge]
Wo die Reise hingeht ist egal
Refrain:
Solang die Musik toent
[Outro]
`;
    const cleaned = cleanLyricsText(raw);
    const lines = cleaned.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], 'Komm mit mir und wir singen laut');
    assert.strictEqual(lines[1], 'Wo die Reise hingeht ist egal');
    assert.strictEqual(lines[2], 'Solang die Musik toent');
  });

  test('Strips uppercase standalone section headers (HOOK, VERSE, VERSE 2, STROPHE 1)', () => {
    const raw = `
HOOK
Komm mit mir und wir singen laut
VERSE
Viel zu gut gelaunt im Sonnenschein
VERSE 2
Schoener Morgen lieber Freund
STROPHE 1
Draussen hat sich viel veraendert
`;
    const cleaned = cleanLyricsText(raw);
    const lines = cleaned.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 4);
    assert.strictEqual(lines[0], 'Komm mit mir und wir singen laut');
    assert.strictEqual(lines[1], 'Viel zu gut gelaunt im Sonnenschein');
    assert.strictEqual(lines[2], 'Schoener Morgen lieber Freund');
    assert.strictEqual(lines[3], 'Draussen hat sich viel veraendert');
  });

  test('Strips guitar chord lines (Am C G D, Em7 A7 Dsus4 G)', () => {
    const raw = `
Am   C   G   D
Komm mit mir und wir singen laut
Em7   A7   Dsus4   G
Wo die Reise hingeht ist egal
C#m   F#m   B7   E
Solang die Musik toent
`;
    const cleaned = cleanLyricsText(raw);
    const lines = cleaned.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], 'Komm mit mir und wir singen laut');
    assert.strictEqual(lines[1], 'Wo die Reise hingeht ist egal');
    assert.strictEqual(lines[2], 'Solang die Musik toent');
  });

  test('Strips inline bracketed chords ([Am]Fenster [G]runter)', () => {
    const raw = `
[Am]Komm [C]mit mir und [G]wir [D]singen
[Em7]Wo die Reise hingeht [A7]ist egal solang [Dsus4]wir singen
`;
    const cleaned = cleanLyricsText(raw);
    const lines = cleaned.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], 'Komm mit mir und wir singen');
    assert.strictEqual(lines[1], 'Wo die Reise hingeht ist egal solang wir singen');
  });

  test('Strips credits, socials, URLs, and Genius artifacts', () => {
    const raw = `
Video: Test Director
Song, Mix, Prod.: Test Artist
Mastering: Test Engineer
Car: Test Automobile
14 Contributors
Embed
Komm mit mir und wir singen laut
wo es lang geht is egal
solang wir singen
siehst du die letzten Sonnenstrahlen
komm lass uns wandern durch das weite Tal
denn so wie es war wird es immer schoen sein
nein nein
viel zu gut gelaunt im Sonnenschein
Follow on Instagram: https://instagram.com/sample_artist
Stream on Spotify: https://spoti.fi/123
`;
    const cleaned = cleanLyricsText(raw);
    const lines = cleaned.split('\n').filter(Boolean);
    assert.ok(lines.every((l) => !l.includes('Test Director')));
    assert.ok(lines.every((l) => !l.includes('Mastering')));
    assert.ok(lines.every((l) => !l.includes('Contributors')));
    assert.ok(lines.every((l) => !l.includes('Embed')));
    assert.ok(lines.every((l) => !l.includes('https://')));
    assert.ok(lines.every((l) => !l.includes('Instagram')));
    assert.strictEqual(lines[0], 'Komm mit mir und wir singen laut');
  });

  test('Decodes HTML entities and normalizes unicode punctuation', () => {
    const raw = `
Komm mit mir und wir fahr&#39;n
&quot;Wo es langgeht&quot; &amp; wohin
Siehst du die letzten Sonnenstrahl&#x27;n &nbsp;
Denn so wie’s war wird es nie wieder sein – nein
`;
    const cleaned = cleanLyricsText(raw);
    const lines = cleaned.split('\n').filter(Boolean);
    assert.strictEqual(lines[0], "Komm mit mir und wir fahr'n");
    assert.strictEqual(lines[1], '"Wo es langgeht" & wohin');
    assert.strictEqual(lines[2], "Siehst du die letzten Sonnenstrahl'n");
    assert.strictEqual(lines[3], "Denn so wie's war wird es nie wieder sein - nein");
  });

  // --- Test Suite 2: YouTube Description Extraction (Synthetic Fixture) ---
  console.log('\n--- Test Suite 2: YouTube Description Extraction ---');

  test('Extracts official lyrics from synthetic YouTube description fixture', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'sample_description.txt');
    assert.ok(fs.existsSync(fixturePath), 'sample_description.txt fixture must exist');
    const desc = fs.readFileSync(fixturePath, 'utf8');

    const extracted = extractLyricsFromDescription(desc);
    assert.ok(extracted, 'Must extract lyrics from sample description');

    const lines = extracted.split('\n').filter(Boolean);
    assert.ok(lines.length >= 25, `Expected >= 25 lines, got ${lines.length}`);

    // Verify key lyrics content
    assert.strictEqual(lines[0], 'High upon the mountain trail and we ride along');
    assert.ok(extracted.includes('Sonnenstrahlen am Horizont'));
    assert.ok(extracted.includes('Weisser Wanderweg'));
    assert.ok(extracted.includes('Egal wie tief das Tal gemacht'));

    // Verify zero unwanted noise was retained
    assert.ok(!extracted.includes('Test Director'), 'Must not contain director');
    assert.ok(!extracted.includes('Jan Testengineer'), 'Must not contain mastering engineer');
    assert.ok(!extracted.includes('Classic Test Car'), 'Must not contain car credit');
    assert.ok(!extracted.includes('HOOK'), 'Must not contain raw HOOK header');
    assert.ok(!extracted.includes('VERSE 2'), 'Must not contain raw VERSE 2 header');
  });

  test('Rejects YouTube descriptions that do not contain lyrics', () => {
    const nonLyricsDesc = `
Official Music Video for our new single.
Directed by John Doe.
Produced by ACME Records.
Subscribe for more updates: https://youtube.com/channel123
Follow us on social media: @artist
(C) 2026 ACME Records.
`;
    const result = extractLyricsFromDescription(nonLyricsDesc);
    assert.strictEqual(result, null, 'Must reject description without lyrics');
  });

  // --- Test Suite 3: Genius HTML Parsing ---
  console.log('\n--- Test Suite 3: Genius HTML Parsing ---');

  test('Parses data-lyrics-container elements from Genius HTML fixture', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'genius_sample.html');
    assert.ok(fs.existsSync(fixturePath), 'genius_sample.html fixture must exist');
    const html = fs.readFileSync(fixturePath, 'utf8');

    const containers = extractGeniusContainers(html);
    assert.strictEqual(containers.length, 2, 'Should find 2 data-lyrics-container divs');

    const rawFragments = containers.map((c) => {
      return c
        .replace(/<div data-exclude-from-selection="true"[\s\S]*?<\/div>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    });

    const combinedRaw = rawFragments.join('\n');
    const cleaned = cleanLyricsText(combinedRaw);
    const lines = cleaned.split('\n').filter(Boolean);

    assert.ok(lines.length >= 10, `Expected >= 10 lines, got ${lines.length}`);
    assert.strictEqual(lines[0], 'High upon the mountain trail and we ride along');
    assert.ok(!cleaned.includes('Contributors'), 'Must strip Contributors button');
    assert.ok(!cleaned.includes('[Hook]'), 'Must strip [Hook]');
    assert.ok(!cleaned.includes('[Verse 1]'), 'Must strip [Verse 1]');
  });

  // --- Test Suite 4: Multi-Source Priority & User Override ---
  console.log('\n--- Test Suite 4: Multi-Source Priority & User Override ---');

  await testAsync('Priority 0: Manual user rawLyricsText overrides all remote sources', async () => {
    const customText = `
Eigener Songtext Zeile 1
Eigener Songtext Zeile 2
Eigener Songtext Zeile 3
Eigener Songtext Zeile 4
Eigener Songtext Zeile 5
Eigener Songtext Zeile 6
Eigener Songtext Zeile 7
Eigener Songtext Zeile 8
`;
    const res = await harvestPlainLyricsFull({
      artist: 'Sample Artist',
      title: 'Sample Title',
      youtubeId: '3DXs26gPm-I',
      description: 'Lyrics:\nWrong lyrics from description\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8',
      rawLyricsText: customText,
    });

    assert.strictEqual(res.source, 'manual');
    assert.ok(res.lyrics.includes('Eigener Songtext Zeile 1'));
    assert.strictEqual(res.lineCount, 8);
  });

  await testAsync('Priority 1: YouTube description is selected when provided in options', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'sample_description.txt');
    const desc = fs.readFileSync(fixturePath, 'utf8');

    const res = await harvestPlainLyricsFull({
      artist: 'Sample Artist',
      title: 'Sample Title',
      description: desc,
    });

    assert.strictEqual(res.source, 'youtube_description');
    assert.ok(res.lineCount >= 25);
    assert.ok(res.lyrics.includes('High upon the mountain trail and we ride along'));
  });

  await testAsync('Priority 2: lyrics.ovh function is exported and cleanLyricsText formats properly', async () => {
    assert.strictEqual(typeof fetchLyricsOvh, 'function', 'fetchLyricsOvh is function');
    const sample = 'Hello, it is me\nI was wondering if after all these years\nYou would like to meet\nTo go over everything';
    const cleaned = cleanLyricsText(sample);
    assert.strictEqual(cleaned.split('\n').filter(Boolean).length, 4);
  });

  await testAsync('Priority 3: LRCLIB plainLyrics fallback works with fixture', async () => {
    const lrcFixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'lrclib_get.json'), 'utf8')
    );
    assert.ok(lrcFixture.plainLyrics, 'LRCLIB fixture has plainLyrics');

    // Simulate cleanLyricsText on LRCLIB plainLyrics
    const cleaned = cleanLyricsText(lrcFixture.plainLyrics);
    assert.ok(cleaned.includes('Today is gonna be the day'));
  });

  await testAsync('harvestPlainLyrics backwards-compatible string return', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'sample_description.txt');
    const desc = fs.readFileSync(fixturePath, 'utf8');

    const resultString = await harvestPlainLyrics('Sample Artist', 'Sample Title', null, {
      description: desc,
    });

    assert.strictEqual(typeof resultString, 'string');
    assert.ok(resultString.includes('High upon the mountain trail and we ride along'));
  });

  // --- Test Suite 5: DuckDuckGo Snippet Harvester (Phase 3.3) ---
  console.log('\n--- Test Suite 5: DuckDuckGo Snippet Harvester (Phase 3.3) ---');

  test('extractSnippetLyrics parses slash-separated search engine snippets with HTML tags', () => {
    const rawSnippet = '<b>High upon the mountain</b> trail / Where the gentle breezes blow / Sun is shining bright / Watching as the rivers flow...';
    const extracted = extractSnippetLyrics(rawSnippet);
    assert.ok(extracted, 'Should extract lyrics from snippet');
    const lines = extracted.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 4);
    assert.strictEqual(lines[0], 'High upon the mountain trail');
    assert.strictEqual(lines[1], 'Where the gentle breezes blow');
    assert.strictEqual(lines[2], 'Sun is shining bright');
    assert.strictEqual(lines[3], 'Watching as the rivers flow');
  });

  test('extractSnippetLyrics rejects non-lyrics snippets with fewer than 4 lines', () => {
    const rawSnippet = 'Official video for the hit song released in 2024. Stream now on all platforms.';
    const extracted = extractSnippetLyrics(rawSnippet);
    assert.strictEqual(extracted, null, 'Must reject snippets with fewer than 4 lines');
  });

  test('Priority 5: fetchDuckDuckGoSnippet is exported and callable', () => {
    assert.strictEqual(typeof fetchDuckDuckGoSnippet, 'function', 'fetchDuckDuckGoSnippet must be a function');
  });

  await testAsync('Priority 5: harvestPlainLyricsFull returns duckduckgo_snippet when cached', async () => {
    const cacheDir = path.join(__dirname, '..', 'lyrics_cache', 'harvester', 'duckduckgo');
    fs.mkdirSync(cacheDir, { recursive: true });

    const crypto = require('crypto');
    const testArt = 'testphase3artist';
    const testTit = 'testphase3song';
    const cacheKey = `ddg_${testArt}_${testTit}`;
    const hash = crypto.createHash('sha1').update(cacheKey.toLowerCase()).digest('hex');
    const filePath = path.join(cacheDir, `${hash}.json`);

    const cachedSnippet = "Erste Strophe Testzeile\nZweite Strophe Testzeile\nDritte Strophe Testzeile\nVierte Strophe Testzeile";
    fs.writeFileSync(filePath, JSON.stringify({
      source: 'duckduckgo',
      key: cacheKey,
      timestamp: Date.now(),
      isMiss: false,
      lyrics: cachedSnippet,
    }), 'utf8');

    try {
      const res = await harvestPlainLyricsFull({
        artist: testArt,
        title: testTit,
      });

      assert.ok(res, 'Must return result');
      assert.strictEqual(res.source, 'duckduckgo_snippet', 'Must identify source as duckduckgo_snippet');
      assert.strictEqual(res.lineCount, 4);
      assert.ok(res.lyrics.includes('Erste Strophe Testzeile'));
    } finally {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  console.log('\n====================================================');
  console.log(`TOTAL RESULTS: ${passCount} PASSED, 0 FAILED`);
  console.log('====================================================\n');
})();
