/**
 * tests/resolver_test.js - Unit tests for Resolver (Phase 6.1)
 */

const assert = require('assert');
const {
  parseDurationSec,
  extractSpotifyTrackId,
  extractYouTubeId,
  cleanYouTubeTitle,
  createSongSlug,
  resolveSpotifyTrackId,
  searchDeezer,
  resolveInput,
  findAlternativeYouTubeVideo,
} = require('../lib/resolver');

console.log('🧪 RUNNING RESOLVER TEST SUITE');

// 1. Duration Parsing
assert.strictEqual(parseDurationSec('3:45'), 225);
assert.strictEqual(parseDurationSec('0:30'), 30);
assert.strictEqual(parseDurationSec('1:02:15'), 3735);
assert.strictEqual(parseDurationSec(180), 180);
assert.strictEqual(parseDurationSec('invalid'), 0);
console.log('  ✓ PASS: parseDurationSec');

// 2. Spotify Track ID Extraction
assert.strictEqual(
  extractSpotifyTrackId('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
  '4cOdK2wGLETKBW3PvgPWqT'
);
assert.strictEqual(
  extractSpotifyTrackId('https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=abc'),
  '4cOdK2wGLETKBW3PvgPWqT'
);
assert.strictEqual(
  extractSpotifyTrackId('spotify:track:4cOdK2wGLETKBW3PvgPWqT'),
  '4cOdK2wGLETKBW3PvgPWqT'
);
assert.strictEqual(
  extractSpotifyTrackId('4cOdK2wGLETKBW3PvgPWqT'),
  '4cOdK2wGLETKBW3PvgPWqT'
);
assert.strictEqual(extractSpotifyTrackId('invalid string'), null);
console.log('  ✓ PASS: extractSpotifyTrackId');

// 3. YouTube ID Extraction
assert.strictEqual(
  extractYouTubeId('https://www.youtube.com/watch?v=fJ9rUzIMcZQ'),
  'fJ9rUzIMcZQ'
);
assert.strictEqual(
  extractYouTubeId('https://youtu.be/fJ9rUzIMcZQ?t=4'),
  'fJ9rUzIMcZQ'
);
assert.strictEqual(
  extractYouTubeId('https://music.youtube.com/watch?v=fJ9rUzIMcZQ&feature=share'),
  'fJ9rUzIMcZQ'
);
assert.strictEqual(
  extractYouTubeId('https://www.youtube.com/embed/fJ9rUzIMcZQ'),
  'fJ9rUzIMcZQ'
);
assert.strictEqual(extractYouTubeId('fJ9rUzIMcZQ'), 'fJ9rUzIMcZQ');
assert.strictEqual(extractYouTubeId('not a youtube id'), null);
console.log('  ✓ PASS: extractYouTubeId');

// 4. YouTube Title Cleaning & Artist Extraction
const t1 = cleanYouTubeTitle('Queen - Bohemian Rhapsody (Official Video)');
assert.strictEqual(t1.artist, 'Queen');
assert.strictEqual(t1.title, 'Bohemian Rhapsody');

const t2 = cleanYouTubeTitle('Adele – Someone Like You [Official Music Video]');
assert.strictEqual(t2.artist, 'Adele');
assert.strictEqual(t2.title, 'Someone Like You');

const t3 = cleanYouTubeTitle('Eminem - Without Me (Official Audio) [HD]', 'EminemMusic');
assert.strictEqual(t3.artist, 'Eminem');
assert.strictEqual(t3.title, 'Without Me');

const t4 = cleanYouTubeTitle('Flowers', 'Miley Cyrus - Topic');
assert.strictEqual(t4.artist, 'Miley Cyrus');
assert.strictEqual(t4.title, 'Flowers');

console.log('  ✓ PASS: cleanYouTubeTitle');

// 5. Slug Generation
assert.strictEqual(
  createSongSlug('Queen', "Don't Stop Me Now"),
  'queen-dont-stop-me-now'
);
assert.strictEqual(
  createSongSlug('Die Ärzte', 'M&F'),
  'die-arzte-m-f'
);
console.log('  ✓ PASS: createSongSlug');

// 6. Spotify Track ID Resolution & Search (Phase 1)
assert.strictEqual(typeof resolveSpotifyTrackId, 'function');
assert.strictEqual(typeof searchDeezer, 'function');

async function runAsyncTests() {
  // Test direct Spotify track resolution for Queen - Don't Stop Me Now
  const spotifyId = await resolveSpotifyTrackId('Queen', "Don't Stop Me Now");
  assert.strictEqual(spotifyId, '5T8EDUDqKcs6OSOwEsfqG7');
  console.log('  ✓ PASS: resolveSpotifyTrackId curated match');

  // Test resolveInput free text query
  const searchResolved = await resolveInput("Queen - Don't Stop Me Now");
  assert.strictEqual(searchResolved.type, 'search');
  assert.strictEqual(searchResolved.spotifyTrackId, '5T8EDUDqKcs6OSOwEsfqG7');
  console.log('  ✓ PASS: resolveInput (Free-text Spotify Track ID match)');

  // Test resolveInput YouTube URL resolution (matching curated catalog / video)
  const ytResolved = await resolveInput('https://www.youtube.com/watch?v=HgzGwKwLmgM');
  assert.strictEqual(ytResolved.type, 'youtube');
  assert.strictEqual(ytResolved.youtubeId, 'HgzGwKwLmgM');
  assert.strictEqual(ytResolved.spotifyTrackId, '5T8EDUDqKcs6OSOwEsfqG7');
  console.log('  ✓ PASS: resolveInput (YouTube URL Spotify Track ID match)');

  // Test resolveInput with unknown mock YouTube video
  const mockSearchYt = async (q, targetDur) => [
    { videoId: 'mock1234567', title: 'Queen - Bohemian Rhapsody', durationSec: 354, syncScore: 100 },
  ];

  const resolved = await resolveInput('https://www.youtube.com/watch?v=mock1234567', {
    searchYouTubeFn: mockSearchYt,
  });

  assert.strictEqual(resolved.type, 'youtube');
  assert.strictEqual(resolved.youtubeId, 'mock1234567');
  assert.strictEqual(typeof resolved.slug, 'string');
  console.log('  ✓ PASS: resolveInput (YouTube URL mock)');

  // 7. Deadlink Auto-Recovery & Alternative YouTube Matching (Phase 1.2)
  const mockCandidates = [
    { videoId: 'blocked1111', title: 'Queen - Bohemian Rhapsody (Blocked Video)', durationSec: 354, syncScore: 100 },
    { videoId: 'wrongdur222', title: 'Queen - Bohemian Rhapsody Live at Wembley', durationSec: 240, syncScore: 60 },
    { videoId: 'working3333', title: 'Queen - Bohemian Rhapsody (Official Audio)', durationSec: 356, syncScore: 95 },
  ];
  let searchedQuery = '';
  const searchMock = async (q) => {
    searchedQuery = q;
    return mockCandidates;
  };

  const recovered = await findAlternativeYouTubeVideo('Queen', 'Bohemian Rhapsody', 355, searchMock, {
    excludeVideoId: 'blocked1111',
    maxDurationDiffSec: 5,
  });

  assert.ok(recovered, 'Must recover a valid alternative video');
  assert.strictEqual(recovered.videoId, 'working3333', 'Must select duration-matched official audio, excluding blocked video');
  assert.strictEqual(searchedQuery, 'Queen Bohemian Rhapsody Official Audio');
  console.log('  ✓ PASS: findAlternativeYouTubeVideo (deadlink recovery & ±5s duration matching)');

  console.log('🎉 ALL RESOLVER TESTS PASSED!');
}

runAsyncTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
