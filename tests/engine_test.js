const fs = require('fs');
const path = require('path');

// 1. Math & Music Utility Functions from app.js
function hzToMidi(hz) {
  if (hz <= 0) return 0;
  return 69 + 12 * Math.log2(hz / 440);
}

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function getMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 2. MPM Pitch Detection (McLeod Pitch Method)
function detectPitchMPM(buffer, sampleRate) {
  const N = Math.min(buffer.length, 1536);
  const minLag = Math.floor(sampleRate / 1000);
  const maxLag = Math.min(N - 2, Math.floor(sampleRate / 78));

  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acf = 0;
    let divisor = 0;
    for (let i = 0; i < N - tau; i++) {
      const a = buffer[i];
      const b = buffer[i + tau];
      acf += a * b;
      divisor += a * a + b * b;
    }
    nsdf[tau] = divisor > 0 ? (2 * acf) / divisor : 0;
  }

  const peaks = [];
  let inPositiveLobe = false;
  let passedFirstZeroCross = false;
  let lobeMaxTau = -1;
  let lobeMaxVal = -1;

  for (let tau = minLag; tau <= maxLag; tau++) {
    const val = nsdf[tau];
    if (!passedFirstZeroCross) {
      if (val <= 0) passedFirstZeroCross = true;
      continue;
    }

    if (val > 0) {
      if (!inPositiveLobe) {
        inPositiveLobe = true;
        lobeMaxTau = tau;
        lobeMaxVal = val;
      } else if (val > lobeMaxVal) {
        lobeMaxVal = val;
        lobeMaxTau = tau;
      }
    } else if (inPositiveLobe) {
      if (lobeMaxVal > 0.35) {
        peaks.push({ tau: lobeMaxTau, val: lobeMaxVal });
      }
      inPositiveLobe = false;
    }
  }
  if (inPositiveLobe && lobeMaxVal > 0.35) {
    peaks.push({ tau: lobeMaxTau, val: lobeMaxVal });
  }

  if (peaks.length === 0) return { hz: 0, clarity: 0 };

  let globalMaxVal = 0;
  for (const p of peaks) {
    if (p.val > globalMaxVal) globalMaxVal = p.val;
  }

  const threshold = 0.82 * globalMaxVal;
  const chosenPeak = peaks.find((p) => p.val >= threshold) || peaks[0];
  const bestTau = chosenPeak.tau;

  if (bestTau > minLag && bestTau < maxLag) {
    const y1 = nsdf[bestTau - 1];
    const y2 = nsdf[bestTau];
    const y3 = nsdf[bestTau + 1];
    const denom = y1 - 2 * y2 + y3;
    const delta = denom !== 0 ? (0.5 * (y1 - y3)) / denom : 0;
    const refinedTau = bestTau + Math.max(-1, Math.min(1, delta));
    return {
      hz: sampleRate / refinedTau,
      clarity: Math.min(1, chosenPeak.val),
    };
  }

  return {
    hz: sampleRate / bestTau,
    clarity: Math.min(1, chosenPeak.val),
  };
}

// 3. Octave Folding
function foldMidiToTarget(rawMidi, targetMidi, prevDisplayMidi = null) {
  let signedDiff = ((((rawMidi - targetMidi) % 12) + 18) % 12) - 6;
  let candidate = targetMidi + signedDiff;

  if (prevDisplayMidi !== null) {
    if (candidate - prevDisplayMidi > 7.5) candidate -= 12;
    else if (prevDisplayMidi - candidate > 7.5) candidate += 12;
  }
  return candidate;
}

// 4. UltraStar Parser
function parseUltraStarTxt(txt) {
  const rawLines = txt.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let artist = '';
  let bpm = 300;
  let realBpm = 0;
  let gapMs = 0;
  let videoGapSec = 0;
  let videoId = '';
  let duration = 0;

  const trackEvents = [[]];
  let currentTrackIdx = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(1, colonIdx).trim().toUpperCase();
      const val = line.slice(colonIdx + 1).trim();

      if (key === 'TITLE') title = val;
      else if (key === 'ARTIST') artist = val;
      else if (key === 'BPM') bpm = parseFloat(val.replace(',', '.')) || 300;
      else if (key === 'ALLKARAOKE_REALBPM' || key === 'REALBPM') realBpm = parseFloat(val.replace(',', '.')) || 0;
      else if (key === 'GAP') gapMs = parseFloat(val.replace(',', '.')) || 0;
      else if (key === 'VIDEOGAP') videoGapSec = parseFloat(val.replace(',', '.')) || 0;
      else if (key === 'ALLKARAOKE_DURATION') duration = parseFloat(val.replace(',', '.')) || 0;
      else if (key === 'VIDEO') {
        const m = val.match(/v=([a-zA-Z0-9_-]{11})/);
        if (m) videoId = m[1];
        else if (/^[a-zA-Z0-9_-]{11}$/.test(val)) videoId = val;
      }
      continue;
    }

    if (line === 'P1' || line.startsWith('P 1')) {
      currentTrackIdx = 0;
      continue;
    }
    if (line === 'P2' || line.startsWith('P 2')) {
      currentTrackIdx = 1;
      if (!trackEvents[1]) trackEvents[1] = [];
      continue;
    }
    if (line === 'E') break;

    if (line.startsWith('-')) {
      const parts = line.slice(1).trim().split(/\s+/);
      const breakBeat = parseFloat(parts[0]);
      if (!isNaN(breakBeat)) {
        trackEvents[currentTrackIdx].push({ type: 'break', beat: breakBeat });
      }
      continue;
    }

    const noteMatch = rawLine.match(/^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/);
    if (noteMatch) {
      trackEvents[currentTrackIdx].push({
        type: 'note',
        noteType: noteMatch[1],
        beat: parseInt(noteMatch[2], 10),
        length: parseInt(noteMatch[3], 10),
        rawPitch: parseInt(noteMatch[4], 10),
        text: noteMatch[5] || '',
      });
    }
  }

  const beatDurSec = 15 / bpm;
  const gapSec = gapMs / 1000;

  const builtTracks = trackEvents
    .filter((evList) => evList.some((e) => e.type === 'note'))
    .map((evList, tIdx) => {
      const rawPitches = evList
        .filter((e) => e.type === 'note' && e.noteType !== 'F' && e.noteType !== 'R')
        .map((e) => e.rawPitch)
        .sort((a, b) => a - b);

      const medianRaw = rawPitches.length > 0 ? rawPitches[Math.floor(rawPitches.length / 2)] : 60;
      const octaveShift = Math.round((64 - medianRaw) / 12) * 12;

      const notes = [];
      const lines = [];
      let currentLineSyllables = [];
      let noteId = 1;

      const flushLine = () => {
        if (currentLineSyllables.length === 0) return;
        const lineStart = currentLineSyllables[0].startTime;
        const lineEnd = currentLineSyllables[currentLineSyllables.length - 1].endTime;
        const fullText = currentLineSyllables
          .map((s) => s.text)
          .join('')
          .replace(/~/g, '')
          .trim();

        const lineIdx = lines.length;
        currentLineSyllables.forEach((s) => {
          s.lineIndex = lineIdx;
        });

        lines.push({
          startTime: lineStart,
          endTime: lineEnd,
          text: fullText || '♪',
          syllables: currentLineSyllables,
        });
        currentLineSyllables = [];
      };

      for (const ev of evList) {
        if (ev.type === 'break') {
          flushLine();
          continue;
        }

        const startTime = gapSec + ev.beat * beatDurSec;
        const dur = Math.max(0.06, ev.length * beatDurSec);
        const midi = ev.rawPitch + octaveShift;
        const displaySyl = ev.text === '~' || ev.text.trim() === '~' ? '–' : ev.text;

        const noteObj = {
          id: noteId++,
          startTime,
          endTime: startTime + dur,
          duration: dur,
          midi,
          text: displaySyl,
          lineIndex: 0,
          isGolden: ev.noteType === '*' || ev.noteType === 'G',
          isFreestyle: ev.noteType === 'F' || ev.noteType === 'R',
        };

        notes.push(noteObj);
        currentLineSyllables.push(noteObj);
      }
      flushLine();

      return {
        lines,
        notes,
      };
    });

  return {
    title,
    artist,
    bpm,
    realBpm,
    gapMs,
    videoGapSec,
    videoId,
    duration,
    tracks: builtTracks,
  };
}

// 5. Studio Offset Calculator
function calculateUltraStarStudioOffset(ultraLines, lrcText) {
  if (!lrcText || !ultraLines || ultraLines.length === 0) return 0;

  const lrcItems = [];
  const lineRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\](.*)/;
  for (const raw of lrcText.split('\n')) {
    const m = raw.match(lineRegex);
    if (!m) continue;
    const time = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    const text = m[3].replace(/<[^>]+>/g, '').trim();
    if (text.length > 0) {
      lrcItems.push({ time, text, clean: cleanForMatching(text) });
    }
  }

  if (lrcItems.length === 0) return 0;

  function cleanForMatching(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().replace(/\s+/g, ' ');
  }

  const offsetCandidates = [];

  for (const uLine of ultraLines) {
    const uClean = cleanForMatching(uLine.text);
    if (uClean.length < 5) continue;
    const uWords = uClean.split(' ');

    let bestMatch = null;
    let bestScore = 0;

    for (const lItem of lrcItems) {
      if (Math.abs(lItem.time - uLine.startTime) > 75) continue;
      let matches = 0;
      for (const w of uWords) {
        if (w.length >= 3 && lItem.clean.includes(w)) matches++;
      }
      const score = matches / Math.max(uWords.length, 1);
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestMatch = lItem;
      }
    }

    if (bestMatch) {
      const diff = bestMatch.time - uLine.startTime;
      offsetCandidates.push(diff);
    }
  }

  if (offsetCandidates.length === 0) {
    return Math.round((lrcItems[0].time - ultraLines[0].startTime) * 100) / 100;
  }

  offsetCandidates.sort((a, b) => a - b);
  const median = offsetCandidates[Math.floor(offsetCandidates.length / 2)];
  return Math.round(median * 100) / 100;
}

// -------------------------------------------------------------
// TEST SUITE EXECUTION
// -------------------------------------------------------------
async function runTestSuite() {
  console.log('====================================================');
  console.log('🎤 RUNNING COMPLETE SING KARAOKE ENGINE TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // TEST SUITE 1: UltraStar Master Catalog Index
  console.log('--- Test Suite 1: UltraStar Database Index (6,682 Songs) ---');
  const catalogPath = path.join(__dirname, '..', 'public', 'ultrastar_index.json');
  assert(fs.existsSync(catalogPath), 'ultrastar_index.json exists in public/');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert(Array.isArray(catalog), 'Catalog is a valid JSON array');
  assert(catalog.length >= 6680, `Catalog contains all songs (actual: ${catalog.length})`);

  const artistsToCheck = ['Queen', 'Oasis', 'ABBA', 'Robbie Williams', 'Adele', 'Lady Gaga', 'Linkin Park'];
  for (const art of artistsToCheck) {
    const hits = catalog.filter((s) => (s.artist || '').toLowerCase().includes(art.toLowerCase()));
    assert(hits.length > 0, `Catalog contains ${hits.length} songs for artist: ${art}`);
  }

  // TEST SUITE 2: UltraStar File Parser & Sync Math
  console.log('\n--- Test Suite 2: UltraStar .txt Parser & Syllable Segmentation ---');
  const sampleTxt = `
#TITLE:Aura Lea
#ARTIST:Traditional
#BPM:308,8
#GAP:162,92
#VIDEO:v=HgzGwKwLmgM
: 21 6 55 As 
: 28 5 55 the 
: 34 9 53 black- 
- 43
: 51 4 53 bird 
: 56 5 53 in 
: 61 6 57 the 
: 67 7 60 spring 
: 74 7 65 'neath 
: 82 25 64 the 
- 108
E
  `.trim();

  const parsed = parseUltraStarTxt(sampleTxt);
  assert(parsed.title === "Aura Lea", 'Title parsed correctly');
  assert(parsed.artist === 'Traditional', 'Artist parsed correctly');
  assert(parsed.bpm === 308.8, 'BPM parsed with comma conversion');
  assert(parsed.videoId === 'HgzGwKwLmgM', 'Video ID extracted from URL pattern');
  assert(parsed.tracks.length === 1, 'Single lead vocal track created');
  assert(parsed.tracks[0].lines.length === 2, '2 lyric lines separated by break "-"');
  assert(parsed.tracks[0].notes.length === 9, '9 syllables parsed correctly');

  // Check precise note time:
  // beatDur = 15 / 308.8 = 0.048575s
  // gap = 0.16292s
  // note 1 startTime = gap + 21 * beatDur = 0.16292 + 1.02007 = 1.183s
  const n1 = parsed.tracks[0].notes[0];
  assert(Math.abs(n1.startTime - 1.183) < 0.01, `Note 1 start time is accurate (1.183s, got ${n1.startTime.toFixed(3)}s)`);

  // TEST SUITE 3: Synthetic Voice Audio & MPM Pitch Detection
  console.log('\n--- Test Suite 3: MPM Pitch Detection with Harmonic Singing Models ---');
  const sampleRate = 44100;
  const frameLength = 2048;

  const testNotes = [
    { name: 'A2 (Male Low)', midi: 45, hz: 110.0 },
    { name: 'C3 (Male Baritone)', midi: 48, hz: 130.81 },
    { name: 'A3 (Tenor / Alto)', midi: 57, hz: 220.0 },
    { name: 'C4 (Middle C)', midi: 60, hz: 261.63 },
    { name: 'A4 (Female Soprano / Belt)', midi: 69, hz: 440.0 },
    { name: 'C5 (High Female)', midi: 72, hz: 523.25 },
  ];

  for (const tNote of testNotes) {
    // Generate synthetic vocal buffer with fundamental + 4 harmonics
    const buf = new Float32Array(frameLength);
    const f0 = tNote.hz;

    for (let i = 0; i < frameLength; i++) {
      const t = i / sampleRate;
      const phase = 2 * Math.PI * f0 * t;

      // Vocal formant / harmonics: 1.0 at f0, 0.5 at 2*f0, 0.25 at 3*f0, 0.12 at 4*f0
      let sample = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase) + 0.12 * Math.sin(4 * phase);

      // Add ambient mic noise (SNR ~ 30dB)
      sample += (Math.random() - 0.5) * 0.04;

      buf[i] = sample * 0.4;
    }

    const { hz, clarity } = detectPitchMPM(buf, sampleRate);
    const detectedMidi = hzToMidi(hz);
    const midiError = Math.abs(detectedMidi - tNote.midi);

    assert(
      clarity > 0.9 && midiError < 0.05,
      `${tNote.name} (${tNote.hz}Hz): Detected ${hz.toFixed(2)}Hz (MIDI ${detectedMidi.toFixed(3)}, err: ${midiError.toFixed(3)} st, clarity: ${(clarity * 100).toFixed(1)}%)`
    );
  }

  // Also test natural vibrato performance (5.5 Hz vibrato over 20 frames)
  console.log('Testing natural singing vibrato tracking:');
  const vibratoFrames = 20;
  const hopSize = 882;
  const vibratoF0 = 440;
  let phaseAcc = 0;
  const detectedVibratoMidis = [];

  for (let f = 0; f < vibratoFrames; f++) {
    const vBuf = new Float32Array(frameLength);
    for (let i = 0; i < frameLength; i++) {
      const t = (f * hopSize + i) / sampleRate;
      const instHz = vibratoF0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * t));
      phaseAcc += (2 * Math.PI * instHz) / sampleRate;
      vBuf[i] = Math.sin(phaseAcc) + 0.4 * Math.sin(2 * phaseAcc) + (Math.random() - 0.5) * 0.03;
    }
    const res = detectPitchMPM(vBuf, sampleRate);
    if (res.clarity > 0.8) {
      detectedVibratoMidis.push(hzToMidi(res.hz));
    }
  }
  const avgVibratoMidi = detectedVibratoMidis.reduce((a, b) => a + b, 0) / detectedVibratoMidis.length;
  assert(
    Math.abs(avgVibratoMidi - 69.0) < 0.08,
    `Vibrato Tracking (A4 440Hz): Mean detected MIDI is ${avgVibratoMidi.toFixed(3)} (err: ${Math.abs(avgVibratoMidi - 69).toFixed(3)} st)`
  );

  // TEST SUITE 4: Octave Folding Logic
  console.log('\n--- Test Suite 4: Octave Folding & Vocal Range Adaptation ---');
  // Target is C4 (60)
  // Male singer sings A2 (45), diff is -15 semitones -> folded should be A3 (57), within 3 semitones of C4!
  const foldedMale = foldMidiToTarget(45, 60, null);
  assert(foldedMale === 57, `Male A2 (45) singing C4 (60) folds to A3 (57) without jump (got ${foldedMale})`);

  // Target is C4 (60)
  // Female singer sings C5 (72), diff is +12 semitones -> folded should be C4 (60)!
  const foldedFemale = foldMidiToTarget(72, 60, null);
  assert(foldedFemale === 60, `Female C5 (72) singing C4 (60) folds to C4 (60) (got ${foldedFemale})`);

  // TEST SUITE 5: Studio vs Video Offset Calculation
  console.log('\n--- Test Suite 5: Studio Offset Alignment Engine ---');
  const sampleUltraLines = [
    { startTime: 37.7, text: 'Twinkle twinkle little star how I wonder what you are' },
    { startTime: 43.1, text: 'Up above the world so high like a diamond in the sky' },
    { startTime: 49.3, text: 'Twinkle twinkle little star how I wonder what you are' },
  ];

  const sampleLrcText = `
[00:14.20] Twinkle twinkle little star how I wonder what you are
[00:19.60] Up above the world so high like a diamond in the sky
[00:25.80] Twinkle twinkle little star how I wonder what you are
  `.trim();

  // Video starts at 37.7s, Studio starts at 14.2s.
  // Offset candidate = 14.2 - 37.7 = -23.5s!
  const offset = calculateUltraStarStudioOffset(sampleUltraLines, sampleLrcText);
  assert(Math.abs(offset - (-23.5)) < 0.1, `Studio offset correctly calculated as -23.50s (actual: ${offset}s)`);

  // TEST SUITE 6: Live Server API Endpoints
  console.log('\n--- Test Suite 6: Live Server HTTP Endpoints & API Delivery ---');
  const http = require('http');

  function httpGetJson(url) {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data) });
            } catch (e) {
              resolve({ status: res.statusCode, raw: data });
            }
          });
        })
        .on('error', (err) => resolve({ status: 0, error: err.message }));
    });
  }

  function httpGetText(url) {
    return new Promise((resolve) => {
      http
        .get(url, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, text: data }));
        })
        .on('error', (err) => resolve({ status: 0, error: err.message }));
    });
  }

  const indexRes = await httpGetText('http://127.0.0.1:3000/index.html');
  if (indexRes.status === 200) {
    assert(indexRes.text.includes('id="pitchCanvas"'), 'index.html contains pitchCanvas');
    assert(indexRes.text.includes('id="btnModeSpotify"'), 'index.html contains Spotify mode button');
    assert(indexRes.text.includes('id="selectYtVideo"'), 'index.html contains YouTube version select');
  } else {
    console.log(`  (Note: Live server test skipped or unaccessible via loopback: ${indexRes.error || indexRes.status})`);
  }

  const ytRes = await httpGetJson('http://127.0.0.1:3000/api/youtube?q=Queen+Dont+Stop+Me+Now&duration=210');
  if (ytRes.status === 200 && ytRes.data?.videos) {
    assert(Array.isArray(ytRes.data.videos) && ytRes.data.videos.length > 0, `YouTube API returned ${ytRes.data.videos.length} embeddable videos`);
    assert(ytRes.data.videos[0].videoId.length === 11, `First video has valid 11-char ID (${ytRes.data.videos[0].videoId}: ${ytRes.data.videos[0].title})`);
  }

  const searchRes = await httpGetJson('http://127.0.0.1:3000/api/search?q=Queen');
  if (searchRes.status === 200 && searchRes.data?.results) {
    assert(Array.isArray(searchRes.data.results), `Search API returned ${searchRes.data.results.length} songs`);
  }

  console.log('\n====================================================');
  console.log(`TOTAL RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});

