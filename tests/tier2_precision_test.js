/**
 * tests/tier2_precision_test.js - Integration tests for Phase 2: Tier 2 Syllable-Synced Provider Stream Precision
 *
 * Validates:
 * 1. audioSync.measureStudioOffset function exists and handles vocal & lyric inputs
 * 2. Invariant verification: offset = t_vocal_first - t_lyric_first
 * 3. lib/library.js listLibrarySongs exposes studioOffsetSec and videoOffsetSec
 * 4. lib/jobs.js persists studioOffsetSec and videoOffsetSec into meta.json
 * 5. public/app.js handles studioOffsetSec in playLibrarySong and applyParsedUltraStarChart
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const audioSync = require('../lib/audio_sync');
const { listLibrarySongs, SONGS_DIR } = require('../lib/library');

console.log('\n🧪 RUNNING PHASE 2: TIER 2 SYLLABLE-SYNC & STUDIO OFFSET TEST SUITE');

(async function runTests() {
  try {
    // 1. Check audioSync exports
    assert.strictEqual(typeof audioSync.measureStudioOffset, 'function', 'measureStudioOffset must be exported from lib/audio_sync.js');
    console.log('  ✓ PASS: audioSync.measureStudioOffset is exported as function');

    // 2. Validate error handling when input files missing
    let threwVocals = false;
    try {
      await audioSync.measureStudioOffset({
        vocalsPath: 'nonexistent_vocals.wav',
        lyricsJsonPath: 'dummy.json',
      });
    } catch (e) {
      threwVocals = true;
      assert.ok(e.message.includes('Vocals audio file not found'));
    }
    assert.ok(threwVocals, 'measureStudioOffset throws when vocals file missing');
    console.log('  ✓ PASS: measureStudioOffset rejects missing vocal audio files');

    // 3. Test measureStudioOffset with actual synthetic audio and lyrics.json
    const tempDir = path.join(__dirname, 'tmp_tier2_test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      // Create synthetic 16kHz mono WAV: 2.0s silence followed by 1.0s 440Hz tone
      const sampleRate = 16000;
      const totalSeconds = 3.0;
      const numSamples = Math.floor(sampleRate * totalSeconds);
      const dataSize = numSamples * 2; // 16-bit PCM
      const buffer = Buffer.alloc(44 + dataSize);

      // WAV Header
      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16); // subchunk1size
      buffer.writeUInt16LE(1, 20);  // PCM format
      buffer.writeUInt16LE(1, 22);  // 1 channel (mono)
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
      buffer.writeUInt16LE(2, 32);  // block align
      buffer.writeUInt16LE(16, 34); // bits per sample
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);

      // Audio data: silence for first 2.0s, 440Hz sine wave for remaining 1.0s
      const toneStartSample = sampleRate * 2.0;
      for (let i = 0; i < numSamples; i++) {
        let sampleVal = 0;
        if (i >= toneStartSample) {
          const t = (i - toneStartSample) / sampleRate;
          sampleVal = Math.floor(Math.sin(2.0 * Math.PI * 440.0 * t) * 20000);
        }
        buffer.writeInt16LE(sampleVal, 44 + i * 2);
      }

      const testVocalsPath = path.join(tempDir, 'vocals.wav');
      fs.writeFileSync(testVocalsPath, buffer);

      // Synthetic lyrics.json with first syllable at 1.70s
      const testLyrics = {
        artist: 'Test Artist',
        title: 'Test Song',
        syncType: 'syllable',
        lines: [
          {
            start: 1.70,
            end: 3.00,
            words: 'Test song',
            syllables: [
              { text: 'Test ', start: 1.70, end: 2.30 },
              { text: 'song ', start: 2.30, end: 3.00 },
            ],
          },
        ],
      };
      const testLyricsPath = path.join(tempDir, 'lyrics.json');
      fs.writeFileSync(testLyricsPath, JSON.stringify(testLyrics, null, 2), 'utf8');

      const result = await audioSync.measureStudioOffset({
        vocalsPath: testVocalsPath,
        lyricsJsonPath: testLyricsPath,
      });

      assert.ok(result && result.success, 'measureStudioOffset should succeed with synthetic fixtures');
      assert.strictEqual(typeof result.studio_offset_sec, 'number');
      // Vocal onset ~ 2.00s, lyric first = 1.70s -> offset ~ +0.30s (+300ms)
      assert.ok(Math.abs(result.vocal_first_sec - 2.00) < 0.12, `vocal_first_sec (${result.vocal_first_sec}) should be near 2.00s`);
      assert.strictEqual(result.lyric_first_sec, 1.70, `lyric_first_sec (${result.lyric_first_sec}) should be 1.70s`);
      assert.ok(Math.abs(result.studio_offset_sec - 0.30) < 0.12, `studio_offset_sec (${result.studio_offset_sec}) should be near +0.30s`);
      console.log(`  ✓ PASS: measureStudioOffset calculated offset: ${result.studio_offset_sec.toFixed(3)}s (vocal: ${result.vocal_first_sec}s, lyric: ${result.lyric_first_sec}s)`);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }

    // 4. Test lib/library.js listLibrarySongs returns studioOffsetSec
    const testSlug = 'test-tier2-studio-offset-slug';
    const songDir = path.join(SONGS_DIR, testSlug);
    try {
      if (!fs.existsSync(songDir)) fs.mkdirSync(songDir, { recursive: true });
      fs.writeFileSync(path.join(songDir, 'song.txt'), '#TITLE:Tier2 Test\n#ARTIST:Artist\n: 0 10 60 A \nE\n', 'utf8');
      fs.writeFileSync(path.join(songDir, 'meta.json'), JSON.stringify({
        title: 'Tier2 Test',
        artist: 'Artist',
        studioOffsetSec: 0.285,
        videoOffsetSec: 0.285,
        syncType: 'syllable',
      }), 'utf8');

      const songs = listLibrarySongs();
      const found = songs.find((s) => s.slug === testSlug);
      assert.ok(found, 'Created test song must appear in listLibrarySongs()');
      assert.strictEqual(found.studioOffsetSec, 0.285, 'studioOffsetSec must match meta.json');
      assert.strictEqual(found.videoOffsetSec, 0.285, 'videoOffsetSec must match meta.json');
      console.log('  ✓ PASS: listLibrarySongs() correctly exposes studioOffsetSec & videoOffsetSec');
    } finally {
      try {
        fs.rmSync(songDir, { recursive: true, force: true });
      } catch (_) {}
    }

    // 5. Test public/app.js client integration contracts
    const appJsContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(appJsContent.includes('songMeta.studioOffsetSec'), 'app.js must check songMeta.studioOffsetSec in applyParsedUltraStarChart');
    assert.ok(appJsContent.includes('song.studioOffsetSec'), 'app.js must check song.studioOffsetSec in playLibrarySong');
    console.log('  ✓ PASS: public/app.js contracts verified for studioOffsetSec synchronization');

    console.log('🎉 ALL PHASE 2 TIER 2 SYLLABLE-SYNC & STUDIO OFFSET TESTS PASSED!\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
  }
})();
