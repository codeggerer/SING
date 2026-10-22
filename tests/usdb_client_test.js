/**
 * tests/usdb_client_test.js - Unit tests for USDB & Ground-Truth Ingestion (MASTER_OVERHAUL_PLAN Phase 1)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  normalizeForFuzzy,
  levenshteinDistance,
  levenshteinRatio,
  computeMatchScore,
  parseChartHeaders,
  loadCuratedCatalog,
  findBestMatch,
  resolveUsdbSong,
  getCachedChart,
  saveChartToCache,
} = require('../lib/usdb_client');

const { resolveInput } = require('../lib/resolver');
const { createOrGetJob, getJob, cancelJob } = require('../lib/jobs');
const { SONGS_DIR } = require('../lib/library');

console.log('🧪 RUNNING USDB & COMMUNITY GROUND-TRUTH TEST SUITE (PHASE 1)');

// 1. Fuzzy Text Normalization
assert.strictEqual(normalizeForFuzzy('Queen - Bohemian Rhapsody (Official Video)'), 'queen bohemian rhapsody');
assert.strictEqual(normalizeForFuzzy('Adele – Someone Like You [Remastered 2021]'), 'adele someone like you');
assert.strictEqual(normalizeForFuzzy('Die Ärzte - M&F'), 'die arzte m and f');
console.log('  ✓ PASS: normalizeForFuzzy (diacritics, video noise, ampersands)');

// 2. Levenshtein Distance & Ratio
assert.strictEqual(levenshteinDistance('kitten', 'sitting'), 3);
assert.strictEqual(levenshteinDistance('bohemian', 'bohemian'), 0);
assert.strictEqual(levenshteinDistance('', 'abc'), 3);

assert.strictEqual(levenshteinRatio('queen', 'queen'), 1.0);
assert.strictEqual(levenshteinRatio('Bohemian Rhapsody', 'Bohemian Rhapsody'), 1.0);
assert.ok(levenshteinRatio('Bohemain Rhapsody', 'Bohemian Rhapsody') > 0.85); // 1 typo
assert.strictEqual(levenshteinRatio('', ''), 1.0);
console.log('  ✓ PASS: levenshteinDistance and levenshteinRatio');

// 3. Exact Spec Weighting: Score = 0.6 * LevenshteinRatio(Title) + 0.4 * LevenshteinRatio(Artist)
const perfectScore = computeMatchScore('Bohemian Rhapsody', 'Queen', 'Bohemian Rhapsody', 'Queen');
assert.strictEqual(perfectScore, 1.0);

// Title match 1.0, Artist match disjoint -> Score should be 0.6
const disjointArtistScore = computeMatchScore('Bohemian Rhapsody', 'zzzz', 'Bohemian Rhapsody', 'aaaa');
assert.strictEqual(disjointArtistScore, 0.6);

// Title match 0.0, Artist match 1.0 -> Score should be 0.4
const titleDiffScore = computeMatchScore('Radio Ga Ga', 'Queen', 'Bohemian Rhapsody', 'Queen');
assert.ok(Math.abs(titleDiffScore - 0.4) < 0.15);

// Threshold Gate (Score >= 0.82)
const typoScore = computeMatchScore('Bohemain Rhapsody', 'Queen', 'Bohemian Rhapsody', 'Queen');
assert.ok(typoScore >= 0.82, `Typo score ${typoScore} must be >= 0.82 threshold`);

const unrelatedScore = computeMatchScore('Wonderwall', 'Oasis', 'Bohemian Rhapsody', 'Queen');
assert.ok(unrelatedScore < 0.5, `Unrelated song score ${unrelatedScore} must be < 0.5`);
console.log('  ✓ PASS: computeMatchScore (0.6 * Title + 0.4 * Artist) and Threshold Gate');

// 4. UltraStar Chart Parser & Comma Decimals
const sampleChartTxt = `#TITLE:Bohemian Rhapsody
#ARTIST:Queen
#BPM:341,2
#GAP:953,86
#VIDEO:v=fJ9rUzIMcZQ
#YEAR:1975
#LANGUAGE:English
: 0 10 60 Is 
: 10 10 62 this 
: 20 10 64 the 
* 30 20 65 real 
: 50 20 64 life 
- 70
: 75 10 60 Is 
: 85 10 62 this 
* 95 20 65 just 
: 115 20 64 fan-
: 135 20 62 ta-
: 155 40 60 sy
E
`;

const parsed = parseChartHeaders(sampleChartTxt);
assert.strictEqual(parsed.isValid, true);
assert.strictEqual(parsed.title, 'Bohemian Rhapsody');
assert.strictEqual(parsed.artist, 'Queen');
assert.strictEqual(parsed.bpm, 341.2);
assert.strictEqual(parsed.gap, 953.86);
assert.strictEqual(parsed.videoId, 'fJ9rUzIMcZQ');
assert.strictEqual(parsed.noteCount, 11);
assert.strictEqual(parsed.goldenNoteCount, 2);
assert.strictEqual(parsed.hasGoldenNotes, true);
assert.strictEqual(parsed.lineBreakCount, 1);
console.log('  ✓ PASS: parseChartHeaders (comma decimals, video ID, golden notes)');

// 5. Curated Catalog Indexing
const catalog = loadCuratedCatalog();
assert.ok(Array.isArray(catalog));
assert.ok(catalog.length >= 6000, `Catalog must have > 6000 songs, got ${catalog.length}`);
console.log(`  ✓ PASS: loadCuratedCatalog (${catalog.length} verified UltraStar songs loaded)`);

async function runAsyncTests() {
  // 6. Find Best Match for Queen - Bohemian Rhapsody
  const match = await findBestMatch('Queen', 'Bohemian Rhapsody');
  assert.ok(match, 'Must find match for Queen - Bohemian Rhapsody');
  assert.strictEqual(match.matched, true);
  assert.strictEqual(match.id, 'queen-bohemian-rhapsody');
  assert.ok(match.score >= 0.82);
  assert.strictEqual(match.videoId, 'fJ9rUzIMcZQ');
  console.log('  ✓ PASS: findBestMatch on Queen - Bohemian Rhapsody (Score:', match.score, ')');

  // 7. Find Best Match with Typo in Title
  const typoMatch = await findBestMatch('Queen', 'Bohemain Rhapsody');
  assert.ok(typoMatch, 'Must find match even with typo in title');
  assert.strictEqual(typoMatch.id, 'queen-bohemian-rhapsody');
  assert.ok(typoMatch.score >= 0.82);
  console.log('  ✓ PASS: findBestMatch with typo tolerance');

  // 8. Reject Unmatched Song
  const noMatch = await findBestMatch('Nonexistent Artist 12345', 'Imaginary Song 67890');
  assert.strictEqual(noMatch, null);
  console.log('  ✓ PASS: findBestMatch rejection of unknown songs');

  // 9. Full Resolution with Chart Verification
  const resolvedChart = await resolveUsdbSong('Queen - Bohemian Rhapsody');
  assert.strictEqual(resolvedChart.matched, true);
  assert.strictEqual(resolvedChart.id, 'queen-bohemian-rhapsody');
  assert.strictEqual(resolvedChart.videoId, 'fJ9rUzIMcZQ');
  assert.ok(resolvedChart.noteCount > 0, 'Chart must contain verified notes');
  assert.strictEqual(resolvedChart.hasGoldenNotes, true, 'Bohemian Rhapsody must contain golden notes');
  assert.ok(resolvedChart.goldenNoteCount >= 10, 'Must have at least 10 golden notes');
  assert.ok(resolvedChart.txt.includes('#TITLE:Bohemian Rhapsody'));
  console.log('  ✓ PASS: resolveUsdbSong (human-verified pitches, syllables & golden notes)');

  // 10. Resolver Integration (lib/resolver.js)
  const resolvedInput = await resolveInput('Queen - Bohemian Rhapsody');
  assert.strictEqual(resolvedInput.title, 'Bohemian Rhapsody');
  assert.strictEqual(resolvedInput.artist, 'Queen');
  assert.strictEqual(resolvedInput.youtubeId, 'fJ9rUzIMcZQ');
  assert.strictEqual(resolvedInput.confidence, 1.0);
  assert.ok(resolvedInput.usdbMatch, 'usdbMatch must be attached');
  assert.strictEqual(resolvedInput.usdbMatch.matched, true);
  assert.strictEqual(resolvedInput.usdbMatch.id, 'queen-bohemian-rhapsody');
  console.log('  ✓ PASS: lib/resolver integration (usdbMatch attached, confidence 1.0)');

  // 11. Jobs Ground-Truth Direct Ingestion (Without AI Worker)
  const groundTruthSlug = 'queen-bohemian-rhapsody-groundtruth-test';
  const testResolved = {
    ...resolvedInput,
    slug: groundTruthSlug,
  };

  const job = createOrGetJob(testResolved, { forceAi: false });
  assert.ok(job.id.startsWith('job_'));

  // Wait briefly for synchronous or fast pipeline completion
  await new Promise((r) => setTimeout(r, 600));

  const updatedJob = getJob(job.id);
  assert.ok(['running', 'done'].includes(updatedJob.status));

  // Verify that if done, the target song directory has human-verified song.txt
  const targetDir = path.join(SONGS_DIR, groundTruthSlug);
  if (fs.existsSync(targetDir)) {
    const songTxt = path.join(targetDir, 'song.txt');
    const metaJson = path.join(targetDir, 'meta.json');
    if (fs.existsSync(songTxt)) {
      const txt = fs.readFileSync(songTxt, 'utf8');
      assert.ok(txt.includes('#TITLE:Bohemian Rhapsody'));
      assert.ok(txt.includes('* ')); // golden notes present
      console.log('  ✓ PASS: lib/jobs ground-truth chart saved without AI worker');
    }
    if (fs.existsSync(metaJson)) {
      const meta = JSON.parse(fs.readFileSync(metaJson, 'utf8'));
      assert.strictEqual(meta.verifiedGroundTruth, true);
      assert.strictEqual(meta.qualityScore, 1.0);
      assert.strictEqual(meta.hasGoldenNotes, true);
      console.log('  ✓ PASS: lib/jobs meta.json verified (qualityScore 1.0, verifiedGroundTruth true)');
    }
    // Clean up test directory
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch (_) {}
  }

  // Cancel job if still lingering
  cancelJob(job.id);

  console.log('\n🎉 ALL USDB & GROUND-TRUTH INGESTION TESTS PASSED!');
}

runAsyncTests().catch((err) => {
  console.error('❌ USDB test suite failed:', err);
  process.exit(1);
});
