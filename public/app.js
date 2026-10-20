/* ============================================================================
 * SING! PARTY – YouTube & Spotify Premium Studio Karaoke Engine
 * ============================================================================ */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10];

const ALLKARAOKE_BASE = 'https://raw.githubusercontent.com/Asvarox/allkaraoke/master/public/songs';

// Verified Embeddable Fallback Audio/Lyric Videos for Quick-Start Songs
// Verified Embeddable Fallback Audio/Lyric Videos for Quick-Start Songs
const VERIFIED_YOUTUBE_FALLBACKS = {
  "queen don't stop me now": [
    { videoId: 'HgzGwKwLmgM', title: "Queen – Don't Stop Me Now (Official Video)", isOriginalGap: true },
    { videoId: 'MHi9mKq0slA', title: "Queen – Don't Stop Me Now (Official Lyric Video)", isOriginalGap: false },
  ],
  'abba dancing queen': [
    { videoId: 'xFrGuyw1V8s', title: 'ABBA – Dancing Queen (Official Video)', isOriginalGap: true },
    { videoId: '-sVB91NTa4A', title: 'ABBA – Dancing Queen (Official Lyric Video)', isOriginalGap: false },
  ],
  'oasis wonderwall': [
    { videoId: 'bx1Bh8ZvH84', title: 'Oasis – Wonderwall (Official Video)', isOriginalGap: true },
    { videoId: '6hzrDeceEKc', title: 'Oasis – Wonderwall (Official Audio)', isOriginalGap: false },
  ],
  'robbie williams angels': [
    { videoId: 'luwAMFcc2f8', title: 'Robbie Williams – Angels (Official Video)', isOriginalGap: true },
  ],
  'adele someone like you': [
    { videoId: 'hLQl3WQQoQ0', title: 'Adele – Someone Like You (Official Video)', isOriginalGap: true },
  ],
  'backstreet boys i want it that way': [
    { videoId: '4fndeDfaWCg', title: 'Backstreet Boys – I Want It That Way', isOriginalGap: true },
  ],
  'lady gaga bad romance': [
    { videoId: 'qrO4YZeyl0I', title: 'Lady Gaga – Bad Romance (Official Video)', isOriginalGap: true },
  ],
  'linkin park in the end': [
    { videoId: 'eVTXPUF4Oz4', title: 'Linkin Park – In The End (Official Video)', isOriginalGap: true },
    { videoId: 'fv1pMNdsGWE', title: 'Linkin Park – In The End (Lyrics)', isOriginalGap: false },
  ],
};

// Application State
const state = {
  // Catalog
  ultraStarCatalog: [],
  catalogLoaded: false,

  // Playback Mode ('youtube' | 'spotify')
  playbackSource: 'youtube',

  // Active Song & Chart
  currentSong: null,
  isUltraStarChart: false,
  duetTracks: [],
  activeTrackIndex: 0,
  lines: [],
  notes: [],
  bpm: 120,
  displayBpm: 120,
  rootPitchClass: 0,
  scaleMode: 'major',
  firstLyricTime: 0,        // First note timestamp in the chart (using original .txt GAP)
  studioFirstLyricTime: null, // First lyric line timestamp from LRCLIB studio track
  calculatedStudioOffset: null, // Line-by-line median offset between UltraStar and Studio lyrics
  chartMinMidi: 53,
  chartMaxMidi: 77,

  // YouTube Player State
  ytPlayer: null,
  ytReady: false,
  ytVideoList: [],          // [{ videoId, title, isOriginalGap }]
  ytCurrentIndex: 0,
  ytLastReportedTime: 0,
  ytLastReportedTs: 0,
  videoOffsetSec: 0,        // songTime = rawPlayerTime - videoOffsetSec
  videoStartGapSec: 0,

  // Spotify Premium Web Playback SDK State
  spotifyClientId: localStorage.getItem('sing_spotify_client_id') || '',
  spotifyAccessToken: localStorage.getItem('sing_spotify_access_token') || '',
  spotifyRefreshToken: localStorage.getItem('sing_spotify_refresh_token') || '',
  spotifyTokenExpiry: parseInt(localStorage.getItem('sing_spotify_token_expiry') || '0', 10),
  spotifyPlayer: null,
  spotifyDeviceId: null,
  spotifyReady: false,
  spotifyTracks: [],
  spotifyDurationSec: 0,
  spotifyPositionMs: 0,
  spotifyLastUpdateTs: 0,
  spotifyIsPlaying: false,

  // USDB State (usdb.animux.de)
  usdbConnected: false,
  usdbUsername: '',

  // General Playback
  isPlaying: false,
  simulatedTime: 0,
  lastFrameTs: performance.now(),

  // Scoring
  score: 0,
  combo: 1,
  streakHits: 0,
  totalFramesChecked: 0,
  hitFramesCount: 0,
  particles: [],

  // Phase 6 In-Browser Generator & Library State
  resolvedTrack: null,
  activeJobId: null,
  activeJobSse: null,
  activeJobPollTimer: null,
  librarySongs: [],
  localAudio: null,
  generationOptions: {
    pitchEngine: 'fcpe',
    separator: 'demucs',
    quality: 'balanced',
    forceWhisper: false,
    allowWhisperFallback: false,
    uploadedAudioPath: null,
  },

  // Microphone & Stabilized Pitch Detection
  audioCtx: null,
  analyser: null,
  micStream: null,
  micBuffer: null,
  micActive: false,
  selectedDeviceId: '',
  echoCancellation: false,
  latencyMs: 80,
  noiseGatePercent: 5,
  difficultyTolerance: 1.5,
  pitchMagnet: true,
  octaveAgnostic: true,

  // Pitch Stabilization Buffers
  currentHz: 0,
  currentMidi: null,
  smoothedMidi: null,
  lastDisplayedMidi: null,
  recentRawMidis: [],
  voicedFrameCount: 0,
  silentFrameCount: 10,
  currentStrokeId: 0,
  currentClarity: 0,
  currentVolume: 0,
  pitchHistory: [],

  // Speech Recognition
  recognition: null,
  lastRecognizedText: '',
};

/* ============================================================================
 * 1. INITIALIZATION, OAUTH CALLBACK & UI EVENTS
 * ============================================================================ */
window.addEventListener('DOMContentLoaded', async () => {
  updateRedirectUriLabel();
  bindUIEvents();
  initSpeechRecognition();
  requestAnimationFrame(mainRenderLoop);

  // Check if returning from Spotify OAuth PKCE redirect (?code=...)
  await handleSpotifyOAuthRedirectCallback();

  // Initialize Spotify Player if we have a valid token
  if (state.spotifyAccessToken) {
    initSpotifyWebPlayer();
  }

  // Check USDB Connection
  await checkUsdbStatus();

  // Phase 6: Load Generated KI-Songs Library and Settings
  await loadLibrarySongs();
  await loadLyricsSettings();

  await loadUltraStarCatalog();
  performSongSearch("Queen Don't Stop Me Now");
});

window.onYouTubeIframeAPIReady = function () {
  state.ytReady = true;
};

window.onSpotifyWebPlaybackSDKReady = function () {
  if (state.spotifyAccessToken) {
    initSpotifyWebPlayer();
  }
};

function updateRedirectUriLabel() {
  // Spotify recommends 127.0.0.1 over localhost for local loopback redirect URIs
  const port = window.location.port ? `:${window.location.port}` : '';
  const preferredOrigin = `http://127.0.0.1${port}/`;
  const lbl = document.getElementById('lblRedirectUri');
  if (lbl) lbl.textContent = preferredOrigin;

  const clientInput = document.getElementById('inputSpotifyClientId');
  if (clientInput && state.spotifyClientId) {
    clientInput.value = state.spotifyClientId;
  }
}

async function loadUltraStarCatalog() {
  const subEl = document.getElementById('catalogStatusSub');
  const mapById = new Map();

  try {
    const localRes = await fetch('/ultrastar_index.json');
    if (localRes.ok) {
      const localData = await localRes.json();
      for (const s of localData) {
        if (s && s.id) mapById.set(s.id, s);
      }
      state.ultraStarCatalog = Array.from(mapById.values());
      subEl.textContent = `${state.ultraStarCatalog.length} SingStar/UltraStar-Songs bereit`;
    }
  } catch (_) {}

  try {
    const remoteRes = await fetch(`${ALLKARAOKE_BASE}/index.json`);
    if (remoteRes.ok) {
      const remoteData = await remoteRes.json();
      if (Array.isArray(remoteData)) {
        for (const s of remoteData) {
          if (s && s.id) {
            mapById.set(s.id, {
              id: s.id,
              title: s.title,
              artist: s.artist,
              video: s.video,
              bpm: s.bpm,
              realBpm: s.realBpm || 0,
              gap: s.gap,
              videoGap: s.videoGap || 0,
              duration: s.duration || 0,
              language: s.language || [],
              year: s.year || '',
            });
          }
        }
        state.ultraStarCatalog = Array.from(mapById.values());
        state.catalogLoaded = true;
        subEl.textContent = `★ ${state.ultraStarCatalog.length} Original SingStar/UltraStar-Songs geladen`;
      }
    }
  } catch (_) {}
}

function bindUIEvents() {
  // Search Form
  const searchForm = document.getElementById('searchForm');
  const searchInput = document.getElementById('searchInput');
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) performSongSearch(q);
  });

  // Quick Preset Tags
  document.querySelectorAll('.tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.getAttribute('data-query');
      searchInput.value = q;
      performSongSearch(q);
    });
  });

  // Mode Switcher: YouTube vs. Spotify Premium
  document.getElementById('btnModeYoutube').addEventListener('click', () => {
    switchPlaybackSource('youtube');
  });

  document.getElementById('btnModeSpotify').addEventListener('click', () => {
    if (!state.spotifyReady) {
      document.getElementById('modalSpotify').classList.remove('hidden');
    } else {
      switchPlaybackSource('spotify');
    }
  });

  // Spotify Modal Controls
  const modalSpotify = document.getElementById('modalSpotify');
  document.getElementById('btnCloseSpotifyModal').addEventListener('click', () => modalSpotify.classList.add('hidden'));
  document.getElementById('btnCloseSpotifyFooter').addEventListener('click', () => modalSpotify.classList.add('hidden'));

  // USDB Modal Controls (usdb.animux.de)
  const modalUsdb = document.getElementById('modalUsdb');
  const btnOpenUsdb = document.getElementById('btnOpenUsdbModal');
  const btnCloseUsdb = document.getElementById('btnCloseUsdbModal');
  const formUsdb = document.getElementById('formUsdbLogin');
  const btnUsdbLogout = document.getElementById('btnUsdbLogout');

  if (btnOpenUsdb) {
    btnOpenUsdb.addEventListener('click', (ev) => {
      ev.preventDefault();
      modalUsdb.classList.remove('hidden');
      updateUsdbUI();
    });
  }

  if (btnCloseUsdb) {
    btnCloseUsdb.addEventListener('click', () => modalUsdb.classList.add('hidden'));
  }

  if (modalUsdb) {
    modalUsdb.addEventListener('click', (ev) => {
      if (ev.target === modalUsdb) {
        modalUsdb.classList.add('hidden');
      }
    });
  }

  if (formUsdb) {
    formUsdb.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = document.getElementById('usdbUsername').value.trim();
      const pass = document.getElementById('usdbPassword').value.trim();
      const btn = document.getElementById('btnSubmitUsdbLogin');
      const errEl = document.getElementById('usdbLoginError');
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Verbinde mit usdb.animux.de...';

      try {
        const res = await fetch('/api/usdb/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          state.usdbConnected = true;
          state.usdbUsername = data.username;
          updateUsdbUI();
          setTimeout(() => modalUsdb.classList.add('hidden'), 600);
          const currentQ = document.getElementById('searchInput').value.trim();
          if (currentQ) performSongSearch(currentQ);
        } else {
          errEl.textContent = data.error || 'USDB Login fehlgeschlagen';
          errEl.classList.remove('hidden');
        }
      } catch (err) {
        errEl.textContent = 'Netzwerkfehler: ' + err.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Einloggen & 28.000 Songs freischalten';
      }
    });
  }

  if (btnUsdbLogout) {
    btnUsdbLogout.addEventListener('click', async () => {
      await fetch('/api/usdb/logout', { method: 'POST' }).catch(() => {});
      state.usdbConnected = false;
      state.usdbUsername = '';
      updateUsdbUI();
    });
  }

  document.getElementById('btnCopyRedirectUri').addEventListener('click', () => {
    const uri = document.getElementById('lblRedirectUri').textContent;
    navigator.clipboard.writeText(uri).catch(() => {});
    document.getElementById('btnCopyRedirectUri').textContent = '✓ Kopiert!';
    setTimeout(() => {
      document.getElementById('btnCopyRedirectUri').textContent = '📋 Kopieren';
    }, 1800);
  });

  document.getElementById('btnSpotifyOAuthLogin').addEventListener('click', startSpotifyPKCELogin);
  document.getElementById('btnApplySpotifyToken').addEventListener('click', () => {
    const token = document.getElementById('inputSpotifyDirectToken').value.trim();
    if (token) {
      saveSpotifyTokens(token, '', 3600);
      initSpotifyWebPlayer();
    }
  });
  document.getElementById('btnSpotifyLogout').addEventListener('click', disconnectSpotify);

  // Spotify Deck Controls
  document.getElementById('selectSpotifyTrack').addEventListener('change', (e) => {
    const uri = e.target.value;
    const found = state.spotifyTracks.find((t) => t.uri === uri);
    if (found) playSpotifyTrack(found);
  });

  document.getElementById('sliderSpotifyVol').addEventListener('input', (e) => {
    const vol = parseInt(e.target.value, 10) / 100;
    if (state.spotifyPlayer) {
      state.spotifyPlayer.setVolume(vol).catch(() => {});
    }
  });

  document.getElementById('spotifySeekSlider').addEventListener('change', (e) => {
    if (state.spotifyPlayer && state.spotifyDurationSec > 0) {
      const targetMs = Math.round((parseInt(e.target.value, 10) / 1000) * state.spotifyDurationSec * 1000);
      state.spotifyPlayer.seek(targetMs).catch(() => {});
      state.spotifyPositionMs = targetMs;
      state.spotifyLastUpdateTs = performance.now();
    }
  });

  // Custom .txt UltraStar File Upload
  document.getElementById('inputTxtFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await startCustomTxtSession(text, file.name);
    e.target.value = '';
  });

  // Navigation
  document.getElementById('btnBackHome').addEventListener('click', leaveStageToLobby);
  document.getElementById('btnLeaveStage').addEventListener('click', leaveStageToLobby);

  // Duet Track Selector
  document.getElementById('selectDuetTrack').addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10) || 0;
    activateDuetTrack(idx);
  });

  // Mic Toggle
  document.getElementById('btnToggleMic').addEventListener('click', async () => {
    if (!state.micActive) {
      await startMicrophone(state.selectedDeviceId);
    } else {
      stopMicrophone();
    }
  });

  // Settings Modal
  const modalSettings = document.getElementById('modalSettings');
  document.getElementById('btnOpenSettings').addEventListener('click', async () => {
    modalSettings.classList.remove('hidden');
    if (!state.micActive) {
      await startMicrophone(state.selectedDeviceId);
    }
    await populateAudioDevices();
  });
  document.getElementById('btnCloseSettings').addEventListener('click', () => modalSettings.classList.add('hidden'));
  document.getElementById('btnSaveSettings').addEventListener('click', () => modalSettings.classList.add('hidden'));

  document.getElementById('selectAudioInput').addEventListener('change', async (e) => {
    state.selectedDeviceId = e.target.value;
    await startMicrophone(state.selectedDeviceId);
  });

  document.getElementById('chkEchoCancel').addEventListener('change', async (e) => {
    state.echoCancellation = e.target.checked;
    if (state.micActive) {
      await startMicrophone(state.selectedDeviceId);
    }
  });

  document.getElementById('sliderLatency').addEventListener('input', (e) => {
    setLatencyMs(parseInt(e.target.value, 10));
  });

  document.getElementById('sliderGate').addEventListener('input', (e) => {
    state.noiseGatePercent = parseInt(e.target.value, 10);
    document.getElementById('lblGateVal').textContent = state.noiseGatePercent;
  });

  document.getElementById('btnRunCalibration').addEventListener('click', runInteractiveLatencyCalibration);

  // Phase 6 In-Browser Generator & Resolver UI Events
  const formResolve = document.getElementById('formResolve');
  if (formResolve) {
    formResolve.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = document.getElementById('inputResolve').value.trim();
      if (val) await handleResolveQuery(val);
    });
  }

  const inputAudioUpload = document.getElementById('inputAudioUpload');
  if (inputAudioUpload) {
    inputAudioUpload.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await handleAudioUpload(file);
      e.target.value = '';
    });
  }

  const btnDismissPreview = document.getElementById('btnDismissPreview');
  if (btnDismissPreview) {
    btnDismissPreview.addEventListener('click', () => {
      document.getElementById('resolvePreviewCard').classList.add('hidden');
      state.resolvedTrack = null;
    });
  }

  const btnStartGeneration = document.getElementById('btnStartGeneration');
  if (btnStartGeneration) {
    btnStartGeneration.addEventListener('click', () => startGenerationJob());
  }

  const btnCancelGeneration = document.getElementById('btnCancelGeneration');
  if (btnCancelGeneration) {
    btnCancelGeneration.addEventListener('click', () => cancelActiveGenerationJob());
  }

  const btnWhisperFallback = document.getElementById('btnWhisperFallback');
  if (btnWhisperFallback) {
    btnWhisperFallback.addEventListener('click', () => {
      startGenerationJob({ forceWhisper: true, allowWhisperFallback: true });
    });
  }

  const btnPlayGeneratedSong = document.getElementById('btnPlayGeneratedSong');
  if (btnPlayGeneratedSong) {
    btnPlayGeneratedSong.addEventListener('click', () => {
      if (state.lastGeneratedSong) {
        playLibrarySong(state.lastGeneratedSong);
      }
    });
  }

  const btnRefreshLibrary = document.getElementById('btnRefreshLibrary');
  if (btnRefreshLibrary) {
    btnRefreshLibrary.addEventListener('click', () => loadLibrarySongs());
  }

  // Phase 6 Settings: Keys & System Health
  const btnSaveSpicy = document.getElementById('btnSaveSettingSpicyKey');
  if (btnSaveSpicy) {
    btnSaveSpicy.addEventListener('click', saveSpicyKey);
  }

  const btnSaveSpDc = document.getElementById('btnSaveSettingSpDc');
  if (btnSaveSpDc) {
    btnSaveSpDc.addEventListener('click', saveSpDc);
  }

  const btnCheckHealth = document.getElementById('btnCheckHealth');
  if (btnCheckHealth) {
    btnCheckHealth.addEventListener('click', checkSystemHealthStatus);
  }

  // Stage Controls
  document.getElementById('btnPlayPause').addEventListener('click', togglePlayPause);
  document.getElementById('btnRestartSong').addEventListener('click', restartSong);
  document.getElementById('btnSkipToVocals').addEventListener('click', skipToFirstVocals);

  document.getElementById('selectDifficulty').addEventListener('change', (e) => {
    state.difficultyTolerance = parseFloat(e.target.value);
  });

  document.getElementById('chkPitchMagnet').addEventListener('change', (e) => {
    state.pitchMagnet = e.target.checked;
  });

  document.getElementById('chkOctaveAgnostic').addEventListener('change', (e) => {
    state.octaveAgnostic = e.target.checked;
  });

  // Sync Preset & Fine-Tuning Buttons
  document.getElementById('btnUseStudioSync').addEventListener('click', () => {
    applyStudioSyncOffset();
  });

  document.getElementById('btnUseOriginalGap').addEventListener('click', () => {
    setVideoOffset(0);
    document.getElementById('btnUseOriginalGap').classList.add('active-sync-mode');
    document.getElementById('btnUseStudioSync').classList.remove('active-sync-mode');
  });

  document.querySelectorAll('[data-offset-delta]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = parseFloat(btn.getAttribute('data-offset-delta'));
      setVideoOffset(state.videoOffsetSec + delta);
    });
  });

  document.getElementById('btnSnapFirstLyric').addEventListener('click', () => {
    const rawTime = getRawPlayerTime();
    const newOffset = rawTime - state.firstLyricTime;
    setVideoOffset(newOffset);
  });

  // YouTube Switcher
  document.getElementById('selectYtVideo').addEventListener('change', (e) => {
    const videoId = e.target.value;
    const idx = state.ytVideoList.findIndex((v) => v.videoId === videoId);
    if (idx !== -1) {
      state.ytCurrentIndex = idx;
      const chosen = state.ytVideoList[idx];
      if (chosen.isOriginalGap) {
        setVideoOffset(0);
      } else {
        applyStudioSyncOffset();
      }
    }
    if (videoId) loadYouTubeVideoById(videoId);
  });

  document.getElementById('btnApplyCustomYt').addEventListener('click', () => {
    const raw = document.getElementById('inputCustomYt').value.trim();
    const id = extractYouTubeId(raw);
    if (id) loadYouTubeVideoById(id);
  });
}

function setLatencyMs(ms) {
  state.latencyMs = Math.max(-100, Math.min(450, ms));
  document.getElementById('sliderLatency').value = state.latencyMs;
  document.getElementById('lblLatencyMs').textContent = state.latencyMs;
  document.getElementById('topLatencyVal').textContent = state.latencyMs;
}

function setVideoOffset(sec) {
  state.videoOffsetSec = Math.round(sec * 100) / 100;
  const sign = state.videoOffsetSec > 0 ? '+' : '';
  document.getElementById('lblVideoOffset').textContent = `${sign}${state.videoOffsetSec.toFixed(2)}s`;
}

/**
 * Intelligent lyric-alignment engine that aligns UltraStar syllable lines with Studio LRCLIB synced lyrics.
 * Uses text similarity matching and calculates the robust median offset across all matching lines.
 */
function calculateUltraStarStudioOffset(ultraLines, lrcText) {
  if (!lrcText || !ultraLines || ultraLines.length === 0) return null;

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

  if (lrcItems.length === 0) return null;

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

/**
 * Aligns the UltraStar chart's timing with the official studio track (from LRCLIB or Spotify)
 */
function applyStudioSyncOffset() {
  if (state.calculatedStudioOffset !== null && state.calculatedStudioOffset !== undefined) {
    setVideoOffset(state.calculatedStudioOffset);
    document.getElementById('btnUseStudioSync').classList.add('active-sync-mode');
    document.getElementById('btnUseOriginalGap').classList.remove('active-sync-mode');
    const sign = state.calculatedStudioOffset > 0 ? '+' : '';
    document.getElementById('badgeSyncInfo').textContent = `🎧 Studio-Sync aktiv (${sign}${state.calculatedStudioOffset.toFixed(2)}s)`;
    return;
  }

  if (state.studioFirstLyricTime !== null && state.firstLyricTime > 0) {
    const studioOffset = state.studioFirstLyricTime - state.firstLyricTime;
    setVideoOffset(studioOffset);
    document.getElementById('btnUseStudioSync').classList.add('active-sync-mode');
    document.getElementById('btnUseOriginalGap').classList.remove('active-sync-mode');
    const sign = studioOffset > 0 ? '+' : '';
    document.getElementById('badgeSyncInfo').textContent = `🎧 Studio-Start Sync (${sign}${studioOffset.toFixed(2)}s)`;
    return;
  }

  // Duration-based fallback if video has extended intro compared to studio track
  if (state.currentSong && state.currentSong.duration && state.ytVideoList.length > 0) {
    const currentVid = state.ytVideoList[state.ytCurrentIndex];
    if (currentVid && typeof currentVid.durationDiffSec === 'number' && Math.abs(currentVid.durationDiffSec) > 3) {
      const approxOffset = -currentVid.durationDiffSec;
      setVideoOffset(approxOffset);
      document.getElementById('btnUseStudioSync').classList.add('active-sync-mode');
      document.getElementById('btnUseOriginalGap').classList.remove('active-sync-mode');
      const sign = approxOffset > 0 ? '+' : '';
      document.getElementById('badgeSyncInfo').textContent = `🎧 Intro-Diff Sync (${sign}${approxOffset.toFixed(1)}s)`;
      return;
    }
  }

  setVideoOffset(0);
}

/* ============================================================================
 * 2. SPOTIFY PREMIUM OAUTH 2.0 PKCE & WEB PLAYBACK SDK
 * ============================================================================ */
function switchPlaybackSource(mode) {
  if (mode === 'spotify' && !state.spotifyReady) {
    document.getElementById('modalSpotify').classList.remove('hidden');
    return;
  }

  state.playbackSource = mode;
  document.getElementById('btnModeYoutube').classList.toggle('active', mode === 'youtube');
  document.getElementById('btnModeSpotify').classList.toggle('active', mode === 'spotify');

  document.getElementById('deckYoutube').classList.toggle('hidden', mode !== 'youtube');
  document.getElementById('deckSpotify').classList.toggle('hidden', mode !== 'spotify');

  if (mode === 'spotify') {
    // Pause YouTube if playing
    if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
      try {
        state.ytPlayer.pauseVideo();
      } catch (_) {}
    }
    // If a song is currently active on stage, load & play it on Spotify and apply Studio Sync!
    if (state.currentSong && document.getElementById('viewStage').classList.contains('active')) {
      applyStudioSyncOffset();
      findAndPlaySpotifySong(state.currentSong);
    }
  } else {
    // Pause Spotify if playing
    if (state.spotifyPlayer) {
      state.spotifyPlayer.pause().catch(() => {});
    }
    if (state.currentSong && document.getElementById('viewStage').classList.contains('active')) {
      findAndLoadYouTubeVideo(state.currentSong);
    }
  }
}

async function startSpotifyPKCELogin() {
  const clientId = document.getElementById('inputSpotifyClientId').value.trim();
  if (!clientId) {
    alert('Bitte gib deine Spotify Client ID aus dem Spotify Developer Dashboard ein!');
    return;
  }

  // If user is currently on localhost, redirect to 127.0.0.1 first so Redirect URI matches 127.0.0.1
  if (window.location.hostname === 'localhost') {
    const port = window.location.port ? `:${window.location.port}` : '';
    window.location.href = `http://127.0.0.1${port}/?spotify_setup_client_id=${encodeURIComponent(clientId)}`;
    return;
  }

  localStorage.setItem('sing_spotify_client_id', clientId);
  state.spotifyClientId = clientId;

  const verifier = generateRandomString(64);
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem('sing_spotify_pkce_verifier', verifier);

  const port = window.location.port ? `:${window.location.port}` : '';
  const redirectUri = `http://127.0.0.1${port}/`;
  const scopes = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';

  const authUrl =
    `https://accounts.spotify.com/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge_method=S256` +
    `&code_challenge=${encodeURIComponent(challenge)}`;

  window.location.href = authUrl;
}

async function handleSpotifyOAuthRedirectCallback() {
  const params = new URLSearchParams(window.location.search);

  // Helper redirect from localhost -> 127.0.0.1
  const setupClientId = params.get('spotify_setup_client_id');
  if (setupClientId) {
    localStorage.setItem('sing_spotify_client_id', setupClientId);
    state.spotifyClientId = setupClientId;
    document.getElementById('inputSpotifyClientId').value = setupClientId;
    window.history.replaceState({}, document.title, '/');
    await startSpotifyPKCELogin();
    return;
  }

  const code = params.get('code');
  if (!code) return;

  window.history.replaceState({}, document.title, '/');
  const clientId = localStorage.getItem('sing_spotify_client_id');
  const verifier = localStorage.getItem('sing_spotify_pkce_verifier');
  const port = window.location.port ? `:${window.location.port}` : '';
  const redirectUri = `http://127.0.0.1${port}/`;

  if (!clientId || !verifier) return;

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      saveSpotifyTokens(data.access_token, data.refresh_token || '', data.expires_in || 3600);
      initSpotifyWebPlayer();
    } else {
      const errText = await res.text();
      console.error('Spotify token exchange failed:', errText);
      alert('Spotify Login fehlgeschlagen. Prüfe Client ID und Redirect URI (http://127.0.0.1:3000/).');
    }
  } catch (err) {
    console.error('Spotify OAuth error:', err);
  }
}

function saveSpotifyTokens(accessToken, refreshToken, expiresInSec) {
  state.spotifyAccessToken = accessToken;
  if (refreshToken) state.spotifyRefreshToken = refreshToken;
  state.spotifyTokenExpiry = Date.now() + expiresInSec * 1000;

  localStorage.setItem('sing_spotify_access_token', accessToken);
  if (refreshToken) localStorage.setItem('sing_spotify_refresh_token', refreshToken);
  localStorage.setItem('sing_spotify_token_expiry', String(state.spotifyTokenExpiry));
}

/* ============================================================================
 * USDB INTEGRATION HELPERS (usdb.animux.de)
 * ============================================================================ */
function updateUsdbUI() {
  const badge = document.getElementById('usdbTopBadge');
  const statusBox = document.getElementById('usdbStatusArea');
  const loginForm = document.getElementById('formUsdbLogin');
  const userText = document.getElementById('usdbLoggedUserText');

  if (state.usdbConnected) {
    if (badge) {
      badge.textContent = 'Aktiv';
      badge.classList.add('connected');
    }
    if (statusBox) statusBox.classList.remove('hidden');
    if (loginForm) loginForm.classList.add('hidden');
    if (userText) userText.innerHTML = `Eingeloggt als: <strong>${escapeHtml(state.usdbUsername)}</strong>`;
  } else {
    if (badge) {
      badge.textContent = 'Verbinden';
      badge.classList.remove('connected');
    }
    if (statusBox) statusBox.classList.add('hidden');
    if (loginForm) loginForm.classList.remove('hidden');
  }
}

async function checkUsdbStatus() {
  try {
    const res = await fetch('/api/usdb/status');
    if (res.ok) {
      const data = await res.json();
      state.usdbConnected = !!data.loggedIn;
      state.usdbUsername = data.username || '';
      updateUsdbUI();
    }
  } catch (_) {}
}

function disconnectSpotify() {
  if (state.spotifyPlayer) {
    state.spotifyPlayer.disconnect();
    state.spotifyPlayer = null;
  }
  state.spotifyReady = false;
  state.spotifyDeviceId = null;
  state.spotifyAccessToken = '';
  localStorage.removeItem('sing_spotify_access_token');
  localStorage.removeItem('sing_spotify_refresh_token');

  document.getElementById('spotifyTopBadge').textContent = 'Verbinden';
  document.getElementById('spotifyModalStatus').textContent = 'Status: Getrennt';
  document.getElementById('btnSpotifyLogout').classList.add('hidden');
  switchPlaybackSource('youtube');
}

function initSpotifyWebPlayer() {
  if (!window.Spotify || !window.Spotify.Player || !state.spotifyAccessToken) {
    return;
  }
  if (state.spotifyPlayer) return;

  const statusBox = document.getElementById('spotifyModalStatus');
  statusBox.textContent = 'Verbinde mit Spotify Premium Web Playback SDK...';

  const player = new window.Spotify.Player({
    name: '🎤 SING! Party Studio Player',
    getOAuthToken: (cb) => {
      cb(state.spotifyAccessToken);
    },
    volume: 0.85,
  });

  player.addListener('ready', ({ device_id }) => {
    state.spotifyDeviceId = device_id;
    state.spotifyReady = true;
    document.getElementById('spotifyTopBadge').textContent = '✓ Bereit';
    document.getElementById('btnSpotifyLogout').classList.remove('hidden');
    statusBox.textContent = '✓ Verbunden! Dein Browser ist jetzt ein Spotify-Player.';
    document.getElementById('modalSpotify').classList.add('hidden');
    switchPlaybackSource('spotify');
  });

  player.addListener('not_ready', () => {
    state.spotifyReady = false;
    document.getElementById('spotifyTopBadge').textContent = 'Offline';
  });

  player.addListener('authentication_error', ({ message }) => {
    console.warn('Spotify auth error:', message);
    statusBox.textContent = `Token abgelaufen oder ungültig (${message}). Bitte neu verbinden.`;
    state.spotifyReady = false;
  });

  player.addListener('account_error', () => {
    statusBox.textContent = 'Fehler: Für das Web Playback SDK wird ein Spotify Premium Account benötigt.';
  });

  player.addListener('player_state_changed', (st) => {
    if (!st) return;
    state.spotifyIsPlaying = !st.paused;
    state.isPlaying = !st.paused;
    state.spotifyPositionMs = st.position || 0;
    state.spotifyDurationSec = (st.duration || 0) / 1000;
    state.spotifyLastUpdateTs = performance.now();
  });

  player.connect();
  state.spotifyPlayer = player;
}

async function findAndPlaySpotifySong(song) {
  if (!state.spotifyReady || !state.spotifyAccessToken || !state.spotifyDeviceId) {
    return;
  }

  const query = `${song.artistName} ${song.trackName}`;
  document.getElementById('spotifyTrackTitle').textContent = 'Suche auf Spotify...';

  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?type=track&limit=6&q=${encodeURIComponent(query)}`,
      {
        headers: { Authorization: `Bearer ${state.spotifyAccessToken}` },
      }
    );

    if (!res.ok) throw new Error(`Spotify search status ${res.status}`);
    const data = await res.json();
    const items = data?.tracks?.items || [];
    state.spotifyTracks = items;

    const selectEl = document.getElementById('selectSpotifyTrack');
    selectEl.innerHTML = '';

    if (items.length === 0) {
      document.getElementById('spotifyTrackTitle').textContent = 'Track nicht auf Spotify gefunden';
      return;
    }

    items.forEach((tr, idx) => {
      const opt = document.createElement('option');
      opt.value = tr.uri;
      const durS = Math.round((tr.duration_ms || 0) / 1000);
      const min = Math.floor(durS / 60);
      const sec = String(durS % 60).padStart(2, '0');
      const artists = (tr.artists || []).map((a) => a.name).join(', ');
      opt.textContent = `${artists} – ${tr.name} (${min}:${sec})`;
      if (idx === 0) opt.selected = true;
      selectEl.appendChild(opt);
    });

    await playSpotifyTrack(items[0]);
  } catch (err) {
    console.error('Spotify track search failed:', err);
  }
}

async function playSpotifyTrack(track) {
  if (!state.spotifyDeviceId || !state.spotifyAccessToken) return;

  const artists = (track.artists || []).map((a) => a.name).join(', ');
  const cover = track.album?.images?.[0]?.url || state.currentSong?.artworkUrl || '';
  document.getElementById('spotifyDeckCover').src = cover;
  document.getElementById('spotifyTrackTitle').textContent = track.name;
  document.getElementById('spotifyTrackArtist').textContent = artists;

  state.spotifyDurationSec = (track.duration_ms || 0) / 1000;
  document.getElementById('spotifyTimeDur').textContent = formatSec(state.spotifyDurationSec);

  // Align chart to studio start time automatically!
  applyStudioSyncOffset();

  try {
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(state.spotifyDeviceId)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${state.spotifyAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uris: [track.uri],
        position_ms: 0,
      }),
    });
    state.spotifyPositionMs = 0;
    state.spotifyLastUpdateTs = performance.now();
    state.spotifyIsPlaying = true;
    state.isPlaying = true;
  } catch (err) {
    console.error('Spotify play error:', err);
  }
}

/* ============================================================================
 * 3. HYBRID SEARCH: ULTRASTAR STUDIO CATALOG + LRCLIB/ITUNES
 * ============================================================================ */
function searchUltraStarLocal(query) {
  const norm = (str) =>
    String(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim();

  const qNorm = norm(query);
  const tokens = qNorm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored = [];
  for (const item of state.ultraStarCatalog) {
    const hay = norm(`${item.artist} ${item.title}`);
    let score = 0;
    let matchedTokens = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) {
        matchedTokens++;
        score += tok.length >= 4 ? 25 : 12;
      }
    }
    if (matchedTokens === tokens.length) score += 60;
    if (hay === qNorm) score += 100;

    if (matchedTokens > 0 && (matchedTokens === tokens.length || matchedTokens >= 2)) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 18).map((s) => s.item);
}

async function performSongSearch(query) {
  const loadingEl = document.getElementById('searchLoading');
  const resultsSec = document.getElementById('searchResultsSection');
  const grid = document.getElementById('resultsGrid');

  loadingEl.classList.remove('hidden');
  resultsSec.classList.add('hidden');
  grid.innerHTML = '';

  try {
    const ultraMatches = searchUltraStarLocal(query);

    const [itunesRes, lrcRes, usdbRes] = await Promise.allSettled([
      fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=15`).then((r) => r.json()),
      fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json()),
      state.usdbConnected
        ? fetch(`/api/usdb/search?q=${encodeURIComponent(query)}`).then((r) => r.json())
        : Promise.resolve({ results: [] }),
    ]);

    const itunesList =
      itunesRes.status === 'fulfilled' && Array.isArray(itunesRes.value?.results)
        ? itunesRes.value.results
        : [];
    const lrcList =
      lrcRes.status === 'fulfilled' && Array.isArray(lrcRes.value)
        ? lrcRes.value.filter((t) => t.syncedLyrics && t.syncedLyrics.trim().length > 0)
        : [];
    const usdbList =
      usdbRes.status === 'fulfilled' && Array.isArray(usdbRes.value?.results)
        ? usdbRes.value.results
        : [];

    const combinedCards = [];
    const seenKeys = new Set();

    // A1) Add 100% Original UltraStar Studio Tracks from Local 6.682 Database
    for (const u of ultraMatches) {
      const key = `${u.artist.toLowerCase().slice(0, 6)}-${u.title.toLowerCase().slice(0, 6)}`;
      seenKeys.add(key);

      const matchedItunes = itunesList.find(
        (it) =>
          (it.artistName || '').toLowerCase().includes(u.artist.toLowerCase().slice(0, 4)) &&
          (it.trackName || '').toLowerCase().includes(u.title.toLowerCase().slice(0, 4))
      );

      const matchedLrc = lrcList.find(
        (lr) =>
          (lr.artistName || '').toLowerCase().includes(u.artist.toLowerCase().slice(0, 4)) &&
          (lr.trackName || '').toLowerCase().includes(u.title.toLowerCase().slice(0, 4))
      );

      const artwork = matchedItunes?.artworkUrl100
        ? matchedItunes.artworkUrl100.replace('100x100bb', '400x400bb')
        : `https://i.ytimg.com/vi/${u.video}/hqdefault.jpg`;

      combinedCards.push({
        isUltraStar: true,
        ultraStarId: u.id,
        trackName: u.title,
        artistName: u.artist,
        videoId: u.video,
        bpm: u.bpm,
        realBpm: u.realBpm,
        gap: u.gap,
        videoGap: u.videoGap || 0,
        duration: u.duration || Math.round((matchedItunes?.trackTimeMillis || 210000) / 1000),
        syncedLyrics: matchedLrc?.syncedLyrics || null,
        artworkUrl: artwork,
        previewUrl: matchedItunes?.previewUrl || null,
      });
    }

    // A2) Add USDB 28.000 Community Songs (Direct Live Access)
    for (const u of usdbList) {
      const key = `${(u.artistName || '').toLowerCase().slice(0, 6)}-${(u.trackName || '').toLowerCase().slice(0, 6)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const matchedItunes = itunesList.find(
        (it) =>
          (it.artistName || '').toLowerCase().includes((u.artistName || '').toLowerCase().slice(0, 4)) &&
          (it.trackName || '').toLowerCase().includes((u.trackName || '').toLowerCase().slice(0, 4))
      );

      combinedCards.push({
        isUsdb: true,
        isUltraStar: true,
        usdbId: u.usdbId,
        trackName: u.trackName,
        artistName: u.artistName,
        artworkUrl: u.artworkUrl || matchedItunes?.artworkUrl100?.replace('100x100bb', '400x400bb') || null,
        language: u.language,
        duration: Math.round((matchedItunes?.trackTimeMillis || 210000) / 1000),
        previewUrl: matchedItunes?.previewUrl || null,
      });
    }

    // B) Add LRCLIB Universal Tracks
    for (const t of lrcList.slice(0, 12)) {
      const key = `${(t.artistName || '').toLowerCase().slice(0, 6)}-${(t.trackName || '').toLowerCase().slice(0, 6)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const matchedItunes =
        itunesList.find(
          (it) =>
            (it.artistName || '').toLowerCase().includes((t.artistName || '').toLowerCase().slice(0, 5)) &&
            (it.trackName || '').toLowerCase().includes((t.trackName || '').toLowerCase().slice(0, 5))
        ) || itunesList[0];

      combinedCards.push({
        isUltraStar: false,
        id: t.id,
        trackName: t.trackName,
        artistName: t.artistName,
        duration: Math.round(t.duration || (matchedItunes?.trackTimeMillis || 0) / 1000),
        syncedLyrics: t.syncedLyrics,
        artworkUrl: matchedItunes?.artworkUrl100 ? matchedItunes.artworkUrl100.replace('100x100bb', '400x400bb') : null,
        previewUrl: matchedItunes?.previewUrl || null,
      });
    }

    loadingEl.classList.add('hidden');
    resultsSec.classList.remove('hidden');

    if (combinedCards.length === 0) {
      document.getElementById('resultsHeading').textContent = `Keine Songs für "${query}" gefunden`;
      return;
    }

    document.getElementById('resultsHeading').textContent = `Gefundene Songs für "${query}" (${ultraMatches.length} Original SingStar-Melodien, ${combinedCards.length - ultraMatches.length} Auto-Sync)`;

    combinedCards.forEach((song) => {
      const card = document.createElement('div');
      card.className = 'song-card' + (song.isUltraStar ? ' ultrastar-card' : '');
      const durMin = Math.floor((song.duration || 0) / 60);
      const durSec = String((song.duration || 0) % 60).padStart(2, '0');
      const cover =
        song.artworkUrl ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(song.trackName)}&background=ff2a85&color=fff&size=200`;

      let sourceBadge = '';
      if (song.isUsdb) {
        sourceBadge = `<span class="mini-tag gold">★ USDB Original-Noten</span>`;
      } else if (song.isUltraStar) {
        sourceBadge = `<span class="mini-tag gold">★ Original Melodie &amp; Noten</span>`;
      } else {
        sourceBadge = `<span class="mini-tag">⚡ Rhythmus-Modus</span>`;
      }

      card.innerHTML = `
        <img class="song-cover" src="${cover}" alt="Cover" loading="lazy" />
        <div class="song-info">
          <div class="song-title">${escapeHtml(song.trackName)}</div>
          <div class="song-artist">${escapeHtml(song.artistName)}</div>
          <div class="song-meta-row">
            ${sourceBadge}
            <span class="mini-tag">⏱ ${durMin}:${durSec}</span>
          </div>
        </div>
      `;
      card.addEventListener('click', () => startSongSession(song));
      grid.appendChild(card);
    });
  } catch (err) {
    console.error('Search failed:', err);
    loadingEl.classList.add('hidden');
  }
}

/* ============================================================================
 * 4. ULTRASTAR .TXT PARSER & STUDIO START-TIME EXTRACTOR
 * ============================================================================ */
function extractFirstLrcTimestamp(lrcText) {
  if (!lrcText) return null;
  const lineRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\](.*)/;
  for (const raw of lrcText.split('\n')) {
    const m = raw.match(lineRegex);
    if (!m) continue;
    const text = m[3].replace(/<[^>]+>/g, '').trim();
    if (text.length > 0) {
      return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    }
  }
  return null;
}

async function startSongSession(song) {
  state.currentSong = song;
  resetScoreState();
  setVideoOffset(0);
  state.studioFirstLyricTime = extractFirstLrcTimestamp(song.syncedLyrics);

  document.getElementById('viewLobby').classList.remove('active');
  document.getElementById('viewStage').classList.add('active');

  const cover =
    song.artworkUrl ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(song.trackName)}&background=ff2a85&color=fff&size=200`;
  document.getElementById('stageCover').src = cover;
  document.getElementById('stageTitle').textContent = song.trackName;
  document.getElementById('stageArtist').textContent = song.artistName;

  if (!state.micActive) {
    startMicrophone(state.selectedDeviceId).catch(() => {});
  }

  // If we don't have studioFirstLyricTime yet for an UltraStar song, fetch it from LRCLIB in parallel
  if (state.studioFirstLyricTime === null) {
    fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(song.artistName + ' ' + song.trackName)}`)
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list) && list.length > 0) {
          const withSync = list.find((it) => it.syncedLyrics);
          if (withSync) {
            state.studioFirstLyricTime = extractFirstLrcTimestamp(withSync.syncedLyrics);
            if (state.playbackSource === 'spotify') {
              applyStudioSyncOffset();
            }
          }
        }
      })
      .catch(() => {});
  }

  // USDB Song Loading
  if (song.isUsdb && song.usdbId) {
    document.getElementById('badgeChartSource').textContent = '★ USDB Community Original-Noten';
    document.getElementById('badgeChartSource').className = 'badge badge-gold';
    document.getElementById('badgeSyncInfo').textContent = 'Lade USDB-Noten...';

    try {
      const res = await fetch(`/api/usdb/song?id=${song.usdbId}`);
      if (!res.ok) throw new Error('Could not fetch USDB song');
      const songData = await res.json();
      await applyParsedUltraStarChart(songData.txt, {
        ...song,
        videoId: songData.videoId || song.videoId,
      });
      return;
    } catch (err) {
      console.warn('USDB fetch error, falling back:', err);
    }
  }

  if (song.isUltraStar && song.ultraStarId) {
    document.getElementById('badgeChartSource').textContent = '★ Original SingStar/UltraStar Melodie';
    document.getElementById('badgeChartSource').className = 'badge badge-gold';
    document.getElementById('badgeSyncInfo').textContent = 'Lade Original-Noten...';

    try {
      const txtRes = await fetch(`${ALLKARAOKE_BASE}/${encodeURIComponent(song.ultraStarId)}.txt`);
      if (!txtRes.ok) throw new Error('Could not fetch UltraStar .txt');
      const txtContent = await txtRes.text();
      await applyParsedUltraStarChart(txtContent, song);
      return;
    } catch (err) {
      console.warn('UltraStar fetch error, falling back:', err);
    }
  }

  // Fallback for non-UltraStar songs
  document.getElementById('badgeChartSource').textContent = '⚡ Rhythmus-Modus (LRCLIB – Keine Original-Noten)';
  document.getElementById('badgeChartSource').className = 'badge';
  document.getElementById('selectDuetTrack').classList.add('hidden');

  const extractedMidis = await analyzeSongPreviewAudio(song);
  buildNoteChartFromLRC(song.syncedLyrics, song.duration, extractedMidis);

  document.getElementById('badgeBpm').textContent = `${state.displayBpm} BPM`;
  updateFirstLyricLabel();

  if (state.playbackSource === 'spotify' && state.spotifyReady) {
    await findAndPlaySpotifySong(song);
  } else {
    await findAndLoadYouTubeVideo(song);
  }
}

async function startCustomTxtSession(txtContent, filename) {
  resetScoreState();
  setVideoOffset(0);
  document.getElementById('viewLobby').classList.remove('active');
  document.getElementById('viewStage').classList.add('active');

  if (!state.micActive) {
    startMicrophone(state.selectedDeviceId).catch(() => {});
  }

  await applyParsedUltraStarChart(txtContent, {
    trackName: filename.replace(/\.txt$/i, ''),
    artistName: 'Custom UltraStar File',
  });
}

async function applyParsedUltraStarChart(txtContent, songMeta = {}) {
  const parsed = parseUltraStarTxt(txtContent);
  state.isUltraStarChart = true;
  state.bpm = parsed.bpm;
  state.displayBpm = parsed.realBpm || Math.round(parsed.bpm / 2);
  state.videoStartGapSec = parsed.videoGapSec || 0;
  state.duetTracks = parsed.tracks;

  const fullSongObj = {
    ...songMeta,
    trackName: parsed.title || songMeta.trackName || 'Song',
    artistName: parsed.artist || songMeta.artistName || '',
    videoId: parsed.videoId || songMeta.videoId || '',
    duration: parsed.duration || songMeta.duration || 210,
  };
  state.currentSong = fullSongObj;

  document.getElementById('stageTitle').textContent = fullSongObj.trackName;
  document.getElementById('stageArtist').textContent = fullSongObj.artistName;
  document.getElementById('badgeBpm').textContent = `${state.displayBpm} BPM`;

  const duetSelect = document.getElementById('selectDuetTrack');
  if (parsed.tracks.length > 1) {
    duetSelect.innerHTML = parsed.tracks
      .map((tr, i) => `<option value="${i}">🎤 ${escapeHtml(tr.name || `Stimme ${i + 1}`)}</option>`)
      .join('');
    duetSelect.classList.remove('hidden');
  } else {
    duetSelect.classList.add('hidden');
  }

  activateDuetTrack(0);

  // Calculate studio sync offset by comparing UltraStar lyric lines with synced studio lyrics
  state.calculatedStudioOffset = null;
  if (songMeta.syncedLyrics && parsed.tracks[0]?.lines?.length > 0) {
    state.calculatedStudioOffset = calculateUltraStarStudioOffset(parsed.tracks[0].lines, songMeta.syncedLyrics);
  }

  if (state.calculatedStudioOffset === null && parsed.tracks[0]?.lines?.length > 0) {
    fetch(`/api/search?q=${encodeURIComponent(fullSongObj.artistName + ' ' + fullSongObj.trackName)}`)
      .then((r) => r.json())
      .then((data) => {
        const match = (data.results || []).find((t) => t.syncedLyrics);
        if (match && match.syncedLyrics) {
          const off = calculateUltraStarStudioOffset(parsed.tracks[0].lines, match.syncedLyrics);
          if (off !== null) {
            state.calculatedStudioOffset = off;
            if (state.playbackSource === 'spotify') {
              applyStudioSyncOffset();
            }
          }
        }
      })
      .catch(() => {});
  }

  if (state.playbackSource === 'spotify' && state.spotifyReady) {
    applyStudioSyncOffset();
    await findAndPlaySpotifySong(fullSongObj);
  } else {
    await findAndLoadYouTubeVideo(fullSongObj, parsed.videoId || songMeta.videoId);
  }
}

function activateDuetTrack(trackIdx) {
  const track = state.duetTracks[trackIdx] || state.duetTracks[0];
  if (!track) return;
  state.activeTrackIndex = trackIdx;
  state.lines = track.lines;
  state.notes = track.notes;
  state.firstLyricTime = state.notes.length > 0 ? state.notes[0].startTime : 0;
  computeDynamicCanvasPitchRange();
  updateFirstLyricLabel();
  resetScoreState();
}

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
  let p1Name = 'Stimme 1 (Lead)';
  let p2Name = 'Stimme 2 (Duett)';

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
      else if (key === 'P1') p1Name = val || p1Name;
      else if (key === 'P2') p2Name = val || p2Name;
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
          hitFrames: 0,
          totalFrames: 0,
          fillRatio: 0,
        };

        notes.push(noteObj);
        currentLineSyllables.push(noteObj);
      }
      flushLine();

      return {
        name: tIdx === 0 ? p1Name : p2Name,
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

function computeDynamicCanvasPitchRange() {
  if (state.notes.length === 0) {
    state.chartMinMidi = 53;
    state.chartMaxMidi = 77;
    return;
  }
  let minM = 999;
  let maxM = 0;
  for (const n of state.notes) {
    if (!n.isFreestyle) {
      if (n.midi < minM) minM = n.midi;
      if (n.midi > maxM) maxM = n.midi;
    }
  }
  if (minM > maxM) {
    minM = 58;
    maxM = 70;
  }
  state.chartMinMidi = Math.max(40, minM - 5);
  state.chartMaxMidi = Math.min(88, Math.max(state.chartMinMidi + 16, maxM + 5));
}

function updateFirstLyricLabel() {
  const effectiveStart = Math.max(0, state.firstLyricTime + state.videoOffsetSec);
  const firstMin = Math.floor(effectiveStart / 60);
  const firstSec = (effectiveStart % 60).toFixed(1).padStart(4, '0');
  document.getElementById('lblFirstLyricTime').textContent = `1. Ton bei ${firstMin}:${firstSec}`;
}

/* ============================================================================
 * 5. FALLBACK AUDIO ANALYSIS & LRC BUILDER
 * ============================================================================ */
async function analyzeSongPreviewAudio(song) {
  const seed = hashString(`${song.artistName}-${song.trackName}`);
  state.bpm = 110 + (seed % 35);
  state.displayBpm = state.bpm;
  state.rootPitchClass = seed % 12;
  const extractedMidis = [];

  if (!song.previewUrl) return extractedMidis;

  try {
    const res = await fetch(song.previewUrl);
    const arrayBuf = await res.arrayBuffer();
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100 * 25, 44100);
    const audioBuf = await offlineCtx.decodeAudioData(arrayBuf);
    const channelData = audioBuf.getChannelData(0);
    const sr = audioBuf.sampleRate;

    const frameSize = 2048;
    const hopSize = Math.floor(sr * 0.04);
    const chromaCounts = new Array(12).fill(0);

    for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
      const slice = channelData.subarray(i, i + frameSize);
      const { hz, clarity } = detectPitchMPM(slice, sr);
      if (hz >= 150 && hz <= 820 && clarity >= 0.68) {
        const midi = Math.round(hzToMidi(hz));
        const pc = ((midi % 12) + 12) % 12;
        chromaCounts[pc]++;
        extractedMidis.push(midi);
      }
    }

    let maxPc = 0;
    let maxCnt = 0;
    chromaCounts.forEach((cnt, pc) => {
      if (cnt > maxCnt) {
        maxCnt = cnt;
        maxPc = pc;
      }
    });
    if (maxCnt > 0) state.rootPitchClass = maxPc;
  } catch (_) {}

  return extractedMidis;
}

function buildNoteChartFromLRC(lrcText, songDurationSec = 210, extractedMidis = []) {
  state.isUltraStarChart = false;
  const rawLines = [];
  const lineRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\](.*)/;

  for (const raw of (lrcText || '').split('\n')) {
    const m = raw.match(lineRegex);
    if (!m) continue;
    const min = parseInt(m[1], 10);
    const sec = parseFloat(m[2]);
    const time = min * 60 + sec;
    const text = m[3].replace(/<[^>]+>/g, '').trim();
    if (text.length > 0) {
      rawLines.push({ startTime: time, text });
    }
  }

  rawLines.sort((a, b) => a.startTime - b.startTime);
  state.lines = [];
  state.notes = [];
  if (rawLines.length === 0) return;

  state.firstLyricTime = rawLines[0].startTime;

  const baseMidi = 60 + state.rootPitchClass;
  const scaleMidis = MAJOR_INTERVALS.map((iv) => baseMidi + iv);
  let noteIdCounter = 1;
  let melodyCursor = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const cur = rawLines[i];
    const nextStart = i + 1 < rawLines.length ? rawLines[i + 1].startTime : Math.max(cur.startTime + 3.5, songDurationSec);
    const lineDuration = Math.max(0.8, Math.min(nextStart - cur.startTime - 0.2, 5.2));

    const syllables = splitLineIntoSyllables(cur.text);
    if (syllables.length === 0) continue;

    const weights = syllables.map((s, idx) => {
      let w = Math.max(1, Math.min(2.2, s.clean.length * 0.35));
      if (idx === syllables.length - 1) w *= 1.5;
      return w;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let cursorTime = cur.startTime;
    const lineSyllableObjs = [];

    for (let sIdx = 0; sIdx < syllables.length; sIdx++) {
      const syl = syllables[sIdx];
      const slotDur = (weights[sIdx] / totalWeight) * lineDuration;
      const gap = Math.min(0.05, slotDur * 0.15);
      const noteDur = Math.max(0.14, slotDur - gap);

      let midi = 64;
      if (extractedMidis.length > 8) {
        const rawM = extractedMidis[melodyCursor % extractedMidis.length];
        melodyCursor += 2;
        const octaveShift = Math.round((64 - rawM) / 12) * 12;
        midi = rawM + octaveShift;
      } else {
        midi = scaleMidis[(i * 3 + sIdx) % scaleMidis.length];
      }

      const isGolden = sIdx === syllables.length - 1 && noteDur >= 0.45 && i % 2 === 1;

      const noteObj = {
        id: noteIdCounter++,
        startTime: cursorTime,
        endTime: cursorTime + noteDur,
        duration: noteDur,
        midi,
        text: syl.display,
        lineIndex: state.lines.length,
        isGolden,
        isFreestyle: true, // Auto-LRC songs are scored on rhythm/singing rather than fake pitches
        hitFrames: 0,
        totalFrames: 0,
        fillRatio: 0,
      };

      state.notes.push(noteObj);
      lineSyllableObjs.push(noteObj);
      cursorTime += slotDur;
    }

    state.lines.push({
      startTime: cur.startTime,
      endTime: cur.startTime + lineDuration,
      text: cur.text,
      syllables: lineSyllableObjs,
    });
  }

  computeDynamicCanvasPitchRange();
}

function splitLineIntoSyllables(lineText) {
  const words = lineText.split(/\s+/).filter(Boolean);
  const result = [];
  for (const word of words) {
    const cleanWord = word.replace(/[^\p{L}\p{N}']/gu, '');
    if (!cleanWord) continue;
    if (cleanWord.length <= 4) {
      result.push({ display: word + ' ', clean: cleanWord.toLowerCase() });
    } else {
      const parts = cleanWord.match(/[^aeiouyäöü]*[aeiouyäöü]+(?:[^aeiouyäöü](?![aeiouyäöü]))?/gi);
      if (!parts || parts.length <= 1) {
        result.push({ display: word + ' ', clean: cleanWord.toLowerCase() });
      } else {
        parts.forEach((p, idx) => {
          const isLast = idx === parts.length - 1;
          result.push({ display: isLast ? p + ' ' : p + '-', clean: p.toLowerCase() });
        });
      }
    }
  }
  return result;
}

/* ============================================================================
 * 6. ROBUST YOUTUBE MATCHING & AUTO-ERROR RECOVERY (Fixes VEVO/Embed Blocks!)
 * ============================================================================ */
async function findAndLoadYouTubeVideo(song, originalTxtVideoId = '') {
  const overlay = document.getElementById('ytOverlayStatus');
  const selectEl = document.getElementById('selectYtVideo');
  overlay.textContent = 'Suche einbettbare YouTube-Versionen...';
  overlay.classList.remove('hidden');
  selectEl.innerHTML = '';

  const query = `${song.artistName} ${song.trackName}`;
  const candidates = [];
  const seenIds = new Set();

  const addCandidate = (videoId, title, isOriginalGap = false) => {
    if (!videoId || seenIds.has(videoId)) return;
    seenIds.add(videoId);
    candidates.push({ videoId, title, isOriginalGap });
  };

  // 1. Add original #VIDEO from UltraStar .txt file first
  if (originalTxtVideoId) {
    addCandidate(originalTxtVideoId, `★ Original .txt Video (${originalTxtVideoId})`, true);
  }

  // 2. Add verified preset fallbacks if matching
  const lowerQ = query.toLowerCase();
  for (const [key, list] of Object.entries(VERIFIED_YOUTUBE_FALLBACKS)) {
    if (lowerQ.includes(key) || key.split(' ').every((w) => lowerQ.includes(w))) {
      for (const item of list) {
        addCandidate(item.videoId, item.title, item.isOriginalGap);
      }
    }
  }

  // 3. Always search /api/youtube for embeddable Lyric / Audio / Karaoke versions!
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`/api/youtube?q=${encodeURIComponent(query)}&duration=${song.duration || 0}`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      for (const v of data.videos || []) {
        addCandidate(v.videoId, `${v.title} (${v.durationText})`, v.videoId === originalTxtVideoId);
      }
    }
  } catch (_) {}

  // 4. Browser-side fallback via Piped/Invidious if needed
  if (candidates.length <= 1) {
    const endpoints = [
      `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query + ' Lyrics')}&filter=videos`,
      `https://inv.nadeko.net/api/v1/search?q=${encodeURIComponent(query + ' Lyrics')}&type=video`,
    ];
    for (const url of endpoints) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) continue;
        const d = await r.json();
        const items = Array.isArray(d) ? d : d.items || [];
        for (const it of items.slice(0, 6)) {
          const vid = it.videoId || extractYouTubeId(it.url) || (it.url || '').replace('/watch?v=', '');
          if (vid) addCandidate(vid, it.title || query, false);
        }
        if (candidates.length > 2) break;
      } catch (_) {}
    }
  }

  state.ytVideoList = candidates;
  state.ytCurrentIndex = 0;

  if (candidates.length > 0) {
    candidates.forEach((v, idx) => {
      const opt = document.createElement('option');
      opt.value = v.videoId;
      opt.textContent = v.title;
      if (idx === 0) opt.selected = true;
      selectEl.appendChild(opt);
    });

    const first = candidates[0];
    if (first.isOriginalGap) {
      setVideoOffset(0);
      document.getElementById('btnUseOriginalGap').classList.add('active-sync-mode');
      document.getElementById('btnUseStudioSync').classList.remove('active-sync-mode');
      document.getElementById('badgeSyncInfo').textContent = '✓ Original Video-GAP aktiv';
    } else {
      applyStudioSyncOffset();
    }

    loadYouTubeVideoById(first.videoId);
  } else {
    overlay.textContent = 'Bitte eigene YouTube-URL unten einfügen.';
  }
}

function loadYouTubeVideoById(videoId) {
  const overlay = document.getElementById('ytOverlayStatus');
  overlay.classList.add('hidden');

  if (!state.ytReady || !window.YT || !window.YT.Player) {
    setTimeout(() => loadYouTubeVideoById(videoId), 250);
    return;
  }

  if (state.ytPlayer && typeof state.ytPlayer.loadVideoById === 'function') {
    state.ytPlayer.loadVideoById({ videoId, startSeconds: 0 });
    return;
  }

  state.ytPlayer = new window.YT.Player('ytPlayerContainer', {
    videoId,
    playerVars: {
      autoplay: 1,
      controls: 1,
      rel: 0,
      playsinline: 1,
      modestbranding: 1,
      enablejsapi: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: () => {
        overlay.classList.add('hidden');
        state.isPlaying = true;
      },
      onStateChange: (ev) => {
        if (state.playbackSource === 'youtube') {
          state.isPlaying = ev.data === window.YT.PlayerState.PLAYING;
        }
      },
      onError: (errEv) => {
        // Error 100 (not found), 101 / 150 (VEVO / owner blocks iframe embedding!)
        console.warn('YouTube Embed Error code:', errEv.data, '-> switching to next available video!');
        handleYouTubeEmbedFallback();
      },
    },
  });
}

function handleYouTubeEmbedFallback() {
  if (state.ytCurrentIndex + 1 < state.ytVideoList.length) {
    state.ytCurrentIndex++;
    const nextVid = state.ytVideoList[state.ytCurrentIndex];
    const selectEl = document.getElementById('selectYtVideo');
    if (selectEl) selectEl.value = nextVid.videoId;

    document.getElementById('badgeSyncInfo').textContent = '↻ Video gesperrt – Auto-Wechsel auf Lyric/Audio!';
    if (nextVid.isOriginalGap) {
      setVideoOffset(0);
      document.getElementById('btnUseOriginalGap').classList.add('active-sync-mode');
      document.getElementById('btnUseStudioSync').classList.remove('active-sync-mode');
    } else {
      applyStudioSyncOffset();
    }
    loadYouTubeVideoById(nextVid.videoId);
  } else {
    const overlay = document.getElementById('ytOverlayStatus');
    overlay.textContent = 'Dieses Video blockiert Einbettung. Wähle eine andere Version oder nutze 🟢 Spotify!';
    overlay.classList.remove('hidden');
  }
}

/* ============================================================================
 * 7. UNIFIED PLAYBACK TIME & TRANSPORT CONTROLS (YouTube + Spotify)
 * ============================================================================ */
function getRawPlayerTime() {
  if (state.playbackSource === 'local' && state.localAudio) {
    return state.localAudio.currentTime;
  }

  if (state.playbackSource === 'spotify' && state.spotifyReady) {
    let posMs = state.spotifyPositionMs;
    if (state.spotifyIsPlaying && state.spotifyLastUpdateTs > 0) {
      posMs += performance.now() - state.spotifyLastUpdateTs;
    }
    return posMs / 1000;
  }

  if (state.ytPlayer && typeof state.ytPlayer.getCurrentTime === 'function') {
    const t = state.ytPlayer.getCurrentTime();
    if (typeof t === 'number' && !isNaN(t)) {
      const now = performance.now();
      if (Math.abs(t - state.ytLastReportedTime) > 0.001) {
        state.ytLastReportedTime = t;
        state.ytLastReportedTs = now;
      }
      if (state.isPlaying && state.ytLastReportedTs > 0) {
        const elapsed = (now - state.ytLastReportedTs) / 1000;
        // Smooth 60fps/120fps interpolation between YouTube 250ms postMessage ticks
        if (elapsed >= 0 && elapsed < 0.4) {
          return t + elapsed;
        }
      }
      return t;
    }
  }
  return state.simulatedTime;
}

function getSongTimeWithOffset() {
  return getRawPlayerTime() - state.videoOffsetSec;
}

function togglePlayPause() {
  if (state.playbackSource === 'local' && state.localAudio) {
    if (state.localAudio.paused) {
      state.localAudio.play().catch(() => {});
      state.isPlaying = true;
    } else {
      state.localAudio.pause();
      state.isPlaying = false;
    }
    return;
  }

  if (state.playbackSource === 'spotify' && state.spotifyPlayer) {
    state.spotifyPlayer.togglePlay().catch(() => {});
    return;
  }

  if (state.ytPlayer && typeof state.ytPlayer.getPlayerState === 'function') {
    const st = state.ytPlayer.getPlayerState();
    if (st === window.YT.PlayerState.PLAYING) {
      state.ytPlayer.pauseVideo();
      state.isPlaying = false;
    } else {
      state.ytPlayer.playVideo();
      state.isPlaying = true;
    }
  } else {
    state.isPlaying = !state.isPlaying;
  }
}

function restartSong() {
  resetScoreState();
  if (state.playbackSource === 'local' && state.localAudio) {
    state.localAudio.currentTime = 0;
    state.localAudio.play().catch(() => {});
    state.isPlaying = true;
    return;
  }

  if (state.playbackSource === 'spotify' && state.spotifyPlayer) {
    state.spotifyPlayer.seek(0).catch(() => {});
    state.spotifyPlayer.resume().catch(() => {});
    state.spotifyPositionMs = 0;
    state.spotifyLastUpdateTs = performance.now();
    return;
  }

  const startAt = state.videoStartGapSec || 0;
  if (state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
    state.ytPlayer.seekTo(startAt, true);
    state.ytPlayer.playVideo();
  }
  state.simulatedTime = startAt;
}

function skipToFirstVocals() {
  const targetSongTime = Math.max(0, state.firstLyricTime - 2.8);
  const targetRawTime = Math.max(0, targetSongTime + state.videoOffsetSec);

  if (state.playbackSource === 'local' && state.localAudio) {
    state.localAudio.currentTime = Math.max(0, targetRawTime);
    state.localAudio.play().catch(() => {});
    state.isPlaying = true;
    return;
  }

  if (state.playbackSource === 'spotify' && state.spotifyPlayer) {
    const targetMs = Math.round(targetRawTime * 1000);
    state.spotifyPlayer.seek(targetMs).catch(() => {});
    state.spotifyPlayer.resume().catch(() => {});
    state.spotifyPositionMs = targetMs;
    state.spotifyLastUpdateTs = performance.now();
    return;
  }

  if (state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
    state.ytPlayer.seekTo(targetRawTime, true);
    state.ytPlayer.playVideo();
  } else {
    state.simulatedTime = targetRawTime;
  }
}

function leaveStageToLobby() {
  if (state.localAudio) {
    try {
      state.localAudio.pause();
      state.localAudio.src = '';
    } catch (_) {}
    state.localAudio = null;
  }
  if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
    try {
      state.ytPlayer.pauseVideo();
    } catch (_) {}
  }
  if (state.spotifyPlayer) {
    state.spotifyPlayer.pause().catch(() => {});
  }
  state.isPlaying = false;
  document.getElementById('viewStage').classList.remove('active');
  document.getElementById('viewLobby').classList.add('active');
}

/* ============================================================================
 * 8. STABILIZED MICROPHONE PITCH ENGINE (True MPM + Median Filter + Hysteresis)
 * ============================================================================ */
async function startMicrophone(deviceId = '') {
  try {
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
    }

    const constraints = {
      audio: {
        echoCancellation: state.echoCancellation,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };

    state.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') {
      await state.audioCtx.resume();
    }

    const source = state.audioCtx.createMediaStreamSource(state.micStream);

    const highpass = state.audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;

    const lowpass = state.audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1000;

    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 4096;
    state.micBuffer = new Float32Array(2048);

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(state.analyser);

    state.micActive = true;
    document.getElementById('micStatusDot').classList.add('active');
    document.getElementById('micStatusText').textContent = 'Mikrofon aktiv';
  } catch (err) {
    console.error('Microphone access error:', err);
    alert('Mikrofon-Zugriff wurde blockiert oder nicht gefunden. Bitte erlaube den Mikrofon-Zugriff im Browser!');
  }
}

function stopMicrophone() {
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  state.micActive = false;
  document.getElementById('micStatusDot').classList.remove('active');
  document.getElementById('micStatusText').textContent = 'Mikrofon aktivieren';
  document.getElementById('topLiveNote').textContent = '--';
}

async function populateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    const select = document.getElementById('selectAudioInput');
    select.innerHTML = '';
    audioInputs.forEach((d, idx) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mikrofon ${idx + 1}`;
      if (d.deviceId === state.selectedDeviceId) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (_) {}
}

function updateMicrophonePitch() {
  if (!state.micActive || !state.analyser || !state.micBuffer) {
    markMicSilence();
    return;
  }

  state.analyser.getFloatTimeDomainData(state.micBuffer);

  let sumSq = 0;
  for (let i = 0; i < state.micBuffer.length; i++) {
    sumSq += state.micBuffer[i] * state.micBuffer[i];
  }
  const rms = Math.sqrt(sumSq / state.micBuffer.length);
  const volumePercent = Math.min(100, Math.round(rms * 420));
  state.currentVolume = volumePercent;

  const volBar = document.getElementById('micVolumeBar');
  if (volBar) volBar.style.width = `${volumePercent}%`;

  if (volumePercent < state.noiseGatePercent) {
    markMicSilence();
    return;
  }

  const { hz, clarity } = detectPitchMPM(state.micBuffer, state.audioCtx.sampleRate);

  if (hz >= 80 && hz <= 980 && clarity >= 0.62) {
    const rawMidi = hzToMidi(hz);

    let stabilizedRaw = rawMidi;
    if (state.recentRawMidis.length > 0) {
      const prevMedian = getMedian(state.recentRawMidis);
      const diff = rawMidi - prevMedian;
      if (Math.abs(diff - 12) < 1.8) stabilizedRaw -= 12;
      else if (Math.abs(diff + 12) < 1.8) stabilizedRaw += 12;
    }

    state.recentRawMidis.push(stabilizedRaw);
    if (state.recentRawMidis.length > 7) state.recentRawMidis.shift();

    const medianMidi = getMedian(state.recentRawMidis);

    state.voicedFrameCount++;
    if (state.silentFrameCount >= 4) {
      state.currentStrokeId++;
      state.smoothedMidi = medianMidi;
      state.lastDisplayedMidi = null;
    } else {
      state.smoothedMidi = state.smoothedMidi === null ? medianMidi : state.smoothedMidi * 0.68 + medianMidi * 0.32;
    }
    state.silentFrameCount = 0;

    state.currentHz = Math.round(midiToHz(state.smoothedMidi));
    state.currentMidi = state.smoothedMidi;
    state.currentClarity = Math.round(clarity * 100);

    const noteLabel = midiToNoteName(Math.round(state.smoothedMidi));
    updateLiveNoteLabels(noteLabel, state.currentHz, state.currentClarity);
  } else {
    markMicSilence();
  }
}

function markMicSilence() {
  state.silentFrameCount++;
  state.voicedFrameCount = 0;
  if (state.silentFrameCount > 3) {
    state.currentHz = 0;
    state.currentMidi = null;
    state.smoothedMidi = null;
    state.lastDisplayedMidi = null;
    state.recentRawMidis = [];
    state.currentClarity = 0;
    updateLiveNoteLabels('--', 0, 0);
  }
}

function updateLiveNoteLabels(noteStr, hz, clarity) {
  document.getElementById('topLiveNote').textContent = noteStr;
  document.getElementById('stageLiveNote').textContent = noteStr;
  document.getElementById('stageLiveHz').textContent = hz;
  document.getElementById('modalLiveNote').textContent = noteStr;
  document.getElementById('modalLiveHz').textContent = `${hz} Hz`;
  document.getElementById('modalLiveClarity').textContent = `${clarity}%`;
}

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

async function runInteractiveLatencyCalibration() {
  if (!state.micActive) {
    await startMicrophone(state.selectedDeviceId);
  }
  if (!state.audioCtx) return;

  const statusEl = document.getElementById('calibrationStatusText');
  const btn = document.getElementById('btnRunCalibration');
  btn.disabled = true;

  const intervalMs = 650;
  const detectedOffsets = [];

  statusEl.textContent = 'Mache dich bereit... Klatsche bei jedem der 4 Töne mit!';

  for (let beat = 1; beat <= 4; beat++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.frequency.value = beat === 4 ? 880 : 587.33;
    gain.gain.setValueAtTime(0.25, state.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, state.audioCtx.currentTime + 0.06);
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start();
    osc.stop(state.audioCtx.currentTime + 0.065);

    const beepTs = performance.now();
    statusEl.textContent = `Ton ${beat} / 4 – Klatschen!`;

    let peakVol = 0;
    let peakTime = 0;
    const startPoll = performance.now();
    while (performance.now() - startPoll < 420) {
      await new Promise((r) => setTimeout(r, 8));
      if (state.currentVolume > peakVol && state.currentVolume > state.noiseGatePercent + 8) {
        peakVol = state.currentVolume;
        peakTime = performance.now();
      }
    }
    if (peakTime > 0 && beat >= 2) {
      detectedOffsets.push(peakTime - beepTs);
    }
  }

  btn.disabled = false;
  if (detectedOffsets.length > 0) {
    const avgMs = Math.round(detectedOffsets.reduce((a, b) => a + b, 0) / detectedOffsets.length);
    setLatencyMs(avgMs);
    statusEl.textContent = `✓ Kalibrierung erfolgreich! Gemessene Latenz: ${avgMs} ms.`;
  } else {
    statusEl.textContent = 'Kein Klatschen erkannt. Bitte lauter klatschen oder Regler manuell nutzen.';
  }
}

/* ============================================================================
 * 9. SPEECH RECOGNITION & 60 FPS PITCH HIGHWAY RENDERER
 * ============================================================================ */
function initSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    document.getElementById('speechTextPreview').textContent = 'Tonhöhen-Modus';
    return;
  }

  try {
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const clean = transcript.trim().toLowerCase();
      if (clean) {
        state.lastRecognizedText = clean;
        document.getElementById('speechTextPreview').textContent = `"${clean.slice(-28)}"`;
        checkSpeechLyricBonus(clean);
      }
    };

    rec.onerror = () => {};
    rec.onend = () => {
      if (state.isPlaying && state.micActive) {
        try {
          rec.start();
        } catch (_) {}
      }
    };

    state.recognition = rec;
  } catch (_) {}
}

function checkSpeechLyricBonus(spokenText) {
  const songTime = getSongTimeWithOffset() - state.latencyMs / 1000;
  const activeLine = state.lines.find((l) => songTime >= l.startTime - 0.5 && songTime <= l.endTime + 1.0);
  if (!activeLine || activeLine.speechBonusAwarded) return;

  const words = activeLine.text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ''))
    .filter((w) => w.length >= 3);

  const matched = words.some((w) => spokenText.includes(w));
  if (matched) {
    activeLine.speechBonusAwarded = true;
    state.score += 150 * state.combo;
    document.getElementById('speechTextPreview').textContent = `✓ Wort erkannt (+${150 * state.combo} Pkt!)`;
  }
}

function resetScoreState() {
  state.score = 0;
  state.combo = 1;
  state.streakHits = 0;
  state.totalFramesChecked = 0;
  state.hitFramesCount = 0;
  state.pitchHistory = [];
  state.particles = [];
  if (state.notes) {
    state.notes.forEach((n) => {
      n.hitFrames = 0;
      n.totalFrames = 0;
      n.fillRatio = 0;
    });
  }
  updateScoreHUD();
}

function updateScoreHUD() {
  document.getElementById('hudScore').textContent = String(Math.round(state.score)).padStart(5, '0');
  document.getElementById('hudCombo').textContent = `${state.combo}x`;
  const acc =
    state.totalFramesChecked > 0
      ? Math.round((state.hitFramesCount / state.totalFramesChecked) * 100)
      : 0;
  document.getElementById('hudAccuracy').textContent = `${acc}%`;
}

function mainRenderLoop(nowTs) {
  const dt = Math.min(0.1, (nowTs - state.lastFrameTs) / 1000);
  state.lastFrameTs = nowTs;

  if (state.isPlaying && state.playbackSource === 'youtube' && (!state.ytPlayer || typeof state.ytPlayer.getCurrentTime !== 'function')) {
    state.simulatedTime += dt;
  }

  updateMicrophonePitch();

  if (document.getElementById('viewStage').classList.contains('active')) {
    const rawPlayerTime = getRawPlayerTime();
    const rawSongTime = rawPlayerTime - state.videoOffsetSec;
    const evalTime = rawSongTime - state.latencyMs / 1000;

    // Update Spotify Progress Bar if in Spotify mode
    if (state.playbackSource === 'spotify') {
      document.getElementById('spotifyTimeCur').textContent = formatSec(rawPlayerTime);
      if (state.spotifyDurationSec > 0) {
        document.getElementById('spotifySeekSlider').value = Math.min(
          1000,
          Math.round((rawPlayerTime / state.spotifyDurationSec) * 1000)
        );
      }
    }

    evaluatePitchAtTime(evalTime, dt);
    updateLyricsPrompter(rawSongTime);
    renderPitchHighwayCanvas(rawSongTime, evalTime);
  }

  requestAnimationFrame(mainRenderLoop);
}

function getReferenceMidiAtTime(evalTime) {
  if (state.notes.length === 0) return 64;
  const active = state.notes.find((n) => evalTime >= n.startTime && evalTime <= n.endTime);
  if (active) return active.midi;

  let closest = state.notes[0];
  let minDist = Infinity;
  for (const n of state.notes) {
    const d = Math.min(Math.abs(evalTime - n.startTime), Math.abs(evalTime - n.endTime));
    if (d < minDist) {
      minDist = d;
      closest = n;
    }
  }
  return closest ? closest.midi : 64;
}

function foldMidiToTarget(rawMidi, targetMidi, prevDisplayMidi) {
  if (!state.octaveAgnostic) return rawMidi;
  let signedDiff = ((((rawMidi - targetMidi) % 12) + 18) % 12) - 6;
  let candidate = targetMidi + signedDiff;

  if (prevDisplayMidi !== null) {
    if (candidate - prevDisplayMidi > 7.5) candidate -= 12;
    else if (prevDisplayMidi - candidate > 7.5) candidate += 12;
  }
  return candidate;
}

function evaluatePitchAtTime(evalTime, dt) {
  const activeNote = state.notes.find((n) => evalTime >= n.startTime && evalTime <= n.endTime);
  const refMidi = activeNote ? activeNote.midi : getReferenceMidiAtTime(evalTime);
  const feedbackEl = document.getElementById('pitchFeedbackBadge');
  const targetNoteEl = document.getElementById('stageTargetNote');

  if (!activeNote) {
    targetNoteEl.textContent = '--';
    if (state.smoothedMidi !== null && state.voicedFrameCount >= 2) {
      const folded = foldMidiToTarget(state.smoothedMidi, refMidi, state.lastDisplayedMidi);
      const displayMidi =
        state.lastDisplayedMidi === null ? folded : state.lastDisplayedMidi * 0.65 + folded * 0.35;
      state.lastDisplayedMidi = displayMidi;

      state.pitchHistory.push({
        songTime: evalTime,
        midi: displayMidi,
        hit: false,
        strokeId: state.currentStrokeId,
      });
    }
    trimPitchHistory(evalTime);
    return;
  }

  targetNoteEl.textContent = activeNote.isFreestyle ? 'Freestyle' : midiToNoteName(activeNote.midi);
  activeNote.totalFrames++;

  if (state.smoothedMidi !== null && state.voicedFrameCount >= 1) {
    let displayMidi = foldMidiToTarget(state.smoothedMidi, activeNote.midi, state.lastDisplayedMidi);
    const rawDiff = Math.abs(displayMidi - activeNote.midi);

    const isHit = activeNote.isFreestyle || rawDiff <= state.difficultyTolerance;
    const isPerfect = activeNote.isFreestyle || rawDiff <= state.difficultyTolerance * 0.6;

    if (isHit && state.pitchMagnet && !activeNote.isFreestyle) {
      displayMidi = activeNote.midi + (displayMidi - activeNote.midi) * 0.22;
    }

    if (state.lastDisplayedMidi !== null) {
      displayMidi = state.lastDisplayedMidi * 0.55 + displayMidi * 0.45;
    }
    state.lastDisplayedMidi = displayMidi;

    state.totalFramesChecked++;

    if (isHit) {
      activeNote.hitFrames++;
      activeNote.fillRatio = Math.min(1, activeNote.hitFrames / Math.max(1, activeNote.totalFrames));
      state.hitFramesCount++;
      state.streakHits++;

      if (state.streakHits > 45) state.combo = 4;
      else if (state.streakHits > 25) state.combo = 3;
      else if (state.streakHits > 10) state.combo = 2;

      const basePts = activeNote.isGolden ? 240 : 120;
      const qualityMult = isPerfect ? 1.35 : 1.0;
      state.score += basePts * qualityMult * state.combo * dt;

      feedbackEl.textContent = isPerfect ? '★ PERFEKT!' : '✓ GUT!';
      feedbackEl.className = 'pitch-feedback ' + (isPerfect ? 'perfect' : 'good');

      spawnHitParticles(activeNote.midi, activeNote.isGolden);
    } else {
      state.streakHits = 0;
      state.combo = 1;
      const dir = displayMidi < activeNote.midi ? '↑ Etwas höher!' : '↓ Etwas tiefer!';
      feedbackEl.textContent = dir;
      feedbackEl.className = 'pitch-feedback miss';
    }

    state.pitchHistory.push({
      songTime: evalTime,
      midi: displayMidi,
      hit: isHit,
      strokeId: state.currentStrokeId,
    });
    updateScoreHUD();
  } else {
    if (state.isPlaying) {
      state.totalFramesChecked++;
      state.streakHits = 0;
      state.combo = 1;
      feedbackEl.textContent = '🎤 Sing jetzt!';
      feedbackEl.className = 'pitch-feedback';
      updateScoreHUD();
    }
  }

  trimPitchHistory(evalTime);
}

function trimPitchHistory(evalTime) {
  while (state.pitchHistory.length > 0 && state.pitchHistory[0].songTime < evalTime - 3.5) {
    state.pitchHistory.shift();
  }
}

function updateLyricsPrompter(songTime) {
  const curEl = document.getElementById('lyricCurrentLine');
  const nextEl = document.getElementById('lyricNextLine');
  const progEl = document.getElementById('phraseProgressFill');

  if (state.lines.length === 0) return;

  let idx = state.lines.findIndex((l) => songTime >= l.startTime - 0.6 && songTime <= l.endTime + 0.35);
  if (idx === -1) {
    idx = state.lines.findIndex((l) => l.startTime > songTime);
    if (idx === -1) idx = state.lines.length - 1;
  }

  const currentLine = state.lines[idx];
  const nextLine = state.lines[idx + 1];

  if (songTime >= currentLine.startTime && songTime <= currentLine.endTime) {
    const pct = ((songTime - currentLine.startTime) / Math.max(0.1, currentLine.endTime - currentLine.startTime)) * 100;
    progEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  } else {
    progEl.style.width = '0%';
  }

  const htmlParts = currentLine.syllables.map((s) => {
    if (songTime > s.endTime) {
      return `<span class="syl-done">${escapeHtml(s.text)}</span>`;
    } else if (songTime >= s.startTime && songTime <= s.endTime) {
      return `<span class="syl-active">${escapeHtml(s.text)}</span>`;
    }
    return `<span>${escapeHtml(s.text)}</span>`;
  });

  curEl.innerHTML = htmlParts.join('');
  nextEl.textContent = nextLine ? nextLine.text : '♪ ...';
}

function renderPitchHighwayCanvas(songTime, evalTime) {
  const canvas = document.getElementById('pitchCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const pastSec = 1.6;
  const futureSec = 4.4;
  const totalWindowSec = pastSec + futureSec;
  const playheadX = (pastSec / totalWindowSec) * W;

  const minMidi = state.chartMinMidi;
  const maxMidi = state.chartMaxMidi;
  const midiToY = (m) => {
    const clamped = Math.max(minMidi, Math.min(maxMidi, m));
    return H - 42 - ((clamped - minMidi) / Math.max(1, maxMidi - minMidi)) * (H - 76);
  };
  const timeToX = (t) => playheadX + ((t - evalTime) / totalWindowSec) * W;

  // 1. Horizontal Pitch Grid
  ctx.lineWidth = 1;
  for (let m = minMidi; m <= maxMidi; m += 2) {
    const y = midiToY(m);
    ctx.strokeStyle = m % 12 === 0 ? 'rgba(0, 242, 254, 0.12)' : 'rgba(255, 255, 255, 0.04)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // 2. Target Note Tubes + Syllables
  const visibleNotes = state.notes.filter(
    (n) => n.endTime >= evalTime - pastSec - 0.5 && n.startTime <= evalTime + futureSec + 0.5
  );

  const barHeight = 22;
  ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';

  for (const note of visibleNotes) {
    const x1 = timeToX(note.startTime);
    const x2 = timeToX(note.endTime);
    const width = Math.max(10, x2 - x1);
    const y = midiToY(note.midi) - barHeight / 2;

    ctx.fillStyle = note.isGolden ? 'rgba(255, 207, 51, 0.2)' : 'rgba(255, 255, 255, 0.13)';
    ctx.strokeStyle = note.isGolden ? '#ffcf33' : 'rgba(0, 242, 254, 0.6)';
    ctx.lineWidth = note.isGolden ? 2 : 1.5;

    roundRect(ctx, x1, y, width, barHeight, 11);
    ctx.fill();
    ctx.stroke();

    if (note.fillRatio > 0) {
      const fillW = Math.max(8, width * note.fillRatio);
      const grad = ctx.createLinearGradient(x1, y, x1 + width, y);
      if (note.isGolden) {
        grad.addColorStop(0, '#ffcf33');
        grad.addColorStop(1, '#ff8800');
      } else {
        grad.addColorStop(0, '#00f2fe');
        grad.addColorStop(1, '#18e882');
      }
      ctx.fillStyle = grad;
      roundRect(ctx, x1, y, fillW, barHeight, 11);
      ctx.fill();
    }

    const isCurrent = evalTime >= note.startTime && evalTime <= note.endTime;
    ctx.fillStyle = isCurrent ? '#ffcf33' : 'rgba(245, 247, 255, 0.88)';
    ctx.fillText(note.text.trim(), x1 + 2, y + barHeight + 16);
  }

  // 3. Playhead Line
  ctx.strokeStyle = 'rgba(255, 42, 133, 0.85)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(playheadX, 12);
  ctx.lineTo(playheadX, H - 12);
  ctx.stroke();

  // 4. Stabilized Pitch Trail
  if (state.pitchHistory.length > 1) {
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < state.pitchHistory.length; i++) {
      const p0 = state.pitchHistory[i - 1];
      const p1 = state.pitchHistory[i];

      if (p0.strokeId !== p1.strokeId) continue;
      if (p1.songTime - p0.songTime > 0.12) continue;
      if (Math.abs(p1.midi - p0.midi) > 6.5) continue;

      ctx.strokeStyle = p1.hit ? '#18e882' : '#ff2a85';
      ctx.beginPath();
      ctx.moveTo(timeToX(p0.songTime), midiToY(p0.midi));
      ctx.lineTo(timeToX(p1.songTime), midiToY(p1.midi));
      ctx.stroke();
    }
  }

  // 5. Live Voice Orb
  if (state.lastDisplayedMidi !== null && state.smoothedMidi !== null) {
    const orbY = midiToY(state.lastDisplayedMidi);
    ctx.save();
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(playheadX, orbY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 6. Hit Particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.alpha -= 0.035;
    if (p.alpha <= 0) {
      state.particles.splice(i, 1);
      continue;
    }
    ctx.fillStyle = p.color.replace('ALPHA', p.alpha.toFixed(2));
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function spawnHitParticles(midi, isGolden) {
  if (state.particles.length > 45) return;
  const canvas = document.getElementById('pitchCanvas');
  const W = canvas.width;
  const H = canvas.height;
  const playheadX = (1.6 / 6.0) * W;
  const minMidi = state.chartMinMidi;
  const maxMidi = state.chartMaxMidi;
  const y = H - 42 - ((midi - minMidi) / Math.max(1, maxMidi - minMidi)) * (H - 76);

  for (let i = 0; i < 2; i++) {
    state.particles.push({
      x: playheadX,
      y: y + (Math.random() - 0.5) * 12,
      vx: -1.5 - Math.random() * 2.5,
      vy: (Math.random() - 0.5) * 3,
      radius: 2 + Math.random() * 2.5,
      alpha: 0.95,
      color: isGolden ? 'rgba(255, 207, 51, ALPHA)' : 'rgba(24, 232, 130, ALPHA)',
    });
  }
}

/* ============================================================================
 * 10. CRYPTO / PKCE & GENERAL HELPERS
 * ============================================================================ */
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values)
    .map((x) => possible[x % possible.length])
    .join('');
}

async function generateCodeChallenge(codeVerifier) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function formatSec(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}:${rem}`;
}

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi) {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

function getMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function extractYouTubeId(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const m = input.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================================
 * 9. PLAN.md Phase 6 - IN-BROWSER AI KARAOKE GENERATOR & SONG LIBRARY CLIENT
 * ============================================================================ */

async function loadLibrarySongs() {
  const emptyEl = document.getElementById('libraryEmptyText');
  const gridEl = document.getElementById('libraryGrid');
  if (!gridEl) return;

  try {
    const res = await fetch('/api/library');
    if (!res.ok) return;
    const data = await res.json();
    state.librarySongs = data.songs || [];

    if (state.librarySongs.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      gridEl.innerHTML = '';
    } else {
      if (emptyEl) emptyEl.classList.add('hidden');
      renderLibraryGrid(state.librarySongs);
    }
  } catch (err) {
    console.warn('Fehler beim Laden der Song-Bibliothek:', err);
  }
}

function renderLibraryGrid(songs) {
  const gridEl = document.getElementById('libraryGrid');
  if (!gridEl) return;

  gridEl.innerHTML = songs
    .map((s, idx) => {
      const coverHtml = s.coverUrl
        ? `<img class="card-cover" src="${escapeHtml(s.coverUrl)}" alt="Cover" />`
        : `<div class="card-cover card-cover-placeholder">🎤</div>`;

      let badgeClass = 'badge-ai';
      if (s.syncType === 'syllable') badgeClass = 'badge-syllable';
      else if (s.syncType === 'line' || s.syncType === 'word') badgeClass = 'badge-line';

      const durText = s.durationSec ? formatSec(s.durationSec) : '--:--';
      const scorePct = Math.round((s.qualityScore || 0.8) * 100);

      return `
      <div class="song-card" data-lib-idx="${idx}">
        ${coverHtml}
        <div class="card-body">
          <div class="card-badges">
            <span class="badge ${badgeClass}">${escapeHtml(s.badgeLabel || 'KI-Song')}</span>
            <span class="badge">${durText}</span>
            <span class="badge badge-gold">${scorePct}% Sync</span>
          </div>
          <h3 class="card-title">${escapeHtml(s.title)}</h3>
          <p class="card-artist">${escapeHtml(s.artist)}</p>
        </div>
        <button class="primary-btn card-action-btn btn-play-lib" data-lib-idx="${idx}">
          🎤 Singen
        </button>
      </div>`;
    })
    .join('');

  gridEl.querySelectorAll('.btn-play-lib').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-lib-idx'), 10);
      const song = state.librarySongs[idx];
      if (song) playLibrarySong(song);
    });
  });

  gridEl.querySelectorAll('.song-card').forEach((card) => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.getAttribute('data-lib-idx'), 10);
      const song = state.librarySongs[idx];
      if (song) playLibrarySong(song);
    });
  });
}

async function playLibrarySong(song) {
  resetScoreState();
  setVideoOffset(0);
  document.getElementById('viewLobby').classList.remove('active');
  document.getElementById('viewStage').classList.add('active');

  if (!state.micActive) {
    startMicrophone(state.selectedDeviceId).catch(() => {});
  }

  try {
    const res = await fetch(song.chartUrl);
    if (!res.ok) {
      alert('Konnte Notendatei nicht laden: ' + song.chartUrl);
      return;
    }
    const txtContent = await res.text();

    const songMeta = {
      trackName: song.title,
      artistName: song.artist,
      videoId: song.youtubeId || '',
      duration: song.durationSec || 210,
      instrumentalUrl: song.instrumentalUrl,
      artworkUrl: song.coverUrl,
    };

    await applyParsedUltraStarChart(txtContent, songMeta);

    // Update Stage Cover if available
    const coverEl = document.getElementById('stageCover');
    if (coverEl && song.coverUrl) {
      coverEl.src = song.coverUrl;
    }

    const badgeSource = document.getElementById('badgeChartSource');
    if (badgeSource) {
      badgeSource.textContent = `⚡ KI-Generiert (${escapeHtml(song.badgeLabel || 'KI-Melodie')})`;
    }

    // Use local instrumental audio track if available (pure studio karaoke without vocals!)
    if (song.instrumentalUrl) {
      setupLocalInstrumentalAudio(song.instrumentalUrl);
    }
  } catch (err) {
    console.error('Fehler beim Starten des KI-Songs:', err);
    alert('Fehler beim Laden des KI-Songs: ' + err.message);
  }
}

function setupLocalInstrumentalAudio(audioUrl) {
  state.playbackSource = 'local';
  if (state.localAudio) {
    try {
      state.localAudio.pause();
      state.localAudio.src = '';
    } catch (_) {}
  }

  state.localAudio = new Audio(audioUrl);
  state.localAudio.addEventListener('ended', () => {
    state.isPlaying = false;
  });
  state.localAudio.addEventListener('error', (e) => {
    console.warn('Local Audio Error, Video-Fallback aktiv:', e);
  });

  state.localAudio
    .play()
    .then(() => {
      state.isPlaying = true;
    })
    .catch((err) => {
      console.log('Autoplay blockiert (kann per Button gestartet werden):', err);
    });
}

async function handleResolveQuery(inputQuery) {
  const loadingEl = document.getElementById('resolveLoading');
  const previewCard = document.getElementById('resolvePreviewCard');

  if (loadingEl) loadingEl.classList.remove('hidden');
  if (previewCard) previewCard.classList.add('hidden');

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: inputQuery }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Song konnte nicht aufgelöst werden');
    }

    displayResolvePreview(data);
  } catch (err) {
    alert(`Fehler bei der Analyse: ${err.message}`);
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

async function handleAudioUpload(file) {
  const loadingEl = document.getElementById('resolveLoading');
  const loadingText = document.getElementById('resolveLoadingText');
  const previewCard = document.getElementById('resolvePreviewCard');

  if (loadingText) loadingText.textContent = `Lade "${file.name}" hoch (max. 80 MB)...`;
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (previewCard) previewCard.classList.add('hidden');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'audio/wav',
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Audio-Upload fehlgeschlagen');
    }

    // Auto-detect title and artist from filename
    const baseName = file.name.replace(/\.[^.]+$/, '');
    let artist = 'Eigener Upload';
    let title = baseName;
    if (baseName.includes(' - ')) {
      const parts = baseName.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }

    const resolved = {
      type: 'upload',
      title,
      artist,
      durationSec: 0,
      artworkUrl: '',
      spotifyTrackId: '',
      youtubeId: '',
      isrc: '',
      confidence: 1.0,
      slug: createSongSlugClient(artist, title),
      uploadedAudioPath: data.uploadedAudioPath,
    };

    displayResolvePreview(resolved);
  } catch (err) {
    alert(`Fehler beim Audio-Upload: ${err.message}`);
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
    if (loadingText) loadingText.textContent = 'Löse Track-Informationen, Lyrics und Video-Match auf...';
  }
}

function createSongSlugClient(artist, title) {
  const cleanArt = (artist || 'Unknown').trim();
  const cleanTit = (title || 'Track').trim();
  return `${cleanArt} - ${cleanTit}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'track';
}

function displayResolvePreview(resolved) {
  state.resolvedTrack = resolved;

  const previewCard = document.getElementById('resolvePreviewCard');
  if (!previewCard) return;

  const coverEl = document.getElementById('previewArtwork');
  if (coverEl) {
    coverEl.src = resolved.artworkUrl || 'https://via.placeholder.com/90x90/111827/00f2fe?text=KARAOKE';
  }

  const titleEl = document.getElementById('previewTitle');
  if (titleEl) titleEl.textContent = resolved.title || 'Unbekannter Titel';

  const artistEl = document.getElementById('previewArtist');
  if (artistEl) artistEl.textContent = resolved.artist || 'Unbekannter Interpret';

  const sourceBadge = document.getElementById('previewSourceBadge');
  if (sourceBadge) {
    if (resolved.type === 'spotify') sourceBadge.textContent = '🟢 Spotify';
    else if (resolved.type === 'youtube') sourceBadge.textContent = '📺 YouTube';
    else if (resolved.type === 'upload') sourceBadge.textContent = '📁 Upload';
    else sourceBadge.textContent = '🔍 Suche';
  }

  const durBadge = document.getElementById('previewDurationBadge');
  if (durBadge) {
    durBadge.textContent = resolved.durationSec ? formatSec(resolved.durationSec) : '--:--';
  }

  const confBadge = document.getElementById('previewConfidenceBadge');
  if (confBadge) {
    const confPct = Math.round((resolved.confidence || 0.8) * 100);
    confBadge.textContent = `${confPct}% Match`;
  }

  const noteEl = document.getElementById('previewMetaNote');
  if (noteEl) {
    if (resolved.youtubeId) {
      noteEl.textContent = `✓ YouTube Studio-Audio zugeordnet (${resolved.youtubeId})`;
    } else if (resolved.uploadedAudioPath) {
      noteEl.textContent = '✓ Lokale Audiodatei hochgeladen';
    } else {
      noteEl.textContent = 'ℹ YouTube-Audio wird beim Start gesucht';
    }
  }

  previewCard.classList.remove('hidden');
}

async function startGenerationJob(overrideOptions = {}) {
  if (!state.resolvedTrack) {
    alert('Bitte wähle zuerst einen Song aus');
    return;
  }

  const pitchEngine = document.getElementById('selectGenPitchEngine')?.value || 'fcpe';
  const separator = document.getElementById('selectGenSeparator')?.value || 'demucs';
  const quality = document.getElementById('selectGenQuality')?.value || 'balanced';
  const forceWhisper = document.getElementById('chkForceWhisper')?.checked || false;

  const options = {
    pitchEngine,
    separator,
    quality,
    forceWhisper,
    uploadedAudioPath: state.resolvedTrack.uploadedAudioPath || null,
    ...overrideOptions,
  };

  const previewCard = document.getElementById('resolvePreviewCard');
  if (previewCard) previewCard.classList.add('hidden');

  const progressCard = document.getElementById('genProgressCard');
  if (progressCard) progressCard.classList.remove('hidden');

  // Fill Header
  const thumbEl = document.getElementById('progressArtwork');
  if (thumbEl) {
    thumbEl.src = state.resolvedTrack.artworkUrl || 'https://via.placeholder.com/60x60/111827/ff2a85?text=KI';
  }
  const titleEl = document.getElementById('progressTitle');
  if (titleEl) titleEl.textContent = state.resolvedTrack.title;
  const artistEl = document.getElementById('progressArtist');
  if (artistEl) artistEl.textContent = state.resolvedTrack.artist;

  updateGenerationUI({
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'Auftrag wird an den Server übermittelt...',
  });

  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resolved: state.resolvedTrack,
        options,
      }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Job konnte nicht gestartet werden');
    }

    state.activeJobId = data.jobId;

    if (data.status === 'done') {
      // Instant cache hit!
      updateGenerationUI({
        status: 'done',
        stage: 'done',
        progress: 100,
        message: 'Song ist bereits fertig in der Bibliothek vorhanden!',
        result: data.result,
      });
      await loadLibrarySongs();
    } else {
      listenToJobEvents(data.jobId);
    }
  } catch (err) {
    updateGenerationUI({
      status: 'error',
      stage: 'error',
      progress: 0,
      message: `Fehler: ${err.message}`,
    });
  }
}

function listenToJobEvents(jobId) {
  // Clear any existing SSE or poll timers
  if (state.activeJobSse) {
    try {
      state.activeJobSse.close();
    } catch (_) {}
    state.activeJobSse = null;
  }
  if (state.activeJobPollTimer) {
    clearInterval(state.activeJobPollTimer);
    state.activeJobPollTimer = null;
  }

  // 1. Primary: Server-Sent Events (SSE)
  try {
    const sse = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    state.activeJobSse = sse;

    sse.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.job) {
          updateGenerationUI(payload.job);
          if (payload.job.status === 'done' || payload.job.status === 'error' || payload.job.status === 'cancelled') {
            sse.close();
            if (state.activeJobPollTimer) clearInterval(state.activeJobPollTimer);
          }
        }
      } catch (_) {}
    };

    sse.onerror = () => {
      // If SSE disconnects, polling timer takes over silently
    };
  } catch (err) {
    console.warn('SSE nicht verfügbar, wechsle zu Polling:', err);
  }

  // 2. Secondary fallback: 2.5-second interval polling
  state.activeJobPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (res.ok) {
        const job = await res.json();
        updateGenerationUI(job);
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
          clearInterval(state.activeJobPollTimer);
          state.activeJobPollTimer = null;
          if (state.activeJobSse) state.activeJobSse.close();
        }
      }
    } catch (_) {}
  }, 2500);
}

function updateGenerationUI(job) {
  const percentEl = document.getElementById('progressPercentNum');
  const barEl = document.getElementById('progressBarFill');
  const msgEl = document.getElementById('progressStatusMessage');
  const stageNameEl = document.getElementById('progressStageName');
  const statusPill = document.getElementById('progressStatusPill');
  const btnCancel = document.getElementById('btnCancelGeneration');
  const btnWhisper = document.getElementById('btnWhisperFallback');
  const btnPlay = document.getElementById('btnPlayGeneratedSong');

  const pct = Math.max(0, Math.min(100, job.progress || 0));

  if (percentEl) percentEl.textContent = `${pct}%`;
  if (barEl) barEl.style.width = `${pct}%`;
  if (msgEl) msgEl.textContent = job.message || 'Verarbeitung...';

  // Stepper Nodes
  const stepLyrics = document.getElementById('stepNodeLyrics');
  const stepAudio = document.getElementById('stepNodeAudio');
  const stepSep = document.getElementById('stepNodeSeparate');
  const stepPitch = document.getElementById('stepNodePitch');
  const stepDone = document.getElementById('stepNodeDone');

  function setStepState(el, active, done) {
    if (!el) return;
    el.classList.toggle('active', active);
    el.classList.toggle('done', done);
  }

  setStepState(stepLyrics, job.stage === 'lyrics', pct >= 15);
  setStepState(stepAudio, job.stage === 'download', pct >= 30);
  setStepState(stepSep, job.stage === 'separate', pct >= 60);
  setStepState(stepPitch, job.stage === 'align' || job.stage === 'pitch', pct >= 90);
  setStepState(stepDone, job.stage === 'finalize' || job.status === 'done', job.status === 'done');

  // Stage name label
  if (stageNameEl) {
    const stageLabels = {
      queued: 'Warteschlange',
      lyrics: 'Songtexte & Sync',
      download: 'Audio-Download',
      separate: 'KI-Stimmentrennung',
      align: 'Silben-Ausrichtung',
      pitch: 'Melodie-Erkennung',
      finalize: 'Chart & Bibliothek',
      done: 'Fertiggestellt',
      error: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    };
    stageNameEl.textContent = stageLabels[job.stage] || job.stage || 'Initialisierung';
  }

  // Handle Whisper fallback offer
  if (btnWhisper) {
    if (job.canFallbackWhisper && job.status === 'error') {
      btnWhisper.classList.remove('hidden');
    } else {
      btnWhisper.classList.add('hidden');
    }
  }

  // Handle Done state
  if (job.status === 'done') {
    if (statusPill) {
      statusPill.textContent = '✓ Fertiggestellt';
      statusPill.className = 'badge badge-sync';
    }
    if (btnPlay) btnPlay.classList.remove('hidden');
    if (btnCancel) btnCancel.classList.add('hidden');
    if (job.result) state.lastGeneratedSong = job.result;
    loadLibrarySongs();
  } else if (job.status === 'error') {
    if (statusPill) {
      statusPill.textContent = '✕ Fehler';
      statusPill.className = 'badge badge-pink';
    }
    if (btnPlay) btnPlay.classList.add('hidden');
  } else {
    if (statusPill) {
      statusPill.textContent = '⚡ KI-Verarbeitung läuft';
      statusPill.className = 'badge badge-pink';
    }
    if (btnPlay) btnPlay.classList.add('hidden');
    if (btnCancel) btnCancel.classList.remove('hidden');
  }
}

async function cancelActiveGenerationJob() {
  if (!state.activeJobId) return;

  if (state.activeJobSse) {
    try {
      state.activeJobSse.close();
    } catch (_) {}
    state.activeJobSse = null;
  }
  if (state.activeJobPollTimer) {
    clearInterval(state.activeJobPollTimer);
    state.activeJobPollTimer = null;
  }

  try {
    await fetch(`/api/jobs/${encodeURIComponent(state.activeJobId)}/cancel`, {
      method: 'POST',
    });
  } catch (_) {}

  const progressCard = document.getElementById('genProgressCard');
  if (progressCard) progressCard.classList.add('hidden');
  state.activeJobId = null;
}

// Phase 6 Settings Helpers
async function loadLyricsSettings() {
  try {
    const res = await fetch('/api/lyrics/status');
    if (!res.ok) return;
    const data = await res.json();

    const badgeSpicy = document.getElementById('statusBadgeSpicy');
    if (badgeSpicy) {
      if (data.spicyConfigured) {
        badgeSpicy.textContent = '✓ Aktiviert';
        badgeSpicy.className = 'badge badge-sync';
      } else {
        badgeSpicy.textContent = 'Nicht konfiguriert';
        badgeSpicy.className = 'badge';
      }
    }

    const badgeSpDc = document.getElementById('statusBadgeSpDc');
    if (badgeSpDc) {
      if (data.spotifySpDcConfigured) {
        badgeSpDc.textContent = '✓ Aktiviert';
        badgeSpDc.className = 'badge badge-sync';
      } else {
        badgeSpDc.textContent = 'Nicht konfiguriert';
        badgeSpDc.className = 'badge';
      }
    }
  } catch (_) {}
}

async function saveSpicyKey() {
  const input = document.getElementById('inputSettingSpicyKey');
  if (!input) return;
  const key = input.value.trim();
  if (!key) return;

  try {
    const res = await fetch('/api/settings/spicy-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      input.value = '';
      alert('✓ Spicy Lyrics Key erfolgreich lokal gespeichert!');
      await loadLyricsSettings();
    }
  } catch (err) {
    alert(`Fehler beim Speichern: ${err.message}`);
  }
}

async function saveSpDc() {
  const input = document.getElementById('inputSettingSpDc');
  if (!input) return;
  const spDc = input.value.trim();
  if (!spDc) return;

  try {
    const res = await fetch('/api/settings/sp-dc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spDc }),
    });
    if (res.ok) {
      input.value = '';
      alert('✓ Spotify sp_dc Cookie erfolgreich lokal gespeichert!');
      await loadLyricsSettings();
    }
  } catch (err) {
    alert(`Fehler beim Speichern: ${err.message}`);
  }
}

async function checkSystemHealthStatus() {
  const lbl = document.getElementById('lblSystemHealthStatus');
  if (lbl) lbl.textContent = 'Prüfe Umgebung...';

  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const data = await res.json();
      const yt = data.ytDlpAvailable ? '✓ yt-dlp bereit' : '✗ yt-dlp fehlt';
      const ff = data.ffmpegAvailable ? '✓ ffmpeg bereit' : '✗ ffmpeg fehlt';
      const py = data.pythonVenvAvailable ? '✓ Python venv bereit' : '✗ Python venv fehlt';
      if (lbl) lbl.textContent = `${yt} | ${ff} | ${py}`;
    }
  } catch (err) {
    if (lbl) lbl.textContent = 'Fehler beim Abrufen des Systemstatus.';
  }
}

