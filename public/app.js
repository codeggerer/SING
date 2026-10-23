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

// Default Application Settings Schema
const DEFAULT_SETTINGS = {
  // Display & HUD
  showLyricsRibbon: true,        // Bottom synchronized lyrics prompter
  showSyllablesOnNotes: true,    // Syllables rendered directly on note tubes
  showLiveVoiceOrb: true,        // Live singing pitch orb & trail
  showPitchBadges: true,         // Perfect/Good/Miss feedback pill
  showScoreHUD: true,            // Score & combo multiplier HUD
  theaterMode: false,            // Full-width highway (hides left video deck)
  stageLayout: 'backdrop',       // Stage layout mode ('split' | 'backdrop' | 'theater')
  backdropHighwayHeight: '100',  // Height of transparent highway box in backdrop mode ('25' | '33' | '50' | '100')
  highwayBackdropOpacity: 65,    // Darkness opacity for highway backdrop (15-95%)
  highwayBackdropBlur: true,     // Frosted glass blur effect for highway backdrop
  playheadColor: 'cyan',         // Playhead laser color ('cyan' | 'gold' | 'emerald' | 'white' | 'magenta')

  // Audio & Mixing
  guideVocalsVolume: 35,         // Loudness percentage for original vocals (0-100)
  masterVolume: 90,              // Master audio output volume
  micMonitoring: false,          // Play mic audio back to headphones
  micMonitorVolume: 50,          // Mic monitoring level

  // Microphone & Scoring
  noiseGate: 6,                  // Noise gate threshold (%)
  difficulty: 1.5,               // Hit tolerance in semitones
  octaveAgnostic: true,          // Allow singing in any octave
  latencyMs: 80,                 // Audio delay compensation in milliseconds
};

// Application State
const state = {
  // Modular App Settings
  settings: { ...DEFAULT_SETTINGS },

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
  viewportCenterMidi: 65,
  viewportSpanMidi: 16,

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
  theaterMode: false,
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
  customLyricsText: null, // Phase 5 Manual Lyrics Override
  activeJobId: null,
  activeJobSse: null,
  activeJobPollTimer: null,
  librarySongs: [],
  stemMixer: null,
  lastYtSyncSeekTs: 0,
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
  micMonitorGain: null,
  micSource: null,
  latencyMs: 80,
  noiseGatePercent: 6,
  difficultyTolerance: 1.5,
  pitchMagnet: true,
  octaveAgnostic: true,

  // Pitch Stabilization Buffers & Vocal Register
  currentHz: 0,
  currentMidi: null,
  smoothedMidi: null,
  lastDisplayedMidi: null,
  establishedOctaveShift: null,
  singerVocalRegister: null,
  pendingPitchSpike: null,
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
  loadAppSettings();
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

  // Catalog loaded in background for instant lookups
  await loadUltraStarCatalog();
});

window.onYouTubeIframeAPIReady = function () {
  state.ytReady = true;
};

window.onSpotifyWebPlaybackSDKReady = function () {
  if (state.spotifyAccessToken) {
    initSpotifyWebPlayer();
  }
};

function loadAppSettings() {
  try {
    const raw = localStorage.getItem('sing_app_settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      state.settings = { ...DEFAULT_SETTINGS, ...parsed };
      if (!parsed.stageLayout) {
        state.settings.stageLayout = 'backdrop';
      }
      if (!parsed.backdropHighwayHeight) {
        state.settings.backdropHighwayHeight = '100';
      }
    } else {
      state.settings = { ...DEFAULT_SETTINGS };
      if (localStorage.getItem('sing_theater_mode') === '1') {
        state.settings.theaterMode = true;
        state.settings.stageLayout = 'theater';
      }
    }
  } catch (err) {
    console.warn('Could not parse saved app settings, using defaults:', err);
    state.settings = { ...DEFAULT_SETTINGS };
  }
  applySettings(state.settings, false);
}

function saveAppSettings() {
  try {
    localStorage.setItem('sing_app_settings', JSON.stringify(state.settings));
    localStorage.setItem('sing_theater_mode', state.settings.theaterMode ? '1' : '0');
  } catch (err) {
    console.warn('Failed to save settings to localStorage:', err);
  }
}

function updateMicMonitoring() {
  if (!state.audioCtx || !state.micSource) return;
  if (!state.micMonitorGain) {
    try {
      state.micMonitorGain = state.audioCtx.createGain();
      state.micMonitorGain.connect(state.audioCtx.destination);
      state.micSource.connect(state.micMonitorGain);
    } catch (e) {
      console.warn('Could not wire mic monitoring:', e);
      return;
    }
  }
  const gain = state.settings.micMonitoring ? (state.settings.micMonitorVolume / 100) : 0;
  try {
    state.micMonitorGain.gain.setTargetAtTime(gain, state.audioCtx.currentTime, 0.05);
  } catch (_) {
    state.micMonitorGain.gain.value = gain;
  }
}

function applySettings(newSettings, shouldSave = true) {
  if (newSettings && typeof newSettings === 'object') {
    state.settings = { ...state.settings, ...newSettings };
  }
  const s = state.settings;

  // 1. Reactive DOM classes
  document.body.classList.toggle('hide-lyrics-ribbon', !s.showLyricsRibbon);
  document.body.classList.toggle('hide-pitch-badges', !s.showPitchBadges);
  document.body.classList.toggle('hide-score-hud', !s.showScoreHUD);

  // 2. Highway canvas height adjustment
  const canvas = document.getElementById('pitchCanvas');
  if (canvas) {
    const dpr = window.devicePixelRatio || 1;
    const targetH = !s.showLyricsRibbon ? 460 : 360;
    const targetPixelH = Math.round(targetH * dpr);
    if (canvas.height !== targetPixelH) {
      canvas.height = targetPixelH;
    }
  }

  // 3. State sync
  state.latencyMs = s.latencyMs;
  state.noiseGatePercent = s.noiseGate;
  state.difficultyTolerance = s.difficulty;
  state.octaveAgnostic = s.octaveAgnostic;
  state.theaterMode = s.theaterMode;

  // 4. Stage Layout & Theater Mode sync
  const layout = s.stageLayout || (s.theaterMode ? 'theater' : 'split');
  setStageLayout(layout, false);

  // 5. Sync Form Controls in UI
  const setChecked = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(val);
  };
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setChecked('toggleShowLyricsRibbon', s.showLyricsRibbon);
  setChecked('toggleShowSyllablesOnNotes', s.showSyllablesOnNotes);
  setChecked('toggleShowLiveVoiceOrb', s.showLiveVoiceOrb);
  setChecked('toggleShowPitchBadges', s.showPitchBadges);
  setChecked('toggleShowScoreHUD', s.showScoreHUD);
  setChecked('toggleTheaterMode', s.theaterMode);

  setVal('selectStageLayout', layout);
  setVal('selectBackdropHighwayHeight', s.backdropHighwayHeight || '33');
  const rowBackdropHeight = document.getElementById('rowBackdropHighwayHeight');
  if (rowBackdropHeight) {
    rowBackdropHeight.style.display = (layout === 'backdrop') ? 'flex' : 'none';
  }

  const opacityVal = typeof s.highwayBackdropOpacity === 'number' ? s.highwayBackdropOpacity : 65;
  document.documentElement.style.setProperty('--highway-backdrop-opacity', (opacityVal / 100).toFixed(2));
  const isHighwayBlur = s.highwayBackdropBlur !== false;
  document.documentElement.style.setProperty('--highway-backdrop-blur', isHighwayBlur ? '8px' : '0px');
  setVal('sliderHighwayOpacity', opacityVal);
  setText('lblHighwayOpacityVal', `${opacityVal}%`);
  setChecked('toggleHighwayBlur', isHighwayBlur);

  const playheadCol = s.playheadColor || 'cyan';
  setVal('selectPlayheadColor', playheadCol);

  setVal('sliderGuideVocalsVol', s.guideVocalsVolume);
  setText('lblGuideVocalsVol', s.guideVocalsVolume);
  setVal('sliderGuideVocals', s.guideVocalsVolume);
  setText('lblGuideVocalsVal', `${s.guideVocalsVolume}%`);
  setVal('sliderMasterVolume', s.masterVolume);
  setText('lblMasterVolume', s.masterVolume);

  if (state.stemMixer) {
    state.stemMixer.setGuideVocalsVolume(s.guideVocalsVolume);
    state.stemMixer.setMasterVolume(s.masterVolume);
  }

  setVal('sliderLatency', s.latencyMs);
  setText('lblLatencyMs', s.latencyMs);
  setText('topLatencyVal', s.latencyMs);

  setVal('sliderGate', s.noiseGate);
  setText('lblGateVal', s.noiseGate);

  setChecked('toggleMicMonitoring', s.micMonitoring);
  setVal('sliderMicMonitorVol', s.micMonitorVolume);
  setText('lblMicMonitorVol', s.micMonitorVolume);
  const rowMonitorVol = document.getElementById('rowMicMonitorVol');
  if (rowMonitorVol) {
    rowMonitorVol.style.display = s.micMonitoring ? 'flex' : 'none';
  }

  setChecked('toggleOctaveAgnostic', s.octaveAgnostic);
  setChecked('chkOctaveAgnostic', s.octaveAgnostic);

  setVal('selectSettingsDifficulty', String(s.difficulty));
  setVal('selectDifficulty', String(s.difficulty));

  // 6. Mic Monitoring gain update
  updateMicMonitoring();

  // 7. Persist
  if (shouldSave) {
    saveAppSettings();
  }
}

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
      subEl.textContent = `${state.ultraStarCatalog.length} songs ready`;
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
        subEl.textContent = `${state.ultraStarCatalog.length} songs loaded`;
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
    document.getElementById('btnCopyRedirectUri').textContent = '✓ Copied!';
    setTimeout(() => {
      document.getElementById('btnCopyRedirectUri').textContent = 'Copy';
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

  // Stage Chart Editor Button
  const btnOpenChartEditor = document.getElementById('btnOpenChartEditor');
  if (btnOpenChartEditor) {
    btnOpenChartEditor.addEventListener('click', () => {
      openChartEditorFromStage();
    });
  }

  // Duet Track Selector
  document.getElementById('selectDuetTrack').addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10) || 0;
    activateDuetTrack(idx);
  });

  // Mic Toggle
  document.getElementById('btnToggleMic').addEventListener('click', toggleMicrophone);

  // Settings Modal Open/Close
  const modalSettings = document.getElementById('modalSettings');
  document.getElementById('btnOpenSettings').addEventListener('click', async () => {
    modalSettings.classList.remove('hidden');
    if (!state.micActive) {
      await startMicrophone(state.selectedDeviceId);
    }
    await populateAudioDevices();
    applySettings(state.settings, false);
  });
  document.getElementById('btnCloseSettings').addEventListener('click', () => modalSettings.classList.add('hidden'));
  document.getElementById('btnSaveSettings').addEventListener('click', () => modalSettings.classList.add('hidden'));

  // Settings Tabs Navigation
  const tabBtns = document.querySelectorAll('.settings-tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      tabBtns.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      document.querySelectorAll('.settings-tab-panel').forEach((panel) => {
        const isActive = panel.id === targetId;
        panel.classList.toggle('hidden', !isActive);
        panel.classList.toggle('active', isActive);
      });
    });
  });

  // Helper for boolean toggle binding
  const bindCheckToggle = (id, settingKey) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', (e) => {
        applySettings({ [settingKey]: e.target.checked });
      });
    }
  };

  // Tab 1: Display & HUD Toggles
  bindCheckToggle('toggleShowLyricsRibbon', 'showLyricsRibbon');
  bindCheckToggle('toggleShowSyllablesOnNotes', 'showSyllablesOnNotes');
  bindCheckToggle('toggleShowLiveVoiceOrb', 'showLiveVoiceOrb');
  bindCheckToggle('toggleShowPitchBadges', 'showPitchBadges');
  bindCheckToggle('toggleShowScoreHUD', 'showScoreHUD');
  bindCheckToggle('toggleTheaterMode', 'theaterMode');

  const selLayout = document.getElementById('selectStageLayout');
  if (selLayout) {
    selLayout.addEventListener('change', (e) => {
      setStageLayout(e.target.value, true);
    });
  }

  const selHeight = document.getElementById('selectBackdropHighwayHeight');
  if (selHeight) {
    selHeight.addEventListener('change', (e) => {
      applySettings({ backdropHighwayHeight: e.target.value });
      const arena = document.getElementById('stageArena');
      if (arena) arena.setAttribute('data-overlay-height', e.target.value);
    });
  }

  const sliderHighwayOpacity = document.getElementById('sliderHighwayOpacity');
  if (sliderHighwayOpacity) {
    sliderHighwayOpacity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      applySettings({ highwayBackdropOpacity: val });
    });
  }

  const toggleHighwayBlur = document.getElementById('toggleHighwayBlur');
  if (toggleHighwayBlur) {
    toggleHighwayBlur.addEventListener('change', (e) => {
      applySettings({ highwayBackdropBlur: e.target.checked });
    });
  }

  const selPlayheadColor = document.getElementById('selectPlayheadColor');
  if (selPlayheadColor) {
    selPlayheadColor.addEventListener('change', (e) => {
      applySettings({ playheadColor: e.target.value });
    });
  }

  // Tab 2: Audio & Stems
  const sliderGuide = document.getElementById('sliderGuideVocalsVol');
  if (sliderGuide) {
    sliderGuide.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      applySettings({ guideVocalsVolume: val });
    });
  }

  // Docked Stage Guide Vocals Slider (Phase 3)
  const sliderStageGuide = document.getElementById('sliderGuideVocals');
  if (sliderStageGuide) {
    sliderStageGuide.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      applySettings({ guideVocalsVolume: val });
    });
  }

  const sliderMaster = document.getElementById('sliderMasterVolume');
  if (sliderMaster) {
    sliderMaster.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      const lbl = document.getElementById('lblMasterVolume');
      if (lbl) lbl.textContent = val;
      applySettings({ masterVolume: val });
    });
  }

  document.getElementById('sliderLatency').addEventListener('input', (e) => {
    setLatencyMs(parseInt(e.target.value, 10));
  });

  document.getElementById('btnRunCalibration').addEventListener('click', runInteractiveLatencyCalibration);

  // Tab 3: Microphone & Monitoring
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

  document.getElementById('sliderGate').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    const lbl = document.getElementById('lblGateVal');
    if (lbl) lbl.textContent = val;
    applySettings({ noiseGate: val });
  });

  bindCheckToggle('toggleMicMonitoring', 'micMonitoring');

  const sliderMicMon = document.getElementById('sliderMicMonitorVol');
  if (sliderMicMon) {
    sliderMicMon.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      const lbl = document.getElementById('lblMicMonitorVol');
      if (lbl) lbl.textContent = val;
      applySettings({ micMonitorVolume: val });
    });
  }

  bindCheckToggle('toggleOctaveAgnostic', 'octaveAgnostic');

  const selDifficulty = document.getElementById('selectSettingsDifficulty');
  if (selDifficulty) {
    selDifficulty.addEventListener('change', (e) => {
      applySettings({ difficulty: parseFloat(e.target.value) });
    });
  }

  // Single Unified Spotlight Input & Resolver
  const formResolve = document.getElementById('formResolve');
  const inputResolve = document.getElementById('inputResolve');
  if (formResolve && inputResolve) {
    formResolve.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = inputResolve.value.trim();
      if (val) await handleResolveQuery(val);
    });

    inputResolve.addEventListener('paste', () => {
      setTimeout(() => {
        const val = inputResolve.value.trim();
        if (val && /(?:youtube\.com|youtu\.be|spotify\.com)/i.test(val)) {
          handleResolveQuery(val);
        }
      }, 50);
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
      state.customLyricsText = null;
      document.getElementById('badgeCustomLyricsActive')?.classList.add('hidden');
    });
  }

  // Phase 5: Manual Lyrics Override Modal Wiring
  const btnOpenPasteLyrics = document.getElementById('btnOpenPasteLyrics');
  const modalPasteLyrics = document.getElementById('modalPasteLyrics');
  const textareaPasteLyrics = document.getElementById('textareaPasteLyrics');
  const btnClosePasteLyrics = document.getElementById('btnClosePasteLyrics');
  const btnClearCustomLyrics = document.getElementById('btnClearCustomLyrics');
  const btnSaveCustomLyrics = document.getElementById('btnSaveCustomLyrics');
  const badgeCustomLyrics = document.getElementById('badgeCustomLyricsActive');

  function closePasteLyricsModal() {
    if (modalPasteLyrics) modalPasteLyrics.classList.add('hidden');
  }

  if (btnOpenPasteLyrics && modalPasteLyrics) {
    btnOpenPasteLyrics.addEventListener('click', () => {
      if (textareaPasteLyrics) {
        textareaPasteLyrics.value = state.customLyricsText || '';
      }
      modalPasteLyrics.classList.remove('hidden');
      if (textareaPasteLyrics) {
        setTimeout(() => textareaPasteLyrics.focus(), 50);
      }
    });
  }

  if (btnClosePasteLyrics) {
    btnClosePasteLyrics.addEventListener('click', closePasteLyricsModal);
  }

  if (modalPasteLyrics) {
    modalPasteLyrics.addEventListener('click', (e) => {
      if (e.target === modalPasteLyrics) closePasteLyricsModal();
    });
  }

  if (btnClearCustomLyrics) {
    btnClearCustomLyrics.addEventListener('click', () => {
      if (textareaPasteLyrics) textareaPasteLyrics.value = '';
      state.customLyricsText = null;
      if (badgeCustomLyrics) badgeCustomLyrics.classList.add('hidden');
      updateStartBtnLabel();
      closePasteLyricsModal();
      showToast('Eigener Songtext zurückgesetzt', 'info');
    });
  }

  if (btnSaveCustomLyrics) {
    btnSaveCustomLyrics.addEventListener('click', () => {
      const val = textareaPasteLyrics ? textareaPasteLyrics.value.trim() : '';
      if (val) {
        state.customLyricsText = val;
        if (badgeCustomLyrics) badgeCustomLyrics.classList.remove('hidden');
        const lines = val.split('\n').filter((l) => l.trim().length > 0);
        showToast(`Songtext übernommen (${lines.length} Zeilen)!`, 'success');
      } else {
        state.customLyricsText = null;
        if (badgeCustomLyrics) badgeCustomLyrics.classList.add('hidden');
        showToast('Eigener Songtext entfernt', 'info');
      }
      updateStartBtnLabel();
      closePasteLyricsModal();
    });
  }

  const btnStartGeneration = document.getElementById('btnStartGeneration');
  if (btnStartGeneration) {
    btnStartGeneration.addEventListener('click', () => handleStartSongAction());
  }

  const btnSeparateVocals = document.getElementById('btnSeparateVocals');
  if (btnSeparateVocals) {
    btnSeparateVocals.addEventListener('click', () => handleStartSongAction({ forceSeparation: true, forceJob: true }));
  }

  const btnUpgradeLyrics = document.getElementById('btnUpgradeLyrics');
  if (btnUpgradeLyrics) {
    btnUpgradeLyrics.addEventListener('click', () => handleStartSongAction({ upgradeLyrics: true }));
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
      document.getElementById('genProgressCard')?.classList.add('hidden');
      if (state.lastGeneratedSong) {
        if (state.lastGeneratedSong.isDirectSession) {
          startSongSession(state.lastGeneratedSong);
        } else {
          playLibrarySong(state.lastGeneratedSong);
        }
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
    applySettings({ difficulty: parseFloat(e.target.value) });
  });

  document.getElementById('chkPitchMagnet').addEventListener('change', (e) => {
    state.pitchMagnet = e.target.checked;
  });

  document.getElementById('chkOctaveAgnostic').addEventListener('change', (e) => {
    applySettings({ octaveAgnostic: e.target.checked });
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

  const btnToggleTheater = document.getElementById('btnToggleTheater');
  if (btnToggleTheater) {
    btnToggleTheater.addEventListener('click', () => {
      const current = state.settings.stageLayout || (state.settings.theaterMode ? 'theater' : 'split');
      let next = 'backdrop';
      if (current === 'split') next = 'backdrop';
      else if (current === 'backdrop') next = 'theater';
      else next = 'split';
      setStageLayout(next, true);
      const names = { split: 'Split Stage', backdrop: 'Video Backdrop', theater: 'Highway Theater' };
      showToast(`Layout: ${names[next]}`, 'info', 1800);
    });
  }

  const btnToggleFullscreen = document.getElementById('btnToggleFullscreen');
  if (btnToggleFullscreen) {
    btnToggleFullscreen.addEventListener('click', toggleFullscreen);
  }
  const btnTopFullscreen = document.getElementById('btnTopFullscreen');
  if (btnTopFullscreen) {
    btnTopFullscreen.addEventListener('click', toggleFullscreen);
  }

  const handleFsChange = () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    const isFs = Boolean(fsEl);
    const stageView = document.getElementById('viewStage');
    if (stageView) stageView.classList.toggle('is-fullscreen', isFs);
    if (btnToggleFullscreen) {
      btnToggleFullscreen.textContent = isFs ? '⤡' : '⛶';
      btnToggleFullscreen.title = isFs ? 'Exit Fullscreen (F)' : 'Toggle Fullscreen (F)';
    }
    if (btnTopFullscreen) {
      btnTopFullscreen.textContent = isFs ? '⤡ Exit Fullscreen' : '⛶ Fullscreen';
    }
    window.dispatchEvent(new Event('resize'));
  };

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach((evt) => {
    document.addEventListener(evt, handleFsChange);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
      const stageActive = document.getElementById('viewStage')?.classList.contains('active');
      if (stageActive) {
        e.preventDefault();
        toggleFullscreen();
      }
    }
  });

  if (localStorage.getItem('sing_theater_mode') === '1') {
    toggleTheaterMode(true);
  }

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

  initChartEditor();
  initCalibrationWizard();
}

function setLatencyMs(ms) {
  state.latencyMs = Math.max(-100, Math.min(450, ms));
  state.settings.latencyMs = state.latencyMs;
  saveAppSettings();
  const slider = document.getElementById('sliderLatency');
  if (slider) slider.value = state.latencyMs;
  const lbl = document.getElementById('lblLatencyMs');
  if (lbl) lbl.textContent = state.latencyMs;
  const top = document.getElementById('topLatencyVal');
  if (top) top.textContent = state.latencyMs;
  const modalLbl = document.getElementById('calModalCurrentLatency');
  if (modalLbl) modalLbl.textContent = `${state.latencyMs} ms`;
}

function setVideoOffset(sec) {
  state.videoOffsetSec = Math.round(sec * 100) / 100;
  const sign = state.videoOffsetSec > 0 ? '+' : '';
  const lbl = document.getElementById('lblVideoOffset');
  if (lbl) lbl.textContent = `${sign}${state.videoOffsetSec.toFixed(2)}s`;

  if (state.playbackSource === 'local' && state.stemMixer && state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
    const expectedYtTime = state.stemMixer.getCurrentTime() + state.videoOffsetSec;
    if (expectedYtTime >= 0) {
      try {
        state.ytPlayer.seekTo(expectedYtTime, true);
      } catch (_) {}
    }
  }
}

function setStageLayout(layout, updateSettings = true) {
  const arena = document.getElementById('stageArena');
  const btn = document.getElementById('btnToggleTheater');
  const toggle = document.getElementById('toggleTheaterMode');
  const selectLayout = document.getElementById('selectStageLayout');
  const selectHeight = document.getElementById('selectBackdropHighwayHeight');
  const rowHeight = document.getElementById('rowBackdropHighwayHeight');

  if (!arena) return;

  const validLayout = ['split', 'backdrop', 'theater'].includes(layout) ? layout : 'split';
  state.settings.stageLayout = validLayout;
  state.settings.theaterMode = (validLayout === 'theater');
  state.theaterMode = (validLayout === 'theater');

  arena.classList.toggle('theater-mode', validLayout === 'theater');
  document.body.classList.toggle('theater-mode', validLayout === 'theater');

  arena.classList.toggle('mode-video-backdrop', validLayout === 'backdrop');
  document.body.classList.toggle('mode-video-backdrop', validLayout === 'backdrop');

  const overlayH = state.settings.backdropHighwayHeight || '33';
  arena.setAttribute('data-overlay-height', overlayH);

  if (btn) {
    btn.classList.toggle('active', validLayout !== 'split');
    const icons = { split: '⤢', backdrop: '🎬', theater: '⤢' };
    const titles = {
      split: 'Current: Split Stage (Click to switch to Video Backdrop)',
      backdrop: 'Current: Video Backdrop (Click to switch to Theater)',
      theater: 'Current: Theater Mode (Click to switch to Split Stage)',
    };
    btn.textContent = icons[validLayout] || '⤢';
    btn.title = titles[validLayout] || 'Switch Stage Layout';
  }

  if (toggle) toggle.checked = (validLayout === 'theater');
  if (selectLayout) selectLayout.value = validLayout;
  if (selectHeight) selectHeight.value = overlayH;
  if (rowHeight) rowHeight.style.display = (validLayout === 'backdrop') ? 'flex' : 'none';

  if (updateSettings) {
    saveAppSettings();
  }
}

function toggleTheaterMode(forceState, updateSettings = true) {
  const arena = document.getElementById('stageArena');
  if (!arena) return;
  const isTheater = forceState !== undefined ? forceState : !arena.classList.contains('theater-mode');
  setStageLayout(isTheater ? 'theater' : 'split', updateSettings);
}

function toggleFullscreen() {
  const stageView = document.getElementById('viewStage');
  if (!stageView) return;

  const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  const isFs = Boolean(fsEl) || stageView.classList.contains('is-fullscreen');
  if (!isFs) {
    const req = stageView.requestFullscreen || stageView.webkitRequestFullscreen || stageView.mozRequestFullScreen || stageView.msRequestFullscreen;
    if (req) {
      req.call(stageView).catch(() => {
        stageView.classList.toggle('is-fullscreen');
      });
    } else {
      stageView.classList.toggle('is-fullscreen');
    }
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (fsEl && exit) {
      exit.call(document).catch(() => {});
    }
    stageView.classList.remove('is-fullscreen');
  }
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
    document.getElementById('badgeSyncInfo').textContent = `Studio Sync (${sign}${state.calculatedStudioOffset.toFixed(2)}s)`;
    return;
  }

  if (state.studioFirstLyricTime !== null && state.firstLyricTime > 0) {
    const studioOffset = state.studioFirstLyricTime - state.firstLyricTime;
    setVideoOffset(studioOffset);
    document.getElementById('btnUseStudioSync').classList.add('active-sync-mode');
    document.getElementById('btnUseOriginalGap').classList.remove('active-sync-mode');
    const sign = studioOffset > 0 ? '+' : '';
    document.getElementById('badgeSyncInfo').textContent = `Studio Start Sync (${sign}${studioOffset.toFixed(2)}s)`;
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
      document.getElementById('badgeSyncInfo').textContent = `Intro Diff Sync (${sign}${approxOffset.toFixed(1)}s)`;
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

  if (state.stemMixer) {
    try { state.stemMixer.pause(); } catch (_) {}
  }
  updateGuideVocalsUI(false);

  state.playbackSource = mode;
  document.getElementById('btnModeYoutube').classList.toggle('active', mode === 'youtube');
  document.getElementById('btnModeSpotify').classList.toggle('active', mode === 'spotify');

  document.getElementById('deckYoutube').classList.toggle('hidden', mode !== 'youtube');
  document.getElementById('deckSpotify').classList.toggle('hidden', mode !== 'spotify');

  if (mode === 'youtube' && state.ytPlayer && typeof state.ytPlayer.unMute === 'function') {
    try { state.ytPlayer.unMute(); } catch (_) {}
  }

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
    showToast('Please enter your Spotify Client ID from the Spotify Developer Dashboard.', 'warning');
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
      showToast('Spotify login failed. Please verify your Client ID and Redirect URI (http://127.0.0.1:3000/).', 'error');
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

  document.getElementById('spotifyTopBadge').textContent = 'Connect';
  document.getElementById('spotifyModalStatus').textContent = 'Status: Disconnected';
  document.getElementById('btnSpotifyLogout').classList.add('hidden');
  switchPlaybackSource('youtube');
}

function initSpotifyWebPlayer() {
  if (!window.Spotify || !window.Spotify.Player || !state.spotifyAccessToken) {
    return;
  }
  if (state.spotifyPlayer) return;

  const statusBox = document.getElementById('spotifyModalStatus');
  statusBox.textContent = 'Connecting to Spotify Premium Web Playback SDK...';

  const player = new window.Spotify.Player({
    name: 'SING! Studio Player',
    getOAuthToken: (cb) => {
      cb(state.spotifyAccessToken);
    },
    volume: 0.85,
  });

  player.addListener('ready', ({ device_id }) => {
    state.spotifyDeviceId = device_id;
    state.spotifyReady = true;
    document.getElementById('spotifyTopBadge').textContent = '✓ Ready';
    document.getElementById('btnSpotifyLogout').classList.remove('hidden');
    statusBox.textContent = '✓ Connected! Your browser is now a Spotify player.';
    document.getElementById('modalSpotify').classList.add('hidden');
    switchPlaybackSource('spotify');
  });

  player.addListener('not_ready', () => {
    state.spotifyReady = false;
    document.getElementById('spotifyTopBadge').textContent = 'Offline';
  });

  player.addListener('authentication_error', ({ message }) => {
    console.warn('Spotify auth error:', message);
    statusBox.textContent = `Token expired or invalid (${message}). Please reconnect.`;
    state.spotifyReady = false;
  });

  player.addListener('account_error', () => {
    statusBox.textContent = 'Error: Spotify Premium is required for Web Playback SDK.';
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
      document.getElementById('resultsHeading').textContent = `No songs found for "${query}"`;
      return;
    }

    document.getElementById('resultsHeading').textContent = `Found songs for "${query}" (${ultraMatches.length} SingStar charts, ${combinedCards.length - ultraMatches.length} auto-sync)`;

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
  if (state.stemMixer) {
    try { state.stemMixer.pause(); } catch (_) {}
  }
  updateGuideVocalsUI(false);
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
    document.getElementById('badgeChartSource').textContent = 'USDB Community Chart';
    document.getElementById('badgeChartSource').className = 'badge badge-gold';
    document.getElementById('badgeSyncInfo').textContent = 'Loading USDB notes...';

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
    document.getElementById('badgeChartSource').textContent = 'UltraStar Score Chart';
    document.getElementById('badgeChartSource').className = 'badge badge-gold';
    document.getElementById('badgeSyncInfo').textContent = 'Loading notes...';

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
  document.getElementById('badgeChartSource').textContent = 'Rhythm Mode (Auto-generated notes)';
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
    trackName: songMeta.trackName || parsed.title || 'Song',
    artistName: songMeta.artistName || parsed.artist || '',
    videoId: songMeta.videoId || parsed.videoId || '',
    duration: songMeta.duration || parsed.duration || 210,
    instrumentalUrl: songMeta.instrumentalUrl || null,
    vocalsUrl: songMeta.vocalsUrl || null,
  };
  state.currentSong = fullSongObj;

  document.getElementById('stageTitle').textContent = fullSongObj.trackName;
  document.getElementById('stageArtist').textContent = fullSongObj.artistName;
  document.getElementById('badgeBpm').textContent = `${state.displayBpm} BPM`;

  const duetSelect = document.getElementById('selectDuetTrack');
  if (parsed.tracks.length > 1) {
    duetSelect.innerHTML = parsed.tracks
      .map((tr, i) => `<option value="${i}">${escapeHtml(tr.name || `Voice ${i + 1}`)}</option>`)
      .join('');
    duetSelect.classList.remove('hidden');
  } else {
    duetSelect.classList.add('hidden');
  }

  activateDuetTrack(0);

  // Calculate studio sync offset by comparing UltraStar lyric lines with synced studio lyrics
  if (typeof songMeta.studioOffsetSec === 'number' && songMeta.studioOffsetSec !== 0) {
    state.calculatedStudioOffset = songMeta.studioOffsetSec;
    setVideoOffset(songMeta.studioOffsetSec);
  } else if (typeof songMeta.videoOffsetSec === 'number' && songMeta.videoOffsetSec !== 0) {
    state.calculatedStudioOffset = songMeta.videoOffsetSec;
    setVideoOffset(songMeta.videoOffsetSec);
  } else {
    state.calculatedStudioOffset = null;
  }
  if (state.calculatedStudioOffset === null && songMeta.syncedLyrics && parsed.tracks[0]?.lines?.length > 0) {
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
  let p1Name = 'Voice 1 (Lead)';
  let p2Name = 'Voice 2 (Duet)';

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
  if (!state.notes || state.notes.length === 0) {
    state.chartMinMidi = 53;
    state.chartMaxMidi = 77;
    state.viewportCenterMidi = 65;
    state.viewportSpanMidi = 24;
    return;
  }
  let minM = 999;
  let maxM = 0;
  for (const n of state.notes) {
    if (!n.isFreestyle && typeof n.midi === 'number') {
      if (n.midi < minM) minM = n.midi;
      if (n.midi > maxM) maxM = n.midi;
    }
  }
  if (minM > maxM) {
    minM = 58;
    maxM = 70;
  }
  // Constant height tailored to each song: highest note + x notes, lowest note - x notes
  const PADDING_NOTES = 3;
  let songMin = minM - PADDING_NOTES;
  let songMax = maxM + PADDING_NOTES;

  // Guarantee comfortable minimum vertical range (at least 14 semitones) so narrow songs don't stretch
  if (songMax - songMin < 14) {
    const mid = (songMin + songMax) / 2;
    songMin = Math.floor(mid - 7);
    songMax = Math.ceil(mid + 7);
  }

  state.chartMinMidi = songMin;
  state.chartMaxMidi = songMax;
  state.viewportCenterMidi = (songMin + songMax) / 2;
  state.viewportSpanMidi = songMax - songMin;
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
    const isMatchingSongVideo = (
      first.isOriginalGap ||
      (originalTxtVideoId && first.videoId === originalTxtVideoId) ||
      (song.videoId && first.videoId === song.videoId) ||
      (song.youtubeId && first.videoId === song.youtubeId) ||
      Boolean(song.instrumentalUrl)
    );

    if (isMatchingSongVideo) {
      setVideoOffset(0);
      document.getElementById('btnUseOriginalGap')?.classList.add('active-sync-mode');
      document.getElementById('btnUseStudioSync')?.classList.remove('active-sync-mode');
      const badgeSync = document.getElementById('badgeSyncInfo');
      if (badgeSync) badgeSync.textContent = '✓ Original Video GAP active';
    } else {
      applyStudioSyncOffset();
    }

    loadYouTubeVideoById(first.videoId);
  } else {
    overlay.textContent = 'Please enter an alternative YouTube URL below.';
  }
}

function loadYouTubeVideoById(videoId) {
  const overlay = document.getElementById('ytOverlayStatus');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.innerHTML = 'Loading video...';
  }
  const videoPanel = document.getElementById('videoPanel');
  if (videoPanel) {
    videoPanel.classList.remove('audio-only-mode');
  }

  if (!state.ytReady || !window.YT || !window.YT.Player) {
    setTimeout(() => loadYouTubeVideoById(videoId), 250);
    return;
  }

  const turnOffSubtitles = () => {
    try {
      if (state.ytPlayer) {
        if (typeof state.ytPlayer.unloadModule === 'function') {
          state.ytPlayer.unloadModule('captions');
          state.ytPlayer.unloadModule('cc');
        }
        if (typeof state.ytPlayer.setOption === 'function') {
          state.ytPlayer.setOption('captions', 'track', {});
          state.ytPlayer.setOption('cc', 'track', {});
          state.ytPlayer.setOption('captions', 'reload', false);
        }
      }
    } catch (_) {}
  };

  if (state.ytPlayer && typeof state.ytPlayer.loadVideoById === 'function') {
    if (state.playbackSource === 'local') {
      try { state.ytPlayer.mute(); } catch (_) {}
    } else {
      try { state.ytPlayer.unMute(); } catch (_) {}
    }
    state.ytPlayer.loadVideoById({ videoId, startSeconds: 0 });
    turnOffSubtitles();
    setTimeout(turnOffSubtitles, 600);
    setTimeout(turnOffSubtitles, 1600);
    return;
  }

  state.ytPlayer = new window.YT.Player('ytPlayerContainer', {
    width: '100%',
    height: '100%',
    videoId,
    playerVars: {
      autoplay: 1,
      controls: 1,
      rel: 0,
      playsinline: 1,
      modestbranding: 1,
      enablejsapi: 1,
      cc_load_policy: 0,
      cc_lang_pref: 'none',
      iv_load_policy: 3,
      origin: window.location.origin,
    },
    events: {
      onReady: () => {
        if (overlay) overlay.classList.add('hidden');
        if (state.playbackSource === 'local') {
          try { state.ytPlayer.mute(); } catch (_) {}
        } else {
          try { state.ytPlayer.unMute(); } catch (_) {}
        }
        state.isPlaying = true;
        turnOffSubtitles();
        setTimeout(turnOffSubtitles, 600);
        setTimeout(turnOffSubtitles, 1600);
      },
      onStateChange: (ev) => {
        if (state.playbackSource === 'youtube') {
          state.isPlaying = ev.data === window.YT.PlayerState.PLAYING;
        } else if (state.playbackSource === 'local') {
          if (ev.data === window.YT.PlayerState.PLAYING) {
            try { state.ytPlayer.mute(); } catch (_) {}
          }
        }
        if (ev.data === window.YT.PlayerState.PLAYING) {
          turnOffSubtitles();
        }
      },
      onError: (errEv) => {
        // Error 100 (not found), 101 / 150 (VEVO / owner blocks iframe embedding!)
        console.warn('YouTube Embed Error code:', errEv.data, '-> switching to next available video or audio fallback!');
        handleYouTubeEmbedFallback(errEv.data);
      },
    },
  });
}

async function handleYouTubeEmbedFallback(errorCode) {
  state.failedVideoIds = state.failedVideoIds || new Set();
  const currentVid = state.ytVideoList?.[state.ytCurrentIndex]?.videoId || state.currentSong?.youtubeId;
  if (currentVid) {
    state.failedVideoIds.add(currentVid);
  }

  // 1. Try next untried video candidate in state.ytVideoList (e.g. lyric or audio version)
  while (state.ytCurrentIndex + 1 < state.ytVideoList.length) {
    state.ytCurrentIndex++;
    const nextVid = state.ytVideoList[state.ytCurrentIndex];
    if (nextVid && nextVid.videoId && !state.failedVideoIds.has(nextVid.videoId)) {
      const selectEl = document.getElementById('selectYtVideo');
      if (selectEl) selectEl.value = nextVid.videoId;

      const isLyricOrAudio = /lyric|audio/i.test(nextVid.title || '');
      showToast(
        isLyricOrAudio
          ? 'Video restricted by label – Switching to lyric video.'
          : 'Video restricted by label – Trying alternate version.',
        'warning',
        4000
      );

      const badgeSync = document.getElementById('badgeSyncInfo');
      if (badgeSync) {
        badgeSync.textContent = '↻ Video restricted – Switching to Lyric/Audio version';
      }
      if (nextVid.isOriginalGap) {
        setVideoOffset(0);
        document.getElementById('btnUseOriginalGap')?.classList.add('active-sync-mode');
        document.getElementById('btnUseStudioSync')?.classList.remove('active-sync-mode');
      } else {
        applyStudioSyncOffset();
      }
      loadYouTubeVideoById(nextVid.videoId);
      return;
    }
  }

  // 2. Deadlink Auto-Recovery (Phase 1.2):
  // When Error 150 (embedding restricted), 101, or 100 triggers and list is exhausted,
  // query /api/youtube?q=${artist}+${title}+Official+Audio with duration matching (+- 5s)
  const song = state.currentSong;
  const artist = song?.artist || song?.artistName || '';
  const title = song?.title || song?.trackName || '';
  const durationSec = song?.durationSec || song?.duration || 0;

  if ((artist || title) && !state._isRecoveringDeadlink) {
    state._isRecoveringDeadlink = true;
    showToast(`Video restricted (Error ${errorCode}) – Auto-recovering official audio stream...`, 'warning', 4500);
    const badgeSync = document.getElementById('badgeSyncInfo');
    if (badgeSync) {
      badgeSync.textContent = '↻ Auto-recovering stream...';
    }

    try {
      const q = `${artist} ${title} Official Audio`.trim();
      const res = await fetch(`/api/youtube?q=${encodeURIComponent(q)}&duration=${encodeURIComponent(durationSec)}`);
      if (res.ok) {
        const data = await res.json();
        const videos = Array.isArray(data.videos) ? data.videos : [];
        const untried = videos.filter((v) => v && v.videoId && !state.failedVideoIds.has(v.videoId));

        if (untried.length > 0) {
          // Duration matching: tolerance +- 5 seconds
          const durationMatched = durationSec > 0
            ? untried.filter((v) => Math.abs((v.durationSec || 0) - durationSec) <= 5)
            : untried;

          const chosen = durationMatched.length > 0 ? durationMatched[0] : untried[0];

          // Append to state.ytVideoList
          state.ytVideoList.push({
            videoId: chosen.videoId,
            title: chosen.title,
            channel: chosen.channel,
            durationText: chosen.durationText,
            isOriginalGap: false,
          });
          state.ytCurrentIndex = state.ytVideoList.length - 1;

          // Update select dropdown
          const selectEl = document.getElementById('selectYtVideo');
          if (selectEl) {
            const opt = document.createElement('option');
            opt.value = chosen.videoId;
            opt.textContent = `★ ${chosen.title} (${chosen.durationText || 'recovered'})`;
            selectEl.appendChild(opt);
            selectEl.value = chosen.videoId;
          }

          // If song is a saved library track, persist to meta.json
          if (song?.slug) {
            fetch(`/api/library/${encodeURIComponent(song.slug)}/video`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId: chosen.videoId }),
            }).catch((err) => console.warn('Failed to update meta.json videoId:', err));
            song.youtubeId = chosen.videoId;
          }

          showToast(`Recovered alternative stream: ${chosen.title}`, 'success', 4000);
          state._isRecoveringDeadlink = false;
          loadYouTubeVideoById(chosen.videoId);
          return;
        }
      }
    } catch (recErr) {
      console.warn('Deadlink auto-recovery failed:', recErr);
    } finally {
      state._isRecoveringDeadlink = false;
    }
  }

  // 3. Check if local audio stems exist in currentSong or active stemMixer / localAudio
  const hasLocalStems = Boolean(
    (state.playbackSource === 'local' && (state.stemMixer?.hasInstrumental || state.localAudio)) ||
    (song && (song.instrumentalUrl || song.audioUrl))
  );

  if (hasLocalStems) {
    if (state.playbackSource !== 'local' && song) {
      const inst = song.instrumentalUrl || song.audioUrl;
      setupLocalStemsAudio(inst, song.vocalsUrl || null);
    }
    enableAudioOnlyStageMode();
    showToast('Video restricted by label – Playing studio audio.', 'info', 4500);
    return;
  }

  // 4. Fallback when neither alternative video nor local stems exist
  const overlay = document.getElementById('ytOverlayStatus');
  if (overlay) {
    overlay.textContent = 'This video blocks embedding. Please choose another version or paste an alternative link.';
    overlay.classList.remove('hidden');
  }
  showToast('Video restricted by label and no local audio is available.', 'warning', 4500);
}

function enableAudioOnlyStageMode() {
  const overlay = document.getElementById('ytOverlayStatus');
  const videoPanel = document.getElementById('videoPanel');
  if (videoPanel) {
    videoPanel.classList.add('audio-only-mode');
  }

  const coverUrl =
    state.currentSong?.artworkUrl ||
    state.currentSong?.coverUrl ||
    document.getElementById('stageCover')?.src ||
    '';
  const title = state.currentSong?.trackName || state.currentSong?.title || 'Studio Audio';
  const artist = state.currentSong?.artistName || state.currentSong?.artist || 'Unknown Artist';

  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
      <div class="audio-only-backdrop" style="background-image: url('${escapeHtml(coverUrl)}')">
        <div class="audio-only-card">
          ${coverUrl ? `<img src="${escapeHtml(coverUrl)}" class="audio-only-art" alt="Cover" />` : ''}
          <div class="audio-only-meta">
            <span class="audio-only-badge">🎙️ Studio Audio Mode</span>
            <h3 class="audio-only-title">${escapeHtml(title)}</h3>
            <p class="audio-only-artist">${escapeHtml(artist)}</p>
          </div>
        </div>
      </div>
    `;
  }

  // Ensure stems playback is unpaused and running
  if (state.stemMixer) {
    if (state.stemMixer.isPaused()) {
      state.stemMixer.play().catch(() => {});
    }
  } else if (state.localAudio) {
    if (state.localAudio.paused) {
      state.localAudio.play().catch(() => {});
    }
  }
  state.isPlaying = true;
}

/* ============================================================================
 * 6.5 DUAL-STEM AUDIO ENGINE (Web Audio API Instrumental + Guide Vocals)
 * ============================================================================ */
class StemMixer {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.instAudio = new Audio();
    this.vocalAudio = new Audio();
    this.instAudio.preload = 'auto';
    this.vocalAudio.preload = 'auto';

    // Allow cross-origin audio streaming
    this.instAudio.crossOrigin = 'anonymous';
    this.vocalAudio.crossOrigin = 'anonymous';

    this.instSource = this.ctx.createMediaElementSource(this.instAudio);
    this.vocalSource = this.ctx.createMediaElementSource(this.vocalAudio);

    this.instGain = this.ctx.createGain();
    this.vocalGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();

    this.instSource.connect(this.instGain).connect(this.masterGain);
    this.vocalSource.connect(this.vocalGain).connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.guideVocalPercent = typeof state.settings?.guideVocalsVolume === 'number'
      ? state.settings.guideVocalsVolume
      : 35;
    this.masterVolumePercent = typeof state.settings?.masterVolume === 'number'
      ? state.settings.masterVolume
      : 90;
    this.hasVocals = false;
    this.hasInstrumental = false;

    this.updateGains();

    this.instAudio.addEventListener('ended', () => {
      state.isPlaying = false;
      this.pause();
      if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
        try {
          state.ytPlayer.pauseVideo();
        } catch (_) {}
      }
    });

    this.instAudio.addEventListener('pause', () => {
      if (this.hasVocals) {
        try { this.vocalAudio.pause(); } catch (_) {}
      }
    });

    this.instAudio.addEventListener('waiting', () => {
      if (this.hasVocals) {
        try { this.vocalAudio.pause(); } catch (_) {}
      }
    });

    this.instAudio.addEventListener('playing', () => {
      if (this.hasVocals && this.vocalAudio.paused && !this.instAudio.paused) {
        this.vocalAudio.currentTime = this.instAudio.currentTime;
        this.vocalAudio.play().catch(() => {});
      }
    });

    this.instAudio.addEventListener('seeking', () => {
      if (this.hasVocals) {
        try { this.vocalAudio.currentTime = this.instAudio.currentTime; } catch (_) {}
      }
    });

    this.instAudio.addEventListener('seeked', () => {
      if (this.hasVocals) {
        try { this.vocalAudio.currentTime = this.instAudio.currentTime; } catch (_) {}
      }
    });

    this.instAudio.addEventListener('ratechange', () => {
      if (this.hasVocals) {
        try { this.vocalAudio.playbackRate = this.instAudio.playbackRate; } catch (_) {}
      }
    });

    this.instAudio.addEventListener('error', (e) => {
      console.warn('StemMixer instrumental error:', e);
    });

    this.vocalAudio.addEventListener('error', (e) => {
      console.warn('StemMixer vocal stem error:', e);
    });
  }

  load(instrumentalUrl, vocalsUrl = null) {
    this.pause();
    this.instAudio.src = instrumentalUrl || '';
    this.vocalAudio.src = vocalsUrl || '';
    this.hasInstrumental = Boolean(instrumentalUrl);
    this.hasVocals = Boolean(vocalsUrl);

    if (this.hasInstrumental) {
      try { this.instAudio.load(); } catch (_) {}
    }
    if (this.hasVocals) {
      try { this.vocalAudio.load(); } catch (_) {}
    }

    this.updateGains();
  }

  async play() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }

    const promises = [];
    if (this.hasInstrumental && this.instAudio.src) {
      promises.push(
        this.instAudio.play().catch((err) => {
          console.warn('Autoplay instrumental blocked:', err);
        })
      );
    }
    if (this.hasVocals && this.vocalAudio.src) {
      this.vocalAudio.currentTime = this.instAudio.currentTime;
      promises.push(
        this.vocalAudio.play().catch((err) => {
          console.warn('Autoplay vocal stem blocked:', err);
        })
      );
    }
    await Promise.all(promises);
  }

  pause() {
    try {
      this.instAudio.pause();
    } catch (_) {}
    try {
      this.vocalAudio.pause();
    } catch (_) {}
  }

  seek(targetTime) {
    const t = Math.max(0, targetTime);
    try {
      this.instAudio.currentTime = t;
    } catch (_) {}
    if (this.hasVocals) {
      try {
        this.vocalAudio.currentTime = t;
      } catch (_) {}
    }
  }

  getCurrentTime() {
    return this.instAudio.currentTime || 0;
  }

  isPaused() {
    return this.instAudio.paused;
  }

  setGuideVocalsVolume(percent) {
    this.guideVocalPercent = Math.max(0, Math.min(100, Number(percent) || 0));
    this.updateGains();
  }

  setMasterVolume(percent) {
    this.masterVolumePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    this.updateGains();
  }

  updateGains() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const v = this.hasVocals ? (this.guideVocalPercent / 100) : 0;
    const m = (this.masterVolumePercent / 100);
    const rampTime = 0.02; // 20ms click-free crossfade constant

    if (this.vocalGain && this.vocalGain.gain) {
      try {
        if (typeof this.vocalGain.gain.setTargetAtTime === 'function') {
          this.vocalGain.gain.setTargetAtTime(v, now, rampTime);
        } else if (typeof this.vocalGain.gain.setValueAtTime === 'function') {
          this.vocalGain.gain.setValueAtTime(v, now);
        } else {
          this.vocalGain.gain.value = v;
        }
      } catch (_) {
        this.vocalGain.gain.value = v;
      }
    }
    if (this.instGain && this.instGain.gain) {
      try {
        if (typeof this.instGain.gain.setTargetAtTime === 'function') {
          this.instGain.gain.setTargetAtTime(1.0, now, rampTime);
        } else if (typeof this.instGain.gain.setValueAtTime === 'function') {
          this.instGain.gain.setValueAtTime(1.0, now);
        } else {
          this.instGain.gain.value = 1.0;
        }
      } catch (_) {
        this.instGain.gain.value = 1.0;
      }
    }
    if (this.masterGain && this.masterGain.gain) {
      try {
        if (typeof this.masterGain.gain.setTargetAtTime === 'function') {
          this.masterGain.gain.setTargetAtTime(m, now, rampTime);
        } else if (typeof this.masterGain.gain.setValueAtTime === 'function') {
          this.masterGain.gain.setValueAtTime(m, now);
        } else {
          this.masterGain.gain.value = m;
        }
      } catch (_) {
        this.masterGain.gain.value = m;
      }
    }
  }

  syncDrift() {
    if (this.hasVocals && !this.instAudio.paused) {
      if (this.vocalAudio.paused) {
        this.vocalAudio.currentTime = this.instAudio.currentTime;
        this.vocalAudio.play().catch(() => {});
        return;
      }
      const diff = Math.abs(this.vocalAudio.currentTime - this.instAudio.currentTime);
      if (diff > 0.035) {
        this.vocalAudio.currentTime = this.instAudio.currentTime;
      }
    }
  }

  dispose() {
    this.pause();
    try {
      this.instAudio.src = '';
      this.vocalAudio.src = '';
    } catch (_) {}
    this.hasVocals = false;
    this.hasInstrumental = false;
  }
}

function ensureStemMixer() {
  if (state.stemMixer) return state.stemMixer;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    if (!state.audioCtx) {
      state.audioCtx = new AudioContextClass();
    }
    state.stemMixer = new StemMixer(state.audioCtx);
    state.localAudio = state.stemMixer.instAudio; // Backward compatibility
    return state.stemMixer;
  } catch (err) {
    console.warn('Could not initialize StemMixer:', err);
    return null;
  }
}

function updateGuideVocalsUI(hasVocals) {
  const group = document.getElementById('groupGuideVocals');
  const slider = document.getElementById('sliderGuideVocals');
  const val = document.getElementById('lblGuideVocalsVal');
  if (!group || !slider || !val) return;

  if (hasVocals) {
    slider.disabled = false;
    group.classList.remove('disabled');
    group.title = 'Guide Vocals: Balance artist voice with instrumental';
    slider.value = state.settings.guideVocalsVolume;
    val.textContent = `${state.settings.guideVocalsVolume}%`;
  } else {
    slider.disabled = true;
    group.classList.add('disabled');
    group.title = 'Full mix only';
    val.textContent = 'N/A';
  }
}

function setupLocalStemsAudio(instrumentalUrl, vocalsUrl = null) {
  state.playbackSource = 'local';
  setVideoOffset(0); // Exact studio alignment: chart beats generated directly from local stems
  const badgeSync = document.getElementById('badgeSyncInfo');
  if (badgeSync) badgeSync.textContent = '✓ Studio Audio (Zero Offset)';
  document.getElementById('btnUseOriginalGap')?.classList.add('active-sync-mode');
  document.getElementById('btnUseStudioSync')?.classList.remove('active-sync-mode');

  const mixer = ensureStemMixer();

  if (mixer) {
    mixer.load(instrumentalUrl, vocalsUrl);
    state.localAudio = mixer.instAudio;
    updateGuideVocalsUI(Boolean(vocalsUrl));

    if (state.ytPlayer && typeof state.ytPlayer.mute === 'function') {
      try {
        state.ytPlayer.mute();
      } catch (_) {}
    }

    mixer.play().then(() => {
      state.isPlaying = true;
      if (state.ytPlayer && typeof state.ytPlayer.playVideo === 'function') {
        try {
          state.ytPlayer.mute();
          state.ytPlayer.playVideo();
        } catch (_) {}
      }
    }).catch((err) => {
      console.log('Autoplay stems blocked (can be started manually):', err);
    });
  } else {
    // Fallback if Web Audio API is unavailable
    if (state.localAudio) {
      try {
        state.localAudio.pause();
        state.localAudio.src = '';
      } catch (_) {}
    }
    state.localAudio = new Audio(instrumentalUrl);
    updateGuideVocalsUI(false);
    state.localAudio.play().then(() => {
      state.isPlaying = true;
    }).catch(() => {});
  }
}

function setupLocalInstrumentalAudio(audioUrl, vocalsUrl = null) {
  setupLocalStemsAudio(audioUrl, vocalsUrl);
}

/* ============================================================================
 * 7. UNIFIED PLAYBACK TIME & TRANSPORT CONTROLS (YouTube + Spotify)
 * ============================================================================ */
function getRawPlayerTime() {
  if (state.playbackSource === 'local') {
    if (state.stemMixer) {
      return state.stemMixer.getCurrentTime();
    }
    if (state.localAudio) {
      return state.localAudio.currentTime;
    }
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
  if (state.playbackSource === 'local') {
    const isPaused = state.stemMixer
      ? state.stemMixer.isPaused()
      : (state.localAudio ? state.localAudio.paused : true);

    if (isPaused) {
      if (state.stemMixer) {
        state.stemMixer.play().catch(() => {});
      } else if (state.localAudio) {
        state.localAudio.play().catch(() => {});
      }
      if (state.ytPlayer && typeof state.ytPlayer.playVideo === 'function') {
        try {
          state.ytPlayer.mute();
          state.ytPlayer.playVideo();
        } catch (_) {}
      }
      state.isPlaying = true;
    } else {
      if (state.stemMixer) {
        state.stemMixer.pause();
      } else if (state.localAudio) {
        state.localAudio.pause();
      }
      if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
        try {
          state.ytPlayer.pauseVideo();
        } catch (_) {}
      }
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
  if (state.playbackSource === 'local') {
    if (state.stemMixer) {
      state.stemMixer.seek(0);
      state.stemMixer.play().catch(() => {});
    } else if (state.localAudio) {
      state.localAudio.currentTime = 0;
      state.localAudio.play().catch(() => {});
    }
    if (state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
      try {
        state.ytPlayer.mute();
        const startGap = Math.max(0, state.videoOffsetSec || 0);
        state.ytPlayer.seekTo(startGap, true);
        state.ytPlayer.playVideo();
      } catch (_) {}
    }
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

  if (state.playbackSource === 'local') {
    if (state.stemMixer) {
      state.stemMixer.seek(targetSongTime);
      state.stemMixer.play().catch(() => {});
    } else if (state.localAudio) {
      state.localAudio.currentTime = Math.max(0, targetRawTime);
      state.localAudio.play().catch(() => {});
    }
    if (state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
      try {
        state.ytPlayer.mute();
        state.ytPlayer.seekTo(targetRawTime, true);
        state.ytPlayer.playVideo();
      } catch (_) {}
    }
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
  if (state.stemMixer) {
    try {
      state.stemMixer.pause();
    } catch (_) {}
  }
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

    state.micSource = source;
    updateMicMonitoring();

    state.micActive = true;
    document.getElementById('micStatusDot').classList.add('active');
    document.getElementById('micStatusText').textContent = 'Microphone On';
  } catch (err) {
    console.error('Microphone access error:', err);
    showToast('Microphone access was blocked or not found. Please allow microphone permissions in your browser!', 'error');
  }
}

function stopMicrophone() {
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  if (state.micMonitorGain) {
    state.micMonitorGain.gain.value = 0;
  }
  state.micSource = null;
  state.micActive = false;
  document.getElementById('micStatusDot').classList.remove('active');
  document.getElementById('micStatusText').textContent = 'Microphone';
  document.getElementById('topLiveNote').textContent = '--';
}

async function toggleMicrophone() {
  if (!state.micActive) {
    await startMicrophone(state.selectedDeviceId);
    showToast('Microphone active', 'info', 1500);
  } else {
    stopMicrophone();
    showToast('Microphone muted', 'info', 1500);
  }
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
      // Octave jump / doubling correction
      if (Math.abs(diff - 12) < 1.8) stabilizedRaw -= 12;
      else if (Math.abs(diff + 12) < 1.8) stabilizedRaw += 12;

      // 1-frame outlier spike rejection: deviations > 3.5 semitones must be confirmed by the subsequent frame
      const dev = Math.abs(stabilizedRaw - prevMedian);
      if (dev > 3.5) {
        if (state.pendingPitchSpike === null) {
          state.pendingPitchSpike = stabilizedRaw;
          stabilizedRaw = prevMedian;
        } else {
          // If within 2.0 semitones of pending spike, confirm intentional pitch transition
          if (Math.abs(stabilizedRaw - state.pendingPitchSpike) < 2.0) {
            state.pendingPitchSpike = null;
          } else {
            state.pendingPitchSpike = stabilizedRaw;
            stabilizedRaw = prevMedian;
          }
        }
      } else {
        state.pendingPitchSpike = null;
      }
    } else {
      state.pendingPitchSpike = null;
    }

    state.recentRawMidis.push(stabilizedRaw);
    if (state.recentRawMidis.length > 5) state.recentRawMidis.shift();

    const medianMidi = getMedian(state.recentRawMidis);

    state.voicedFrameCount++;
    if (state.silentFrameCount >= 4) {
      state.currentStrokeId++;
      state.smoothedMidi = medianMidi;
      state.lastDisplayedMidi = null;
    } else {
      state.smoothedMidi =
        state.smoothedMidi === null
          ? medianMidi
          : stabilizePitchMidi(medianMidi, state.smoothedMidi, clarity, 0.016);
    }
    state.silentFrameCount = 0;

    // Track singer's vocal register across active singing
    if (state.singerVocalRegister === null) {
      state.singerVocalRegister = state.smoothedMidi;
    } else {
      state.singerVocalRegister = state.singerVocalRegister * 0.95 + state.smoothedMidi * 0.05;
    }

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
  state.pendingPitchSpike = null;
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

// Pre-computed Hann window cache for MPM
let hannWindowCache = null;
let hannWindowCacheN = 0;

function getHannWindow(N) {
  if (hannWindowCache && hannWindowCacheN === N) return hannWindowCache;
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  }
  hannWindowCache = w;
  hannWindowCacheN = N;
  return w;
}

// Adaptive Pitch Stabilizer with Deadband (smooths micro-vibrato, fast on intentional transitions)
function stabilizePitchMidi(newMidi, prevMidi, clarity = 1.0, dt = 0.016) {
  if (prevMidi === null || !Number.isFinite(prevMidi)) return newMidi;

  const delta = newMidi - prevMidi;

  // Deadband for micro-vibrato: if within ±0.32 semitones, damp movement
  if (Math.abs(delta) < 0.32) {
    return prevMidi + delta * 0.18;
  }

  // Intentional pitch transitions: smooth fast transition
  const normDt = Math.max(0.001, Math.min(0.1, dt));
  const alpha = Math.min(1.0, (0.35 + (clarity || 0.8) * 0.4) * (normDt / 0.016));
  return prevMidi + delta * alpha;
}

function detectPitchMPM(buffer, sampleRate) {
  const N = Math.min(buffer.length, 1536);
  const minLag = Math.floor(sampleRate / 1000);
  const maxLag = Math.min(N - 2, Math.floor(sampleRate / 78));
  const win = getHannWindow(N);

  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acf = 0;
    let divisor = 0;
    for (let i = 0; i < N - tau; i++) {
      const w = win[i];
      const a = buffer[i];
      const b = buffer[i + tau];
      acf += w * a * b;
      divisor += w * (a * a + b * b);
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

/* ============================================================================
 * 8. DUAL-MODE LATENCY CALIBRATION & TOAST NOTIFICATION ENGINE (PHASE 6)
 * ============================================================================ */

/**
 * Toast Notification System
 * Non-blocking, glassmorphic toast notification in top-right corner.
 */
function showToast(message, type = 'info', durationMs = 3500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconMap = {
    info: 'ℹ️',
    success: '✓',
    warning: '⚠️',
    error: '✕',
  };
  const icon = iconMap[type] || 'ℹ️';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.textContent = icon;
  const textSpan = document.createElement('span');
  textSpan.className = 'toast-message';
  textSpan.textContent = message;

  toast.appendChild(iconSpan);
  toast.appendChild(textSpan);
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hiding');
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 280);
  }, durationMs);

  return toast;
}

/**
 * Stage Live Offset Quick-Nudge
 * Adjusts latency by deltaMs, clamps to [-100, 450], persists to settings, and notifies via toast.
 */
function nudgeLatency(deltaMs) {
  const newLatency = Math.max(-100, Math.min(450, state.latencyMs + deltaMs));
  setLatencyMs(newLatency);
  showToast(`Latency: ${newLatency > 0 ? '+' : ''}${newLatency}ms`, 'info', 1600);
}

/**
 * Calibration State
 */
const calState = {
  modalOpen: false,
  activeMode: 'chirp', // 'chirp' | 'tap'
  // Chirp calibration
  isChirpRunning: false,
  calibratedChirpMs: null,
  // Metronome Rhythm Tap
  metronomeRunning: false,
  metronomeIntervalMs: 600, // 100 BPM
  metronomeStartTime: 0,
  nextBeatTime: 0,
  metronomeRafId: null,
  taps: [], // Array of offsetMs
  maxTaps: 8,
  calibratedTapMs: null,
};

/**
 * Synthesizes a reference acoustic chirp signal
 * 40ms 1.2 kHz sine burst with fast attack and cosine decay envelope.
 */
function generateChirpSignal(sampleRate = 44100, durationMs = 40, freqHz = 1200) {
  const numSamples = Math.round((durationMs / 1000) * sampleRate);
  const chirp = new Float32Array(numSamples);
  const attackSamples = Math.max(1, Math.round(sampleRate * 0.003)); // 3ms attack

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let envelope = 1.0;
    if (i < attackSamples) {
      envelope = 0.5 * (1 - Math.cos((Math.PI * i) / attackSamples));
    } else {
      const decayProgress = (i - attackSamples) / Math.max(1, numSamples - attackSamples);
      envelope = 0.5 * (1 + Math.cos(Math.PI * decayProgress));
    }
    chirp[i] = Math.sin(2 * Math.PI * freqHz * t) * envelope;
  }
  return chirp;
}

/**
 * Computes cross-correlation between microphone signal and reference chirp.
 * Evaluates lag space with parabolic interpolation for sub-millisecond precision.
 */
function computeCrossCorrelation(signal, reference, minLag = 0, maxLag = null, sampleRate = 44100) {
  const sigLen = signal ? signal.length : 0;
  const refLen = reference ? reference.length : 0;
  if (sigLen === 0 || refLen === 0 || sigLen < refLen) {
    return {
      peakLag: 0,
      peakCorrelation: 0,
      refinedLag: 0,
      refinedLatencyMs: 0,
      confidence: 0,
    };
  }

  const effectiveMaxLag = Math.min(
    sigLen - refLen,
    maxLag !== null ? maxLag : sigLen - refLen
  );
  const effectiveMinLag = Math.max(0, minLag);

  if (effectiveMaxLag < effectiveMinLag) {
    return {
      peakLag: 0,
      peakCorrelation: 0,
      refinedLag: 0,
      refinedLatencyMs: 0,
      confidence: 0,
    };
  }

  // Precompute reference energy
  let refEnergy = 0;
  for (let i = 0; i < refLen; i++) {
    refEnergy += reference[i] * reference[i];
  }
  if (refEnergy <= 1e-12) refEnergy = 1e-12;

  let bestLag = effectiveMinLag;
  let maxCorr = -Infinity;
  const numLags = effectiveMaxLag - effectiveMinLag + 1;
  const corrValues = new Float32Array(numLags);

  for (let lag = effectiveMinLag; lag <= effectiveMaxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < refLen; i++) {
      corr += reference[i] * signal[lag + i];
    }
    corrValues[lag - effectiveMinLag] = corr;
    if (corr > maxCorr) {
      maxCorr = corr;
      bestLag = lag;
    }
  }

  // Compute local signal energy at bestLag for normalized correlation
  let localSigEnergy = 0;
  for (let i = 0; i < refLen; i++) {
    const s = signal[bestLag + i];
    localSigEnergy += s * s;
  }
  const norm = Math.sqrt(refEnergy * (localSigEnergy + 1e-10));
  const normalizedCorr = norm > 0 ? maxCorr / norm : 0;

  // Parabolic interpolation for sub-sample refinement
  let refinedLag = bestLag;
  const bestIdx = bestLag - effectiveMinLag;
  if (bestIdx > 0 && bestIdx < numLags - 1) {
    const alpha = corrValues[bestIdx - 1];
    const beta = corrValues[bestIdx];
    const gamma = corrValues[bestIdx + 1];
    const denom = 2 * (alpha - 2 * beta + gamma);
    if (Math.abs(denom) > 1e-9) {
      const delta = (alpha - gamma) / denom;
      if (Math.abs(delta) <= 1.0) {
        refinedLag = bestLag + delta;
      }
    }
  }

  const refinedLatencyMs = (refinedLag / sampleRate) * 1000;

  return {
    peakLag: bestLag,
    peakCorrelation: maxCorr,
    normalizedCorrelation: Math.max(0, Math.min(1, normalizedCorr)),
    refinedLag: refinedLag,
    refinedLatencyMs: Math.round(refinedLatencyMs * 100) / 100,
    confidence: Math.max(0, Math.min(1, normalizedCorr)),
  };
}

/**
 * Outlier rejection and statistics calculation for Rhythm Tap offsets
 * Discards first 2 warmup taps, computes mean and standard deviation,
 * rejects outliers (> 2 * stdDev), and returns calibrated latency.
 */
function processRhythmTapOffsets(tapOffsets) {
  if (!tapOffsets || tapOffsets.length <= 2) {
    return {
      success: false,
      reason: 'At least 3 taps required (first 2 taps are warmups).',
    };
  }

  // 1. Discard first 2 warmup taps
  const candidateTaps = tapOffsets.slice(2);

  // 2. Calculate mean and standard deviation
  const mean = candidateTaps.reduce((a, b) => a + b, 0) / candidateTaps.length;
  const variance =
    candidateTaps.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
    candidateTaps.length;
  const stdDev = Math.sqrt(variance);

  // 3. Outlier rejection: reject values deviating > max(14, 2 * stdDev)
  const threshold = Math.max(14, 2 * stdDev);
  const validTaps = candidateTaps.filter((val) => Math.abs(val - mean) <= threshold);
  const rejectedCount = candidateTaps.length - validTaps.length;

  const finalMean =
    validTaps.length > 0
      ? validTaps.reduce((a, b) => a + b, 0) / validTaps.length
      : mean;

  const finalLatencyMs = Math.round(finalMean);

  return {
    success: true,
    warmupCount: 2,
    totalTaps: tapOffsets.length,
    candidateCount: candidateTaps.length,
    validCount: validTaps.length,
    rejectedCount,
    mean: Math.round(mean),
    stdDev: Math.round(stdDev * 10) / 10,
    calibratedLatencyMs: Math.max(-100, Math.min(450, finalLatencyMs)),
  };
}

/**
 * Mode 1: Automated Acoustic Loopback Chirp Calibration
 * Plays 3 short audio chirps (40ms, 1.2 kHz) and cross-correlates mic input.
 */
async function runAcousticChirpCalibration() {
  if (calState.isChirpRunning) return;
  calState.isChirpRunning = true;

  const btnStart = document.getElementById('btnStartChirpCal');
  const btnRunOld = document.getElementById('btnRunCalibration');
  const statusEl = document.getElementById('chirpStatusText');
  const progressFill = document.getElementById('chirpProgressFill');
  const resultCard = document.getElementById('chirpResultCard');
  const lblResultMs = document.getElementById('lblChirpResultMs');
  const lblConfidence = document.getElementById('lblChirpConfidence');
  const oldStatusEl = document.getElementById('calibrationStatusText');

  if (btnStart) btnStart.disabled = true;
  if (btnRunOld) btnRunOld.disabled = true;
  if (resultCard) resultCard.classList.add('hidden');

  const setStatus = (txt, pct = 0) => {
    if (statusEl) statusEl.textContent = txt;
    if (oldStatusEl) oldStatusEl.textContent = txt;
    if (progressFill) progressFill.style.width = `${pct}%`;
  };

  const setBadge = (burstNum, stateClass) => {
    const badge = document.getElementById(`chirpBadge${burstNum}`);
    if (!badge) return;
    badge.classList.remove('active', 'done');
    if (stateClass) badge.classList.add(stateClass);
  };

  try {
    if (!state.micActive) {
      setStatus('Requesting microphone access...', 5);
      await startMicrophone(state.selectedDeviceId);
    }
    if (!state.audioCtx || !state.micSource) {
      setStatus('Microphone unavailable. Please grant microphone access.', 0);
      calState.isChirpRunning = false;
      if (btnStart) btnStart.disabled = false;
      if (btnRunOld) btnRunOld.disabled = false;
      return;
    }
    if (state.audioCtx.state === 'suspended') {
      await state.audioCtx.resume();
    }

    const sampleRate = state.audioCtx.sampleRate;
    const durationMs = 40;
    const chirpRef = generateChirpSignal(sampleRate, durationMs, 1200);

    // Create AudioBuffer for output
    const chirpBuffer = state.audioCtx.createBuffer(1, chirpRef.length, sampleRate);
    chirpBuffer.getChannelData(0).set(chirpRef);

    // Setup temporary ScriptProcessorNode for recording
    const scriptNode = state.audioCtx.createScriptProcessor(2048, 1, 1);
    const silentGain = state.audioCtx.createGain();
    silentGain.gain.value = 0;

    const capturedChunks = [];
    let isRecording = false;

    scriptNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      capturedChunks.push(new Float32Array(input));
    };

    state.micSource.connect(scriptNode);
    scriptNode.connect(silentGain);
    silentGain.connect(state.audioCtx.destination);

    // Reset badges
    setBadge(1, null);
    setBadge(2, null);
    setBadge(3, null);

    const detectedDelays = [];

    for (let burst = 1; burst <= 3; burst++) {
      setBadge(burst, 'active');
      setStatus(`Transmitting burst ${burst} / 3 (1.2 kHz acoustic chirp)...`, Math.round((burst - 1) * 33));

      capturedChunks.length = 0;
      isRecording = true;

      // Schedule chirp with 50ms lead time
      const leadSec = 0.05;
      const playTime = state.audioCtx.currentTime + leadSec;
      const chirpSource = state.audioCtx.createBufferSource();
      chirpSource.buffer = chirpBuffer;
      chirpSource.connect(state.audioCtx.destination);
      chirpSource.start(playTime);

      // Record for 450ms after scheduled play time
      await new Promise((r) => setTimeout(r, Math.round((leadSec + 0.45) * 1000)));
      isRecording = false;

      // Flatten recorded samples
      let totalSamples = 0;
      for (const c of capturedChunks) totalSamples += c.length;

      if (totalSamples > chirpRef.length * 2) {
        const flattened = new Float32Array(totalSamples);
        let offset = 0;
        for (const c of capturedChunks) {
          flattened.set(c, offset);
          offset += c.length;
        }

        const expectedLeadSamples = Math.round(leadSec * sampleRate);
        const searchMin = Math.max(0, expectedLeadSamples - Math.round(0.01 * sampleRate));
        const searchMax = Math.min(
          flattened.length - chirpRef.length,
          expectedLeadSamples + Math.round(0.42 * sampleRate)
        );

        const corr = computeCrossCorrelation(flattened, chirpRef, searchMin, searchMax, sampleRate);

        const delaySamples = corr.refinedLag - expectedLeadSamples;
        const delayMs = (delaySamples / sampleRate) * 1000;

        if (corr.confidence >= 0.12 && delayMs >= -30 && delayMs <= 400) {
          detectedDelays.push({ burst, delayMs, confidence: corr.confidence });
        }
      }

      setBadge(burst, 'done');
      await new Promise((r) => setTimeout(r, 320));
    }

    // Clean up temporary nodes
    try {
      state.micSource.disconnect(scriptNode);
      scriptNode.disconnect();
      silentGain.disconnect();
    } catch (_) {}

    if (detectedDelays.length > 0) {
      const sorted = detectedDelays.map((d) => d.delayMs).sort((a, b) => a - b);
      const medianDelay = sorted[Math.floor(sorted.length / 2)];
      const calibratedMs = Math.max(-100, Math.min(450, Math.round(medianDelay)));
      calState.calibratedChirpMs = calibratedMs;

      const variance = sorted.length > 1 ? Math.abs(sorted[sorted.length - 1] - sorted[0]) : 0;
      const confDesc = detectedDelays[0].confidence > 0.35 ? 'High' : 'Moderate';

      if (lblResultMs) lblResultMs.textContent = calibratedMs;
      if (lblConfidence) {
        lblConfidence.textContent = `Consistency: ${confDesc} (±${(variance / 2).toFixed(1)} ms)`;
      }
      if (resultCard) resultCard.classList.remove('hidden');

      setStatus(`✓ Calibration successful! Measured round-trip delay: ${calibratedMs} ms.`, 100);
      showToast(`Acoustic hardware latency: ${calibratedMs}ms`, 'success');
    } else {
      setStatus(
        'No acoustic echo detected. (Headphones plugged in or speakers muted?) Switch to Rhythm Tap mode above!',
        0
      );
      showToast('No acoustic echo detected. Try Rhythm Tap metronome!', 'warning');
    }
  } catch (err) {
    console.error('Acoustic calibration error:', err);
    setStatus('Calibration encountered an error. Please try again.', 0);
  } finally {
    calState.isChirpRunning = false;
    if (btnStart) btnStart.disabled = false;
    if (btnRunOld) btnRunOld.disabled = false;
  }
}

/**
 * Plays a short, crisp audio tick for the metronome
 */
function playMetronomeTick(ctx) {
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.02);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.025);
  } catch (_) {}
}

/**
 * Mode 2: Audio-Visual Rhythm Tap Metronome
 */
function startRhythmTapMetronome() {
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }

  calState.metronomeRunning = true;
  calState.taps = [];
  calState.metronomeStartTime = performance.now();
  calState.nextBeatTime = calState.metronomeStartTime + calState.metronomeIntervalMs;

  const btnTap = document.getElementById('btnTapBeat');
  const btnStart = document.getElementById('btnStartTapCal');
  const liveBadge = document.getElementById('tapLiveBadge');
  const resultCard = document.getElementById('tapResultCard');

  if (btnTap) btnTap.disabled = false;
  if (btnStart) btnStart.textContent = 'Restart Metronome';
  if (liveBadge) liveBadge.textContent = 'Metronome active! Tap Spacebar on the beat (8 taps)...';
  if (resultCard) resultCard.classList.add('hidden');

  // Reset tap dots
  for (let i = 1; i <= 8; i++) {
    const dot = document.querySelector(`.tap-dot[data-tap="${i}"]`);
    if (dot) {
      dot.classList.remove('active', 'recorded', 'rejected');
    }
  }
  const firstDot = document.querySelector('.tap-dot[data-tap="1"]');
  if (firstDot) firstDot.classList.add('active');

  const dotEl = document.getElementById('metronomeDot');
  const flashEl = document.getElementById('metronomeBeatFlash');

  function tickLoop() {
    if (!calState.metronomeRunning) return;

    const now = performance.now();
    const elapsed = now - calState.metronomeStartTime;
    const cyclePhase = (elapsed % calState.metronomeIntervalMs) / calState.metronomeIntervalMs;

    if (dotEl) {
      dotEl.style.left = `${(cyclePhase * 100).toFixed(1)}%`;
    }

    if (now >= calState.nextBeatTime) {
      playMetronomeTick(state.audioCtx);
      if (flashEl) {
        flashEl.classList.add('flash');
        setTimeout(() => flashEl.classList.remove('flash'), 120);
      }
      calState.nextBeatTime += calState.metronomeIntervalMs;
    }

    calState.metronomeRafId = requestAnimationFrame(tickLoop);
  }

  if (calState.metronomeRafId) cancelAnimationFrame(calState.metronomeRafId);
  calState.metronomeRafId = requestAnimationFrame(tickLoop);
}

function stopRhythmTapMetronome() {
  calState.metronomeRunning = false;
  if (calState.metronomeRafId) {
    cancelAnimationFrame(calState.metronomeRafId);
    calState.metronomeRafId = null;
  }
  const btnTap = document.getElementById('btnTapBeat');
  const btnStart = document.getElementById('btnStartTapCal');
  if (btnTap) btnTap.disabled = true;
  if (btnStart) btnStart.textContent = 'Start Metronome';
}

function recordRhythmTap() {
  if (!calState.metronomeRunning) {
    startRhythmTapMetronome();
    return;
  }

  const now = performance.now();
  const timeSinceStart = now - calState.metronomeStartTime;
  const beatNum = Math.round(timeSinceStart / calState.metronomeIntervalMs);
  const closestBeatTime = calState.metronomeStartTime + beatNum * calState.metronomeIntervalMs;
  const offsetMs = now - closestBeatTime;

  calState.taps.push(offsetMs);
  const tapIdx = calState.taps.length;

  const currentDot = document.querySelector(`.tap-dot[data-tap="${tapIdx}"]`);
  if (currentDot) {
    currentDot.classList.remove('active');
    currentDot.classList.add('recorded');
  }
  const nextDot = document.querySelector(`.tap-dot[data-tap="${tapIdx + 1}"]`);
  if (nextDot) {
    nextDot.classList.add('active');
  }

  const sign = offsetMs > 0 ? '+' : '';
  const roundedOffset = Math.round(offsetMs);
  const liveBadge = document.getElementById('tapLiveBadge');

  if (tapIdx <= 2) {
    if (liveBadge) liveBadge.textContent = `Tap ${tapIdx}/8: Warmup tap (${sign}${roundedOffset} ms)`;
  } else {
    if (liveBadge) liveBadge.textContent = `Tap ${tapIdx}/8: Recorded ${sign}${roundedOffset} ms`;
  }

  if (tapIdx >= calState.maxTaps) {
    stopRhythmTapMetronome();
    const stats = processRhythmTapOffsets(calState.taps);

    if (stats.success) {
      calState.calibratedTapMs = stats.calibratedLatencyMs;
      const lblResult = document.getElementById('lblTapResultMs');
      const lblStats = document.getElementById('lblTapStats');
      const resultCard = document.getElementById('tapResultCard');

      if (lblResult) lblResult.textContent = stats.calibratedLatencyMs;
      if (lblStats) {
        lblStats.textContent = `${stats.validCount} valid taps, ${stats.rejectedCount} outliers rejected (σ = ${stats.stdDev} ms)`;
      }
      if (resultCard) resultCard.classList.remove('hidden');
      if (liveBadge) {
        liveBadge.textContent = `✓ Calibration complete: ${stats.calibratedLatencyMs} ms. Click Apply to save.`;
      }
      showToast(`Rhythm tap calibrated: ${stats.calibratedLatencyMs}ms`, 'success');
    }
  }
}

function resetRhythmTapCalibration() {
  stopRhythmTapMetronome();
  calState.taps = [];
  const liveBadge = document.getElementById('tapLiveBadge');
  const resultCard = document.getElementById('tapResultCard');
  if (liveBadge) liveBadge.textContent = 'Press "Start Metronome" to begin';
  if (resultCard) resultCard.classList.add('hidden');
  for (let i = 1; i <= 8; i++) {
    const dot = document.querySelector(`.tap-dot[data-tap="${i}"]`);
    if (dot) dot.classList.remove('active', 'recorded', 'rejected');
  }
}

/**
 * Calibration Modal Navigation & Mode Switching
 */
function openCalibrationModal(mode = 'chirp') {
  const modal = document.getElementById('modalCalibration');
  if (!modal) return;
  modal.classList.remove('hidden');
  calState.modalOpen = true;
  switchCalibrationMode(mode);
  updateCalibrationModalReadout();
}

function closeCalibrationModal() {
  const modal = document.getElementById('modalCalibration');
  if (!modal) return;
  modal.classList.add('hidden');
  calState.modalOpen = false;
  stopRhythmTapMetronome();
}

function switchCalibrationMode(mode) {
  calState.activeMode = mode;

  const tabChirp = document.getElementById('tabBtnChirp');
  const tabTap = document.getElementById('tabBtnTap');
  const panelChirp = document.getElementById('panelChirpCal');
  const panelTap = document.getElementById('panelTapCal');

  if (mode === 'chirp') {
    if (tabChirp) tabChirp.classList.add('active');
    if (tabTap) tabTap.classList.remove('active');
    if (panelChirp) panelChirp.classList.add('active');
    if (panelTap) panelTap.classList.remove('active');
    stopRhythmTapMetronome();
  } else {
    if (tabChirp) tabChirp.classList.remove('active');
    if (tabTap) tabTap.classList.add('active');
    if (panelChirp) panelChirp.classList.remove('active');
    if (panelTap) panelTap.classList.add('active');
  }
}

function updateCalibrationModalReadout() {
  const lbl = document.getElementById('calModalCurrentLatency');
  if (lbl) lbl.textContent = `${state.latencyMs} ms`;
}

/**
 * Legacy API Entry Point (preserves backward compatibility with settings buttons and tests)
 */
async function runInteractiveLatencyCalibration() {
  openCalibrationModal('chirp');
  await runAcousticChirpCalibration();
}

/**
 * Initializes Calibration Wizard UI bindings & Keyboard Shortcuts
 */
function initCalibrationWizard() {
  const btnRun = document.getElementById('btnRunCalibration');
  if (btnRun) {
    btnRun.addEventListener('click', () => openCalibrationModal('chirp'));
  }

  const btnClose = document.getElementById('btnCloseCalibrationModal');
  if (btnClose) btnClose.addEventListener('click', closeCalibrationModal);

  const btnDone = document.getElementById('btnDoneCalibration');
  if (btnDone) btnDone.addEventListener('click', closeCalibrationModal);

  const modalCal = document.getElementById('modalCalibration');
  if (modalCal) {
    modalCal.addEventListener('click', (e) => {
      if (e.target === modalCal) closeCalibrationModal();
    });
  }

  // Tabs
  const tabChirp = document.getElementById('tabBtnChirp');
  if (tabChirp) tabChirp.addEventListener('click', () => switchCalibrationMode('chirp'));

  const tabTap = document.getElementById('tabBtnTap');
  if (tabTap) tabTap.addEventListener('click', () => switchCalibrationMode('tap'));

  // Chirp actions
  const btnStartChirp = document.getElementById('btnStartChirpCal');
  if (btnStartChirp) btnStartChirp.addEventListener('click', runAcousticChirpCalibration);

  const btnApplyChirp = document.getElementById('btnApplyChirpResult');
  if (btnApplyChirp) {
    btnApplyChirp.addEventListener('click', () => {
      if (calState.calibratedChirpMs !== null) {
        setLatencyMs(calState.calibratedChirpMs);
        showToast(`Latency updated to ${calState.calibratedChirpMs}ms!`, 'success');
      }
    });
  }

  // Metronome tap actions
  const btnStartTap = document.getElementById('btnStartTapCal');
  if (btnStartTap) btnStartTap.addEventListener('click', startRhythmTapMetronome);

  const btnTap = document.getElementById('btnTapBeat');
  if (btnTap) btnTap.addEventListener('click', recordRhythmTap);

  const btnResetTap = document.getElementById('btnResetTapCal');
  if (btnResetTap) btnResetTap.addEventListener('click', resetRhythmTapCalibration);

  const btnApplyTap = document.getElementById('btnApplyTapResult');
  if (btnApplyTap) {
    btnApplyTap.addEventListener('click', () => {
      if (calState.calibratedTapMs !== null) {
        setLatencyMs(calState.calibratedTapMs);
        showToast(`Latency updated to ${calState.calibratedTapMs}ms!`, 'success');
      }
    });
  }

  // Nudge buttons in modal footer
  const btnNudgeDown = document.getElementById('btnNudgeCalDown');
  if (btnNudgeDown) btnNudgeDown.addEventListener('click', () => nudgeLatency(-10));

  const btnNudgeUp = document.getElementById('btnNudgeCalUp');
  if (btnNudgeUp) btnNudgeUp.addEventListener('click', () => nudgeLatency(10));

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const targetTag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(targetTag) || (e.target && e.target.isContentEditable)) {
      return;
    }

    // Do not intercept browser commands (Cmd+R, Ctrl+R, Cmd+S, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    // 0. Chart Editor Controls (Phase 8)
    if (typeof editorState !== 'undefined' && editorState.isOpen) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        toggleEditorAudioPreview();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeChartEditor();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelectedNote();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (e.shiftKey) {
          shiftAllNotesPitch(1);
        } else {
          shiftSelectedNotePitch(1);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (e.shiftKey) {
          shiftAllNotesPitch(-1);
        } else {
          shiftSelectedNotePitch(-1);
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          shiftAllNotesTiming(-0.10);
        } else if (editorState.selectedNoteIndex >= 0) {
          nudgeSelectedNoteTiming(-0.05, -0.05);
        } else {
          editorState.scrollTime = Math.max(0, editorState.scrollTime - 0.5);
          renderChartEditorCanvas();
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          shiftAllNotesTiming(0.10);
        } else if (editorState.selectedNoteIndex >= 0) {
          nudgeSelectedNoteTiming(0.05, 0.05);
        } else {
          editorState.scrollTime += 0.5;
          renderChartEditorCanvas();
        }
        return;
      }
    }

    // 1. Stage Live Latency Quick-Nudge: '[' (-10 ms) and ']' (+10 ms)
    if (e.key === '[') {
      e.preventDefault();
      nudgeLatency(-10);
      return;
    }
    if (e.key === ']') {
      e.preventDefault();
      nudgeLatency(10);
      return;
    }

    // 2. Spacebar: Rhythm Tap Calibration or Play/Pause playback
    if (e.code === 'Space' || e.key === ' ') {
      const modal = document.getElementById('modalCalibration');
      if (modal && !modal.classList.contains('hidden') && calState.activeMode === 'tap') {
        e.preventDefault();
        recordRhythmTap();
        return;
      }
      const isStageActive = document.getElementById('viewStage')?.classList.contains('active');
      if (isStageActive || state.currentSong) {
        e.preventDefault();
        togglePlayPause();
        return;
      }
    }

    // 3. 'R' / 'r': Restart song from beat 0
    if (e.key === 'r' || e.key === 'R') {
      const isStageActive = document.getElementById('viewStage')?.classList.contains('active');
      if (isStageActive || state.currentSong) {
        e.preventDefault();
        restartSong();
        showToast('Restarting song from beginning', 'info', 1500);
        return;
      }
    }

    // 4. 'S' / 's': Skip intro instrumental silence directly to first lyric
    if (e.key === 's' || e.key === 'S') {
      const isStageActive = document.getElementById('viewStage')?.classList.contains('active');
      if (isStageActive || state.currentSong) {
        e.preventDefault();
        skipToFirstVocals();
        showToast('Skipped to first vocals', 'info', 1500);
        return;
      }
    }

    // 5. 'M' / 'm': Toggle microphone active/muted
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleMicrophone();
      return;
    }

    // 6. 'Esc' / 'Escape': Close any open modal or return to song lobby
    if (e.key === 'Escape' || e.key === 'Esc') {
      // 6a. Close open modals first
      const openModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden)'));
      if (openModals.length > 0) {
        e.preventDefault();
        openModals.forEach((m) => {
          m.classList.add('hidden');
        });
        if (calState.modalOpen || calState.metronomeRunning || calState.isChirpRunning) {
          closeCalibrationModal();
        }
        return;
      }

      // 6b. Return to song lobby if stage is active
      const isStageActive = document.getElementById('viewStage')?.classList.contains('active');
      if (isStageActive) {
        e.preventDefault();
        leaveStageToLobby();
        showToast('Returned to song lobby', 'info', 1500);
        return;
      }
    }
  });
}

/* ============================================================================
 * 9. SPEECH RECOGNITION & 60 FPS PITCH HIGHWAY RENDERER
 * ============================================================================ */
function initSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    document.getElementById('speechTextPreview').textContent = 'Pitch Mode';
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
  state.establishedOctaveShift = null;
  state.singerVocalRegister = null;
  state.pendingPitchSpike = null;
  state.viewportCenterMidi = (state.chartMinMidi + state.chartMaxMidi) / 2 || 65;
  state.viewportSpanMidi = 16;
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

  // Dual-Stem Audio Engine & YouTube Ambient Video Sync (Phase 3)
  if (state.playbackSource === 'local' && state.stemMixer) {
    state.stemMixer.syncDrift();
    if (state.ytPlayer && typeof state.ytPlayer.getCurrentTime === 'function' && typeof state.ytPlayer.getPlayerState === 'function') {
      try {
        if (typeof state.ytPlayer.isMuted === 'function' && !state.ytPlayer.isMuted()) {
          state.ytPlayer.mute();
        }
        if (state.isPlaying && !state.stemMixer.isPaused()) {
          const ytState = state.ytPlayer.getPlayerState();
          if (ytState !== window.YT.PlayerState.PLAYING && ytState !== window.YT.PlayerState.BUFFERING) {
            state.ytPlayer.playVideo();
          }
          const expectedYtTime = state.stemMixer.getCurrentTime() + state.videoOffsetSec;
          if (expectedYtTime >= 0) {
            const ytCur = state.ytPlayer.getCurrentTime();
            if (typeof ytCur === 'number' && !isNaN(ytCur)) {
              if (Math.abs(ytCur - expectedYtTime) > 0.15 && (nowTs - state.lastYtSyncSeekTs > 400)) {
                state.ytPlayer.seekTo(expectedYtTime, true);
                state.lastYtSyncSeekTs = nowTs;
              }
            }
          }
        } else if (!state.isPlaying || state.stemMixer.isPaused()) {
          const ytState = state.ytPlayer.getPlayerState();
          if (ytState === window.YT.PlayerState.PLAYING) {
            state.ytPlayer.pauseVideo();
          }
        }
      } catch (_) {}
    }
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

    try {
      evaluatePitchAtTime(evalTime, dt);
      updateLyricsPrompter(rawSongTime);
      renderPitchHighwayCanvas(rawSongTime, evalTime);
    } catch (renderErr) {
      console.warn('Render loop frame error:', renderErr);
    }
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

function foldMidiToTarget(rawMidi, targetMidi, prevDisplayMidi = null) {
  if (typeof state !== 'undefined' && !state.octaveAgnostic) return rawMidi;

  // 1. Maintain established octave shift during continuous singing (anchored to singer register)
  if (typeof state !== 'undefined' && state.establishedOctaveShift !== null && prevDisplayMidi !== null) {
    const shifted = rawMidi + state.establishedOctaveShift;
    // Adapt only if singer intentionally makes a large octave leap (>= 15 semitones from target)
    if (Math.abs(shifted - targetMidi) >= 15) {
      state.establishedOctaveShift = Math.round((targetMidi - rawMidi) / 12) * 12;
    }
    return rawMidi + state.establishedOctaveShift;
  }

  // 2. If previous display pitch exists, anchor candidate to singer's register with hysteresis
  if (prevDisplayMidi !== null && Number.isFinite(prevDisplayMidi)) {
    const shift = Math.round((prevDisplayMidi - rawMidi) / 12) * 12;
    if (typeof state !== 'undefined') state.establishedOctaveShift = shift;
    let candidate = rawMidi + shift;
    const diff = candidate - prevDisplayMidi;
    if (diff > 7.5) candidate -= 12;
    else if (diff < -7.5) candidate += 12;
    return candidate;
  }

  // 3. New vocal stroke / first anchor: fold to targetMidi
  const shift = Math.round((targetMidi - rawMidi) / 12) * 12;
  if (typeof state !== 'undefined') state.establishedOctaveShift = shift;
  return rawMidi + shift;
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
      const displayMidi = stabilizePitchMidi(folded, state.lastDisplayedMidi, state.currentClarity / 100, dt);
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
    const foldedMidi = foldMidiToTarget(state.smoothedMidi, activeNote.midi, state.lastDisplayedMidi);
    const displayMidi = stabilizePitchMidi(foldedMidi, state.lastDisplayedMidi, state.currentClarity / 100, dt);
    state.lastDisplayedMidi = displayMidi;

    const rawDiff = Math.abs(displayMidi - activeNote.midi);

    // Scoring leniency: pitchMagnet grants subtle leniency (+15% tolerance) without distorting coordinates
    const tol = state.difficultyTolerance * (state.pitchMagnet ? 1.15 : 1.0);
    const isHit = activeNote.isFreestyle || rawDiff <= tol;
    const isPerfect = activeNote.isFreestyle || rawDiff <= tol * 0.6;

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

      feedbackEl.textContent = isPerfect ? 'PERFECT' : 'GOOD';
      feedbackEl.className = 'pitch-feedback ' + (isPerfect ? 'perfect' : 'good');

      spawnHitParticles(activeNote.midi, activeNote.isGolden);
    } else {
      state.streakHits = 0;
      state.combo = 1;
      const dir = displayMidi < activeNote.midi ? '↑ Sing higher' : '↓ Sing lower';
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
      feedbackEl.textContent = 'Sing now';
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
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.round(rect.width) || 960;
  const H = Math.round(rect.height) || (!state.settings.showLyricsRibbon ? 460 : 360);

  const targetPixelW = Math.round(W * dpr);
  const targetPixelH = Math.round(H * dpr);

  if (canvas.width !== targetPixelW || canvas.height !== targetPixelH) {
    canvas.width = targetPixelW;
    canvas.height = targetPixelH;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pastSec = 1.5;
  const futureSec = 4.5;
  const totalWindowSec = pastSec + futureSec;
  const playheadX = (pastSec / totalWindowSec) * W;

  // 1. Constant Pitch Viewport for the entire song: Highest note + x notes, Lowest note - x notes.
  // Static coordinate space with no movement or vertical jitter while singing.
  const minMidi = state.chartMinMidi || 53;
  const maxMidi = state.chartMaxMidi || 77;
  const phraseTargetCenter = (minMidi + maxMidi) / 2;
  state.viewportCenterMidi = phraseTargetCenter;
  state.viewportSpanMidi = maxMidi - minMidi;

  const topPadding = 24;
  const bottomPadding = 28;
  const usableH = H - topPadding - bottomPadding;
  const midiToY = (m) => topPadding + usableH * (1 - (m - minMidi) / (maxMidi - minMidi));
  const timeToX = (t) => playheadX + ((t - evalTime) / totalWindowSec) * W;

  // 2. Horizontal Pitch Grid with Octave Guides
  const startM = Math.floor(minMidi);
  const endM = Math.ceil(maxMidi);
  for (let m = startM; m <= endM; m++) {
    const y = midiToY(m);
    const isC = m % 12 === 0;
    const isWhiteKey = [0, 2, 4, 5, 7, 9, 11].includes(((m % 12) + 12) % 12);

    if (isC) {
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.16)';
      ctx.lineWidth = 1.5;
    } else if (isWhiteKey) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.lineWidth = 0.5;
    }
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();

    if (isC) {
      const octave = Math.floor(m / 12) - 1;
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif';
      ctx.fillStyle = 'rgba(0, 240, 255, 0.4)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`C${octave}`, 8, y - 1);
    }
  }

  // 3. Modern Capsule Note Tubes & Syllable Anti-Collision
  const barHeight = 16;
  const pillRadius = barHeight / 2;
  const visualGapPx = 3;

  const windowStart = evalTime - pastSec;
  const windowEnd = evalTime + futureSec;
  const visibleNotes = (state.notes || []).filter(
    (n) => n.endTime >= windowStart - 0.5 && n.startTime <= windowEnd + 0.5
  );

  for (const note of visibleNotes) {
    const x1 = timeToX(note.startTime);
    const x2 = timeToX(note.endTime);
    const rawWidth = Math.max(12, x2 - x1);
    const drawWidth = Math.max(8, rawWidth - visualGapPx);
    const y = midiToY(note.midi) - barHeight / 2;

    // Unfilled Capsule Container
    ctx.save();
    if (note.isGolden) {
      ctx.shadowColor = 'rgba(255, 184, 0, 0.5)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = 'rgba(255, 184, 0, 0.14)';
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.85)';
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
    }
    roundRect(ctx, x1, y, drawWidth, barHeight, pillRadius);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Filled Hit State
    if (note.fillRatio > 0) {
      const fillW = Math.max(pillRadius * 2, Math.min(drawWidth, drawWidth * note.fillRatio));
      ctx.save();
      roundRect(ctx, x1, y, drawWidth, barHeight, pillRadius);
      ctx.clip();

      const grad = ctx.createLinearGradient(x1, y, x1 + drawWidth, y);
      if (note.isGolden) {
        grad.addColorStop(0, '#ffb800');
        grad.addColorStop(1, '#ff3366');
      } else {
        grad.addColorStop(0, '#00f0ff');
        grad.addColorStop(1, '#00e676');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x1, y, fillW, barHeight);
      ctx.restore();
    }

    // Uniform Syllable Placement: Every word/syllable is rendered cleanly below the note tube
    if (state.settings.showSyllablesOnNotes) {
      const text = (note.text || '').trim();
      if (text) {
        ctx.save();
        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const isCurrent = evalTime >= note.startTime && evalTime <= note.endTime;
        ctx.fillStyle = isCurrent ? '#00f0ff' : 'rgba(240, 243, 250, 0.9)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
        ctx.shadowBlur = 4;

        const textX = x1 + drawWidth / 2;
        const textY = y + barHeight + 4;
        ctx.fillText(text, textX, textY);
        ctx.restore();
      }
    }
  }

  // 4. Playhead Line & Cursor (Customizable Vibe & High Visibility)
  const playheadVibe = state.settings.playheadColor || 'cyan';
  let playheadStroke = 'rgba(0, 240, 255, 0.95)';
  let playheadGlow = '#00f0ff';
  let playheadCap = '#ffffff';

  if (playheadVibe === 'gold') {
    playheadStroke = 'rgba(255, 184, 0, 0.95)';
    playheadGlow = '#ffb800';
  } else if (playheadVibe === 'emerald') {
    playheadStroke = 'rgba(0, 230, 118, 0.95)';
    playheadGlow = '#00e676';
  } else if (playheadVibe === 'white') {
    playheadStroke = 'rgba(255, 255, 255, 0.98)';
    playheadGlow = '#38bdf8';
  } else if (playheadVibe === 'magenta') {
    playheadStroke = 'rgba(255, 45, 108, 0.95)';
    playheadGlow = '#ff2d6c';
  }

  ctx.save();
  ctx.shadowColor = playheadGlow;
  ctx.shadowBlur = 10;
  ctx.strokeStyle = playheadStroke;
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(playheadX, topPadding);
  ctx.lineTo(playheadX, H - bottomPadding);
  ctx.stroke();

  // Top and bottom glowing laser pointers
  ctx.fillStyle = playheadCap;
  ctx.shadowBlur = 12;
  const drawDiamond = (cx, cy, r) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  drawDiamond(playheadX, topPadding + 2, 5.5);
  drawDiamond(playheadX, H - bottomPadding - 2, 5.5);
  ctx.restore();

  // 5. Stabilized Pitch Trail
  if (state.settings.showLiveVoiceOrb && state.pitchHistory.length > 1) {
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < state.pitchHistory.length; i++) {
      const p0 = state.pitchHistory[i - 1];
      const p1 = state.pitchHistory[i];

      if (p0.strokeId !== p1.strokeId) continue;
      if (p1.songTime - p0.songTime > 0.12) continue;
      if (Math.abs(p1.midi - p0.midi) > 6.5) continue;

      ctx.strokeStyle = p1.hit ? '#00e676' : 'rgba(244, 63, 94, 0.65)';
      ctx.beginPath();
      ctx.moveTo(timeToX(p0.songTime), midiToY(p0.midi));
      ctx.lineTo(timeToX(p1.songTime), midiToY(p1.midi));
      ctx.stroke();
    }
  }

  // 6. Live Voice Orb
  if (state.settings.showLiveVoiceOrb && state.lastDisplayedMidi !== null && state.smoothedMidi !== null) {
    const rawOrbY = midiToY(state.lastDisplayedMidi);
    const orbY = Math.max(topPadding - 4, Math.min(H - bottomPadding + 4, rawOrbY));
    ctx.save();
    ctx.shadowColor = playheadGlow;
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(playheadX, orbY, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 7. Hit Particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.alpha -= (p.decay || 0.035);
    if (p.alpha <= 0) {
      state.particles.splice(i, 1);
      continue;
    }
    ctx.save();
    if (p.isGolden) {
      ctx.shadowColor = '#ffb800';
      ctx.shadowBlur = 6;
    }
    ctx.fillStyle = p.color.replace('ALPHA', p.alpha.toFixed(2));
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function spawnHitParticles(midi, isGolden) {
  if (!state.settings.showLiveVoiceOrb || state.particles.length > 50) return;
  const canvas = document.getElementById('pitchCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const W = Math.round(rect.width) || 960;
  const H = Math.round(rect.height) || (!state.settings.showLyricsRibbon ? 460 : 360);
  const playheadX = (1.5 / 6.0) * W;

  const minMidi = state.chartMinMidi || 53;
  const maxMidi = state.chartMaxMidi || 77;
  const topPadding = 24;
  const bottomPadding = 28;
  const usableH = H - topPadding - bottomPadding;
  const y = topPadding + usableH * (1 - (midi - minMidi) / (maxMidi - minMidi));

  const count = isGolden ? 4 : 2;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.0 + Math.random() * (isGolden ? 3.5 : 2.0);
    state.particles.push({
      x: playheadX,
      y: y + (Math.random() - 0.5) * 8,
      vx: isGolden ? Math.cos(angle) * speed - 1.2 : -1.5 - Math.random() * 2.5,
      vy: isGolden ? Math.sin(angle) * speed : (Math.random() - 0.5) * 3,
      radius: isGolden ? 1.5 + Math.random() * 3.0 : 2 + Math.random() * 2.5,
      alpha: 1.0,
      decay: isGolden ? 0.02 + Math.random() * 0.02 : 0.035,
      isGolden: !!isGolden,
      color: isGolden
        ? Math.random() > 0.4
          ? 'rgba(255, 184, 0, ALPHA)'
          : 'rgba(255, 235, 120, ALPHA)'
        : 'rgba(0, 240, 255, ALPHA)',
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
  const clean = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  const m = clean.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/i);
  return m ? m[1] : null;
}

async function resolveYouTubeClient(ytId, rawInput) {
  let title = 'YouTube Track';
  let artist = 'YouTube';
  let durationSec = 210;
  let artworkUrl = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;

  // 1. Check if videoId exists in our pre-indexed UltraStar catalog
  if (state.ultraStarCatalog && state.ultraStarCatalog.length > 0) {
    const match = state.ultraStarCatalog.find(
      (s) => s.videoId === ytId || s.id === ytId || (s.youtubeId && s.youtubeId === ytId)
    );
    if (match) {
      title = match.title || title;
      artist = match.artist || artist;
      durationSec = match.duration || durationSec;
    }
  }

  // 2. Try YouTube oEmbed for official video title & author
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(ytId)}&format=json`
    );
    if (oembedRes.ok) {
      const oembedData = await oembedRes.json();
      if (oembedData.title) {
        let cleanTitle = oembedData.title.trim();
        if (cleanTitle.includes(' - ')) {
          const parts = cleanTitle.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        } else {
          title = cleanTitle;
          if (oembedData.author_name) {
            artist = oembedData.author_name.replace(/ - Topic$/i, '').replace(/VEVO$/i, '').trim();
          }
        }
      }
      if (oembedData.thumbnail_url) {
        artworkUrl = oembedData.thumbnail_url;
      }
    }
  } catch (_) {}

  // Strip common YouTube title suffixes
  title = title
    .replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Audio|Lyric\s*Video|HD|4K|Visualizer|HQ)[\)\]]/gi, '')
    .trim();

  const slug = createSongSlugClient(artist, title);

  return {
    type: 'youtube',
    title,
    artist,
    durationSec,
    artworkUrl,
    spotifyTrackId: '',
    youtubeId: ytId,
    isrc: '',
    confidence: 1.0,
    slug,
    candidates: [],
  };
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
    const fetchedSongs = data.songs || [];

    // Filter out any locally deleted songs from sing_deleted_songs
    let deletedSlugs = [];
    try {
      deletedSlugs = JSON.parse(localStorage.getItem('sing_deleted_songs') || '[]');
    } catch (_) {}

    state.librarySongs = fetchedSongs.filter((s) => !deletedSlugs.includes(s.slug));

    const libSec = document.getElementById('librarySection');
    if (state.librarySongs.length === 0) {
      if (libSec) libSec.classList.add('hidden');
      if (emptyEl) emptyEl.classList.add('hidden');
      gridEl.innerHTML = '';
    } else {
      if (libSec) libSec.classList.remove('hidden');
      if (emptyEl) emptyEl.classList.add('hidden');
      renderLibraryGrid(state.librarySongs);
    }
  } catch (err) {
    console.warn('Error loading song library:', err);
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
      const editedBadge = s.edited ? '<span class="badge badge-gold" title="Edited in Chart Editor">Edited</span>' : '';
      const stemBadge = (s.hasVocals && s.hasInstrumental)
        ? '<span class="badge badge-sync" title="Dual-Stem: Isolated backing track + Lead vocal guide">Dual-Stem</span>'
        : (s.hasInstrumental ? '<span class="badge" title="Isolated instrumental backing track">Instrumental</span>' : '');

      return `
      <div class="song-card library-card" data-lib-idx="${idx}">
        ${coverHtml}
        <div class="card-body">
          <div class="card-badges">
            <span class="badge ${badgeClass}">${escapeHtml(s.badgeLabel || 'AI Song')}</span>
            ${stemBadge}
            <span class="badge">${durText}</span>
            <span class="badge badge-gold">${scorePct}% Sync</span>
            ${editedBadge}
          </div>
          <h3 class="card-title">${escapeHtml(s.title)}</h3>
          <p class="card-artist">${escapeHtml(s.artist)}</p>
        </div>
        <div class="card-actions-row">
          <button class="primary-btn card-action-btn btn-play-lib" data-lib-idx="${idx}">
            Sing
          </button>
          <div class="card-sub-actions">
            <button class="small-btn card-action-btn btn-edit-lib" data-lib-idx="${idx}" title="Edit notes in Chart Editor">
              Edit
            </button>
            <button class="small-btn card-action-btn btn-delete-lib danger-btn" data-lib-idx="${idx}" title="Delete song from library">
              Delete
            </button>
          </div>
        </div>
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

  gridEl.querySelectorAll('.btn-edit-lib').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-lib-idx'), 10);
      const song = state.librarySongs[idx];
      if (song) {
        try {
          const res = await fetch(song.chartUrl);
          if (!res.ok) throw new Error('Could not load chart file');
          const txt = await res.text();
          openChartEditorForSong(song, txt);
        } catch (err) {
          showToast('Error loading chart: ' + err.message, 'error');
        }
      }
    });
  });

  gridEl.querySelectorAll('.btn-delete-lib').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-lib-idx'), 10);
      const song = state.librarySongs[idx];
      if (!song) return;

      if (!confirm(`Delete "${song.title}" by ${song.artist}?\n\nThis will remove the song from your library.`)) {
        return;
      }

      const targetSlug = song.slug;
      const targetTitle = song.title;

      // 1. Immediately delete from the list in UI and remember in localStorage
      let deletedSlugs = [];
      try {
        deletedSlugs = JSON.parse(localStorage.getItem('sing_deleted_songs') || '[]');
      } catch (_) {}
      if (!deletedSlugs.includes(targetSlug)) {
        deletedSlugs.push(targetSlug);
        localStorage.setItem('sing_deleted_songs', JSON.stringify(deletedSlugs));
      }

      state.librarySongs = state.librarySongs.filter((s) => s.slug !== targetSlug);
      renderLibraryGrid(state.librarySongs);

      const libSec = document.getElementById('librarySection');
      if (state.librarySongs.length === 0 && libSec) {
        libSec.classList.add('hidden');
      }

      showToast(`Deleted "${targetTitle}" from library`, 'success');

      // 2. Also send delete request to backend to clean up disk folder
      try {
        let res = await fetch(`/api/library/${encodeURIComponent(targetSlug)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          await fetch(`/api/library/${encodeURIComponent(targetSlug)}/delete`, {
            method: 'POST',
          });
        }
      } catch (_) {}
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
  const initialOffset = (typeof song.studioOffsetSec === 'number' && song.studioOffsetSec !== 0)
    ? song.studioOffsetSec
    : ((typeof song.videoOffsetSec === 'number' && song.videoOffsetSec !== 0) ? song.videoOffsetSec : 0);
  setVideoOffset(initialOffset);
  state.calculatedStudioOffset = initialOffset;
  document.getElementById('viewLobby').classList.remove('active');
  document.getElementById('viewStage').classList.add('active');

  if (!state.micActive) {
    startMicrophone(state.selectedDeviceId).catch(() => {});
  }

  try {
    const res = await fetch(song.chartUrl);
    if (!res.ok) {
      showToast('Could not load chart file: ' + song.chartUrl, 'error');
      return;
    }
    const txtContent = await res.text();

    const songMeta = {
      slug: song.slug,
      trackName: song.title,
      artistName: song.artist,
      videoId: song.youtubeId || '',
      duration: song.durationSec || 210,
      instrumentalUrl: song.instrumentalUrl,
      vocalsUrl: song.vocalsUrl,
      artworkUrl: song.coverUrl,
      studioOffsetSec: song.studioOffsetSec,
      videoOffsetSec: song.videoOffsetSec,
    };

    await applyParsedUltraStarChart(txtContent, songMeta);

    // Update Stage Cover if available
    const coverEl = document.getElementById('stageCover');
    if (coverEl && song.coverUrl) {
      coverEl.src = song.coverUrl;
    }

    const badgeSource = document.getElementById('badgeChartSource');
    if (badgeSource) {
      badgeSource.textContent = `⚡ AI-Generated (${escapeHtml(song.badgeLabel || 'AI Track')})`;
    }

    // Use local stems if available (pure instrumental + guide vocals)
    if (song.instrumentalUrl) {
      setupLocalStemsAudio(song.instrumentalUrl, song.vocalsUrl);
    } else {
      updateGuideVocalsUI(false);
    }
  } catch (err) {
    console.error('Error starting AI song:', err);
    showToast('Error loading song: ' + err.message, 'error');
  }
}

async function handleResolveQuery(inputQuery) {
  const loadingEl = document.getElementById('resolveLoading');
  const previewCard = document.getElementById('resolvePreviewCard');

  if (loadingEl) loadingEl.classList.remove('hidden');
  if (previewCard) previewCard.classList.add('hidden');

  try {
    let data = null;

    // 1. Try resolving via backend API
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputQuery }),
      });

      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = null;
      }

      if (!res.ok || (data && data.error)) {
        console.warn('Backend resolve returned error or non-JSON:', text);
        data = null;
      }
    } catch (netErr) {
      console.warn('Could not reach backend /api/resolve:', netErr);
      data = null;
    }

    // 2. Client-side fallback if backend failed or returned 404
    if (!data) {
      const ytId = extractYouTubeId(inputQuery);
      if (ytId) {
        data = await resolveYouTubeClient(ytId, inputQuery);
      } else {
        throw new Error('Could not resolve track. Please verify your YouTube link.');
      }
    }

    displayResolvePreview(data);
  } catch (err) {
    showToast(`Analysis error: ${err.message}`, 'error');
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

async function handleAudioUpload(file) {
  const loadingEl = document.getElementById('resolveLoading');
  const loadingText = document.getElementById('resolveLoadingText');
  const previewCard = document.getElementById('resolvePreviewCard');

  if (loadingText) loadingText.textContent = `Uploading "${file.name}" (max 80 MB)...`;
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
      throw new Error(data.error || 'Audio upload failed');
    }

    // Auto-detect title and artist from filename
    const baseName = file.name.replace(/\.[^.]+$/, '');
    let artist = 'Uploaded Audio';
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
    showToast(`Audio upload failed: ${err.message}`, 'error');
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
    if (loadingText) loadingText.textContent = 'Resolving track information and audio stream...';
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
  if (titleEl) titleEl.textContent = resolved.title || 'Unknown Title';

  const artistEl = document.getElementById('previewArtist');
  if (artistEl) artistEl.textContent = resolved.artist || 'Unknown Artist';

  const sourceBadge = document.getElementById('previewSourceBadge');
  if (sourceBadge) {
    if (resolved.usdbMatch && resolved.usdbMatch.matched) {
      sourceBadge.textContent = 'USDB Ground Truth';
      sourceBadge.className = 'badge badge-gold';
    } else if (resolved.type === 'spotify') {
      sourceBadge.textContent = 'Spotify';
      sourceBadge.className = 'badge badge-green';
    } else if (resolved.type === 'youtube') {
      sourceBadge.textContent = 'YouTube';
      sourceBadge.className = 'badge badge-red';
    } else if (resolved.type === 'upload') {
      sourceBadge.textContent = 'Upload';
      sourceBadge.className = 'badge badge-cyan';
    } else {
      sourceBadge.textContent = 'Search';
      sourceBadge.className = 'badge';
    }
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
    if (resolved.usdbMatch && resolved.usdbMatch.matched) {
      noteEl.textContent = `★ USDB community chart verified (${resolved.usdbMatch.id}) – 0.0ms timing error, human-verified pitch`;
    } else if (resolved.youtubeId) {
      noteEl.textContent = `✓ YouTube audio matched (${resolved.youtubeId})`;
    } else if (resolved.uploadedAudioPath) {
      noteEl.textContent = '✓ Local audio file uploaded';
    } else {
      noteEl.textContent = 'ℹ YouTube audio will be acquired on start';
    }
  }

  const badgeCustomLyrics = document.getElementById('badgeCustomLyricsActive');
  if (badgeCustomLyrics) {
    badgeCustomLyrics.classList.toggle('hidden', !state.customLyricsText);
  }

  // Lyrics Tier Badge Evaluation (Phase 5.2: Tier 1 vs Tier 2 vs Tier 3 vs Tier 4)
  const tierBadge = document.getElementById('previewLyricsTierBadge');
  const btnUpgradeLyrics = document.getElementById('btnUpgradeLyrics');
  if (btnUpgradeLyrics) {
    btnUpgradeLyrics.classList.add('hidden');
    btnUpgradeLyrics.style.display = 'none';
  }

  // Check if track is cached in library as Tier 4
  const cachedLibSong = state.librarySongs && state.librarySongs.find(
    (s) =>
      (s.slug && s.slug === resolved.slug) ||
      (s.youtubeId && resolved.youtubeId && s.youtubeId === resolved.youtubeId) ||
      (s.title && s.artist && s.title.toLowerCase() === resolved.title?.toLowerCase() && s.artist.toLowerCase() === resolved.artist?.toLowerCase())
  );
  const isCachedAsTier4 = !!(
    cachedLibSong &&
    (cachedLibSong.lyricsTier === 4 ||
     cachedLibSong.badgeType === 'Whisper-AI' ||
     cachedLibSong.provider === 'whisper')
  );

  const surfaceUpgradeIfTier4 = () => {
    if (isCachedAsTier4 && btnUpgradeLyrics) {
      btnUpgradeLyrics.classList.remove('hidden');
      btnUpgradeLyrics.style.display = 'inline-flex';
    }
  };

  if (tierBadge) {
    if ((resolved.usdbMatch && resolved.usdbMatch.matched) || findCatalogMatch(resolved)) {
      tierBadge.textContent = '★ Tier 1: USDB Ground Truth (100% Timing & Pitch)';
      tierBadge.className = 'badge badge-gold';
      tierBadge.style.display = 'inline-block';
      surfaceUpgradeIfTier4();
    } else if (state.customLyricsText && state.customLyricsText.trim()) {
      const lines = state.customLyricsText.trim().split('\n').filter(Boolean).length;
      tierBadge.textContent = `✓ Tier 3: Web Lyrics (Manual, ${lines}Z)`;
      tierBadge.className = 'badge badge-cyan';
      tierBadge.style.display = 'inline-block';
      surfaceUpgradeIfTier4();
    } else {
      tierBadge.textContent = '🔍 Lyrics suchen...';
      tierBadge.className = 'badge';
      tierBadge.style.display = 'inline-block';

      // Check Tier 2 (Studio Syllable-Sync) and Tier 3 (Web Lyrics Harvest)
      const currentTrackSlug = resolved.slug;

      // Probe /api/lyrics for Tier 2 Studio Syllable-Sync
      fetch('/api/lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: resolved.title,
          artist: resolved.artist,
          durationSec: resolved.durationSec || 0,
          spotifyTrackId: resolved.spotifyTrackId || '',
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((lyricsDoc) => {
          if (!state.resolvedTrack || state.resolvedTrack.slug !== currentTrackSlug) return;
          if (lyricsDoc && (lyricsDoc.syncType === 'syllable' || (lyricsDoc.lines && lyricsDoc.lines.some((l) => Array.isArray(l.syllables) && l.syllables.length > 0)))) {
            tierBadge.textContent = '✓ Tier 2: Studio Syllable-Sync';
            tierBadge.className = 'badge badge-green';
            surfaceUpgradeIfTier4();
            return;
          }

          // Probe /api/lyrics/harvest for Tier 3 Web Lyrics
          return fetch('/api/lyrics/harvest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              artist: resolved.artist,
              title: resolved.title,
              youtubeId: resolved.youtubeId,
              candidates: resolved.candidates || [],
              durationSec: resolved.durationSec || 0,
            }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!state.resolvedTrack || state.resolvedTrack.slug !== currentTrackSlug) return;
              if (data && data.lyrics) {
                const srcLabel = data.source === 'youtube_description' ? 'YouTube' : data.source;
                tierBadge.textContent = `✓ Tier 3: Web Lyrics (${srcLabel}, ${data.lineCount}Z)`;
                tierBadge.className = 'badge badge-cyan';
                surfaceUpgradeIfTier4();
              } else {
                tierBadge.textContent = '⚡ Tier 4: Whisper AI Speech-to-Text';
                tierBadge.className = 'badge badge-pink';
              }
            });
        })
        .catch(() => {
          if (state.resolvedTrack && state.resolvedTrack.slug !== currentTrackSlug) {
            tierBadge.textContent = '⚡ Tier 4: Whisper AI Speech-to-Text';
            tierBadge.className = 'badge badge-pink';
          }
        });
    }
  }

  updateStartBtnLabel();

  previewCard.classList.remove('hidden');
}

function updateStartBtnLabel() {
  const startBtn = document.getElementById('btnStartGeneration');
  const separateBtn = document.getElementById('btnSeparateVocals');
  if (!startBtn || !state.resolvedTrack) return;
  const hasCustomLyrics = !!(state.customLyricsText && state.customLyricsText.trim());
  const isCatalog =
    !hasCustomLyrics &&
    (findCatalogMatch(state.resolvedTrack) ||
      (state.resolvedTrack.usdbMatch && state.resolvedTrack.usdbMatch.matched));
  startBtn.textContent = isCatalog ? 'Sing Now (Instant)' : 'Generate Karaoke';
  if (separateBtn) {
    if (isCatalog) {
      separateBtn.classList.remove('hidden');
      separateBtn.style.display = 'inline-flex';
    } else {
      separateBtn.classList.add('hidden');
      separateBtn.style.display = 'none';
    }
  }
}

function findCatalogMatch(resolved) {
  if (!state.ultraStarCatalog || state.ultraStarCatalog.length === 0 || !resolved) return null;
  const ytId = resolved.youtubeId;

  // 1. Exact YouTube Video ID Match
  if (ytId) {
    const byYt = state.ultraStarCatalog.find(
      (s) => (s.video && s.video === ytId) || (s.videoId && s.videoId === ytId) || (s.id && s.id === ytId)
    );
    if (byYt) return byYt;
  }

  // 2. Strict Title & Artist Match
  const clean = (str) =>
    (str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();

  const rTit = clean(resolved.title);
  const rArt = clean(resolved.artist);

  if (rTit.length < 4 || rArt.length < 3) return null;

  return (
    state.ultraStarCatalog.find((s) => {
      const sTit = clean(s.title);
      const sArt = clean(s.artist);
      if (sTit.length < 4 || sArt.length < 3) return false;

      const exactTitle = sTit === rTit;
      const exactArtist = sArt === rArt;
      if (exactTitle && exactArtist) return true;

      // Prefix match only when artist strictly matches
      const titleMatch =
        (sTit.startsWith(rTit) || rTit.startsWith(sTit)) && (sArt === rArt || sArt.startsWith(rArt));
      return titleMatch;
    }) || null
  );
}

async function handleStartSongAction(actionOptions = {}) {
  if (!state.resolvedTrack) {
    showToast('Please enter or select a song first', 'warning');
    return;
  }

  // Pick up any inline edits from the user
  const userTitle = document.getElementById('previewTitle')?.textContent?.trim();
  const userArtist = document.getElementById('previewArtist')?.textContent?.trim();
  if (userTitle && userTitle !== 'Song Title' && userTitle !== 'Unknown Title') {
    state.resolvedTrack.title = userTitle;
  }
  if (userArtist && userArtist !== 'Artist Name' && userArtist !== 'Unknown Artist') {
    state.resolvedTrack.artist = userArtist;
  }

  // Hide preview card and immediately show the 5-step progress card
  const previewCard = document.getElementById('resolvePreviewCard');
  if (previewCard) previewCard.classList.add('hidden');

  const progressCard = document.getElementById('genProgressCard');
  if (progressCard) progressCard.classList.remove('hidden');

  const thumbEl = document.getElementById('progressArtwork');
  if (thumbEl) {
    thumbEl.src =
      state.resolvedTrack.artworkUrl ||
      `https://img.youtube.com/vi/${state.resolvedTrack.youtubeId}/hqdefault.jpg`;
  }
  const titleEl = document.getElementById('progressTitle');
  if (titleEl) titleEl.textContent = state.resolvedTrack.title;
  const artistEl = document.getElementById('progressArtist');
  if (artistEl) artistEl.textContent = state.resolvedTrack.artist;

  // Initialize Step 1
  updateGenerationUI({
    status: 'running',
    stage: 'lyrics',
    progress: 5,
    message: actionOptions.upgradeLyrics
      ? 'Upgrading song to studio-quality lyrics...'
      : 'Loading lyrics and track data...',
  });

  // 1. Check if song exists in curated UltraStar catalog or USDB ground truth (MASTER_OVERHAUL_PLAN Phase 1)
  const hasCustomLyrics = !!(state.customLyricsText && state.customLyricsText.trim());
  const isUpgrade = !!actionOptions.upgradeLyrics;
  const forceJob = !!actionOptions.forceJob || !!actionOptions.forceSeparation;
  const catMatch = !hasCustomLyrics && !isUpgrade && !forceJob ? findCatalogMatch(state.resolvedTrack) : null;
  const usdbM = !hasCustomLyrics && !isUpgrade && !forceJob ? state.resolvedTrack.usdbMatch : null;
  if (!forceJob && (catMatch || (usdbM && usdbM.matched))) {
    const matchId = catMatch?.id || usdbM?.id || usdbM?.usdbId;
    const matchTitle = catMatch?.title || usdbM?.title || state.resolvedTrack.title;
    const matchArtist = catMatch?.artist || usdbM?.artist || state.resolvedTrack.artist;
    const matchVideo = state.resolvedTrack.youtubeId || catMatch?.video || usdbM?.videoId || '';

    state.lastGeneratedSong = {
      isDirectSession: true,
      trackName: matchTitle,
      artistName: matchArtist,
      duration: catMatch?.duration || state.resolvedTrack.durationSec || 210,
      videoId: matchVideo,
      isUltraStar: true,
      isUsdb: !!usdbM?.usdbId,
      usdbId: usdbM?.usdbId || null,
      ultraStarId: matchId,
      artworkUrl:
        state.resolvedTrack.artworkUrl ||
        (matchVideo ? `https://img.youtube.com/vi/${matchVideo}/hqdefault.jpg` : ''),
    };

    // Animate through all steps smoothly without spawning heavy AI worker
    await new Promise((r) => setTimeout(r, 200));
    updateGenerationUI({
      status: 'running',
      stage: 'lyrics',
      progress: 25,
      message: 'Ingesting verified USDB ground-truth notes (0.0ms timing error)...',
    });

    await new Promise((r) => setTimeout(r, 200));
    updateGenerationUI({
      status: 'running',
      stage: 'download',
      progress: 55,
      message: 'Connecting YouTube audio stream & video inset...',
    });

    await new Promise((r) => setTimeout(r, 200));
    updateGenerationUI({
      status: 'running',
      stage: 'separate',
      progress: 80,
      message: 'Configuring duet vocal tracks & pitch intervals...',
    });

    await new Promise((r) => setTimeout(r, 200));
    updateGenerationUI({
      status: 'done',
      stage: 'done',
      progress: 100,
      message: 'Ready to sing! 100% human-verified pitch & timing.',
    });
    return;
  }

  // 2. Check if already in local library
  if (!hasCustomLyrics && !isUpgrade && state.librarySongs && state.librarySongs.length > 0) {
    const libMatch = state.librarySongs.find(
      (s) =>
        (s.youtubeId && s.youtubeId === state.resolvedTrack.youtubeId) ||
        (s.slug && s.slug === state.resolvedTrack.slug)
    );
    if (libMatch && (!forceJob || (libMatch.hasVocals && libMatch.hasInstrumental))) {
      state.lastGeneratedSong = libMatch;
      updateGenerationUI({
        status: 'done',
        stage: 'done',
        progress: 100,
        message: 'Song is ready from your library!',
      });
      return;
    }
  }

  // 3. Otherwise generate via AI job queue or fallback to direct stage (or upgrade)
  await startGenerationJob(actionOptions);
}

const startSongFromPreview = handleStartSongAction;

async function startGenerationJob(overrideOptions = {}) {
  if (!state.resolvedTrack) {
    showToast('Please enter or select a song first', 'warning');
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
    allowWhisperFallback: true,
    uploadedAudioPath: state.resolvedTrack.uploadedAudioPath || null,
    rawLyricsText: state.customLyricsText || null,
    ...overrideOptions,
  };

  const previewCard = document.getElementById('resolvePreviewCard');
  if (previewCard) previewCard.classList.add('hidden');

  const progressCard = document.getElementById('genProgressCard');
  if (progressCard) progressCard.classList.remove('hidden');

  const thumbEl = document.getElementById('progressArtwork');
  if (thumbEl) {
    thumbEl.src =
      state.resolvedTrack.artworkUrl ||
      `https://img.youtube.com/vi/${state.resolvedTrack.youtubeId}/hqdefault.jpg`;
  }
  const titleEl = document.getElementById('progressTitle');
  if (titleEl) titleEl.textContent = state.resolvedTrack.title;
  const artistEl = document.getElementById('progressArtist');
  if (artistEl) artistEl.textContent = state.resolvedTrack.artist;

  updateGenerationUI({
    status: 'running',
    stage: 'lyrics',
    progress: 15,
    message: state.customLyricsText
      ? 'Manual plain lyrics loaded! Preparing precision alignment...'
      : 'Analyzing lyrics and audio structure...',
  });

  try {
    let data = null;
    let requestFailed = false;

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolved: state.resolvedTrack,
          options,
        }),
      });

      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = null;
      }

      if (!res.ok || (data && data.error)) {
        requestFailed = true;
      }
    } catch (_) {
      requestFailed = true;
    }

    // Graceful fallback if backend AI generator is unavailable (e.g. running on static server)
    if (!data || requestFailed) {
      console.warn('Backend job API unavailable, preparing stage with YouTube audio...');
      state.lastGeneratedSong = {
        isDirectSession: true,
        trackName: state.resolvedTrack.title,
        artistName: state.resolvedTrack.artist,
        duration: state.resolvedTrack.durationSec || 210,
        videoId: state.resolvedTrack.youtubeId,
        artworkUrl: state.resolvedTrack.artworkUrl,
      };

      await new Promise((r) => setTimeout(r, 400));
      updateGenerationUI({
        status: 'running',
        stage: 'download',
        progress: 45,
        message: 'Connecting YouTube stream...',
      });

      await new Promise((r) => setTimeout(r, 400));
      updateGenerationUI({
        status: 'running',
        stage: 'separate',
        progress: 70,
        message: 'Preparing vocal highway...',
      });

      await new Promise((r) => setTimeout(r, 400));
      updateGenerationUI({
        status: 'running',
        stage: 'pitch',
        progress: 90,
        message: 'Calibrating pitch detection...',
      });

      await new Promise((r) => setTimeout(r, 400));
      updateGenerationUI({
        status: 'done',
        stage: 'done',
        progress: 100,
        message: 'Ready to sing! Click the button below.',
      });
      return;
    }

    state.activeJobId = data.jobId;

    if (data.status === 'done') {
      state.lastGeneratedSong = data.result;
      updateGenerationUI({
        status: 'done',
        stage: 'done',
        progress: 100,
        message: 'Song is already generated and ready in your library!',
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
      message: `Error: ${err.message}`,
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
    console.warn('SSE not available, falling back to polling:', err);
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
  if (msgEl) msgEl.textContent = job.message || 'Processing...';

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
      queued: 'Queued',
      lyrics: 'Lyrics & Sync',
      download: 'Audio Download',
      separate: 'Stem Separation',
      align: 'Syllable Alignment',
      pitch: 'Pitch Tracking',
      finalize: 'Finalizing Chart',
      done: 'Completed',
      error: 'Failed',
      cancelled: 'Cancelled',
    };
    stageNameEl.textContent = stageLabels[job.stage] || job.stage || 'Initializing';
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
      statusPill.textContent = '✓ Completed';
      statusPill.className = 'badge badge-sync';
    }
    if (btnPlay) btnPlay.classList.remove('hidden');
    if (btnCancel) btnCancel.classList.add('hidden');
    if (job.result) state.lastGeneratedSong = job.result;
    loadLibrarySongs();
  } else if (job.status === 'error') {
    if (statusPill) {
      statusPill.textContent = '✕ Error';
      statusPill.className = 'badge badge-pink';
    }
    if (btnPlay) btnPlay.classList.add('hidden');
  } else {
    if (statusPill) {
      statusPill.textContent = '⚡ Processing...';
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
      showToast('Spicy Lyrics Key saved locally.', 'success');
      await loadLyricsSettings();
    }
  } catch (err) {
    showToast(`Error saving: ${err.message}`, 'error');
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
      showToast('Spotify sp_dc cookie saved locally.', 'success');
      await loadLyricsSettings();
    }
  } catch (err) {
    showToast(`Error saving: ${err.message}`, 'error');
  }
}

async function checkSystemHealthStatus() {
  const lbl = document.getElementById('lblSystemHealthStatus');
  if (lbl) lbl.textContent = 'Checking environment...';

  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const data = await res.json();
      const yt = data.ytDlpAvailable ? '✓ yt-dlp ready' : '✗ yt-dlp missing';
      const ff = data.ffmpegAvailable ? '✓ ffmpeg ready' : '✗ ffmpeg missing';
      const py = data.pythonVenvAvailable ? '✓ Python venv ready' : '✗ Python venv missing';
      if (lbl) lbl.textContent = `${yt} | ${ff} | ${py}`;
    }
  } catch (err) {
    if (lbl) lbl.textContent = 'Error retrieving system status.';
  }
}

/* ============================================================================
 * 12. INTERACTIVE CHART EDITOR (PLAN.md Phase 7.1)
 * ============================================================================ */
const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(m) {
  if (isNaN(m) || m === null) return '--';
  const rounded = Math.round(m);
  const name = MIDI_NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

const editorState = {
  isOpen: false,
  slug: null,
  songMeta: null,
  notes: [],
  selectedNoteIndex: -1,
  scrollTime: 0,
  viewportDuration: 8,
  minMidi: 48,
  maxMidi: 76,
  isDragging: false,
  dragMode: null,
  dragStartX: 0,
  dragStartY: 0,
  dragInitialNote: null,
  dragInitialScroll: 0,
  previewAudio: null,
  isPlayingPreview: false,
  previewTimer: null,
  waveformPeaks: null,
  waveformDuration: 0,
  waveformSampleRate: 50,
  isGuideToneEnabled: true,
};

let editorAudioCtx = null;
let editorGuideOsc = null;
let editorGuideGain = null;

function startEditorGuideTone() {
  stopEditorGuideTone();
  if (!editorState.isGuideToneEnabled) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!editorAudioCtx || editorAudioCtx.state === 'closed') {
      editorAudioCtx = new AudioContextClass();
    }
    if (editorAudioCtx.state === 'suspended') {
      editorAudioCtx.resume();
    }

    editorGuideOsc = editorAudioCtx.createOscillator();
    editorGuideGain = editorAudioCtx.createGain();

    editorGuideOsc.type = 'triangle';
    editorGuideGain.gain.setValueAtTime(0.0001, editorAudioCtx.currentTime);

    editorGuideOsc.connect(editorGuideGain);
    editorGuideGain.connect(editorAudioCtx.destination);
    editorGuideOsc.start();
  } catch (err) {
    console.warn('Could not initialize guide tone oscillator:', err);
  }
}

function updateEditorGuideTone(currentTime) {
  if (!editorGuideOsc || !editorGuideGain || !editorAudioCtx || !editorState.isGuideToneEnabled) return;

  const activeNote = editorState.notes.find((n) => currentTime >= n.startTime && currentTime <= n.endTime);
  const now = editorAudioCtx.currentTime;

  if (activeNote) {
    const freq = 440 * Math.pow(2, (activeNote.midi - 69) / 12);
    editorGuideOsc.frequency.setTargetAtTime(freq, now, 0.012);
    editorGuideGain.gain.setTargetAtTime(0.20, now, 0.02);
  } else {
    editorGuideGain.gain.setTargetAtTime(0.0001, now, 0.02);
  }
}

function stopEditorGuideTone() {
  if (editorGuideGain && editorAudioCtx) {
    try {
      editorGuideGain.gain.setTargetAtTime(0.0001, editorAudioCtx.currentTime, 0.01);
    } catch (_) {}
  }
  if (editorGuideOsc) {
    try {
      editorGuideOsc.stop(editorAudioCtx.currentTime + 0.05);
      editorGuideOsc.disconnect();
    } catch (_) {}
    editorGuideOsc = null;
  }
}

function playSinglePitchTone(midi, durationSec = 0.14) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationSec + 0.02);
    setTimeout(() => {
      try { ctx.close(); } catch (_) {}
    }, (durationSec + 0.1) * 1000);
  } catch (_) {}
}

function toggleEditorGuideTone() {
  editorState.isGuideToneEnabled = !editorState.isGuideToneEnabled;
  const btn = document.getElementById('btnEditorGuideTone');
  if (btn) {
    if (editorState.isGuideToneEnabled) {
      btn.classList.add('active');
      btn.textContent = '🔔 Tone ON';
      btn.title = 'Synthetic guide tone is enabled';
    } else {
      btn.classList.remove('active');
      btn.textContent = '🔕 Tone OFF';
      btn.title = 'Synthetic guide tone is muted';
    }
  }
  if (!editorState.isGuideToneEnabled) {
    stopEditorGuideTone();
  } else if (editorState.isPlayingPreview && editorState.previewAudio) {
    startEditorGuideTone();
  }
}

async function loadEditorWaveform(audioUrl) {
  if (!audioUrl) return;
  try {
    const statusEl = document.getElementById('editorStatusText');
    if (statusEl) statusEl.textContent = 'Loading vocal waveform...';

    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const tempCtx = new AudioContextClass();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const bucketRate = 50; // 50 samples/sec (20ms resolution)
    const totalBuckets = Math.ceil(duration * bucketRate);
    const peaks = new Float32Array(totalBuckets);
    const channelData = audioBuffer.getChannelData(0);
    const samplesPerBucket = Math.floor(sampleRate / bucketRate);

    for (let b = 0; b < totalBuckets; b++) {
      const startSample = b * samplesPerBucket;
      const endSample = Math.min(channelData.length, startSample + samplesPerBucket);
      let maxVal = 0;
      for (let s = startSample; s < endSample; s += 4) {
        const v = Math.abs(channelData[s]);
        if (v > maxVal) maxVal = v;
      }
      peaks[b] = maxVal;
    }

    let globalMax = 0;
    for (let i = 0; i < peaks.length; i++) {
      if (peaks[i] > globalMax) globalMax = peaks[i];
    }
    if (globalMax > 0.001) {
      for (let i = 0; i < peaks.length; i++) {
        peaks[i] = peaks[i] / globalMax;
      }
    }

    editorState.waveformPeaks = peaks;
    editorState.waveformDuration = duration;
    editorState.waveformSampleRate = bucketRate;

    if (statusEl && editorState.isOpen) {
      statusEl.textContent = 'Vocal waveform loaded. Click a note to select, or press Spacebar to preview.';
    }
    if (editorState.isOpen) {
      renderChartEditorCanvas();
    }
    try { tempCtx.close(); } catch (_) {}
  } catch (err) {
    console.warn('Could not load vocal waveform:', err);
    const statusEl = document.getElementById('editorStatusText');
    if (statusEl && editorState.isOpen) {
      statusEl.textContent = 'Click a note to select, or press Spacebar to preview.';
    }
  }
}

function initChartEditor() {
  const modal = document.getElementById('modalChartEditor');
  const btnClose = document.getElementById('btnCloseChartEditor');
  const btnSave = document.getElementById('btnSaveChart');
  const canvas = document.getElementById('editorCanvas');

  if (btnClose && modal) {
    btnClose.addEventListener('click', closeChartEditor);
  }

  if (btnSave) {
    btnSave.addEventListener('click', saveChartEditorChanges);
  }

  // Pitch Shift Toolbar Buttons
  const btnShiftOctaveDown = document.getElementById('btnShiftOctaveDown');
  if (btnShiftOctaveDown) btnShiftOctaveDown.addEventListener('click', () => shiftSelectedNotePitch(-12));

  const btnShiftPitchDown = document.getElementById('btnShiftPitchDown');
  if (btnShiftPitchDown) btnShiftPitchDown.addEventListener('click', () => shiftSelectedNotePitch(-1));

  const btnShiftPitchUp = document.getElementById('btnShiftPitchUp');
  if (btnShiftPitchUp) btnShiftPitchUp.addEventListener('click', () => shiftSelectedNotePitch(1));

  const btnShiftOctaveUp = document.getElementById('btnShiftOctaveUp');
  if (btnShiftOctaveUp) btnShiftOctaveUp.addEventListener('click', () => shiftSelectedNotePitch(12));

  // Timing Nudge Toolbar Buttons
  const btnNudgeStartLeft = document.getElementById('btnNudgeStartLeft');
  if (btnNudgeStartLeft) btnNudgeStartLeft.addEventListener('click', () => nudgeSelectedNoteTiming(-0.05, 0));

  const btnNudgeStartRight = document.getElementById('btnNudgeStartRight');
  if (btnNudgeStartRight) btnNudgeStartRight.addEventListener('click', () => nudgeSelectedNoteTiming(0.05, 0));

  const btnNudgeEndLeft = document.getElementById('btnNudgeEndLeft');
  if (btnNudgeEndLeft) btnNudgeEndLeft.addEventListener('click', () => nudgeSelectedNoteTiming(0, -0.05));

  const btnNudgeEndRight = document.getElementById('btnNudgeEndRight');
  if (btnNudgeEndRight) btnNudgeEndRight.addEventListener('click', () => nudgeSelectedNoteTiming(0, 0.05));

  // Shift All Notes Buttons (Phase 8)
  const btnShiftAllTimeEarlier = document.getElementById('btnShiftAllTimeEarlier');
  if (btnShiftAllTimeEarlier) btnShiftAllTimeEarlier.addEventListener('click', () => shiftAllNotesTiming(-0.10));

  const btnShiftAllTimeLater = document.getElementById('btnShiftAllTimeLater');
  if (btnShiftAllTimeLater) btnShiftAllTimeLater.addEventListener('click', () => shiftAllNotesTiming(0.10));

  const btnShiftAllPitchDown = document.getElementById('btnShiftAllPitchDown');
  if (btnShiftAllPitchDown) btnShiftAllPitchDown.addEventListener('click', () => shiftAllNotesPitch(-1));

  const btnShiftAllPitchUp = document.getElementById('btnShiftAllPitchUp');
  if (btnShiftAllPitchUp) btnShiftAllPitchUp.addEventListener('click', () => shiftAllNotesPitch(1));

  // Guide Tone Toggle Button (Phase 8)
  const btnGuideTone = document.getElementById('btnEditorGuideTone');
  if (btnGuideTone) btnGuideTone.addEventListener('click', toggleEditorGuideTone);

  // Note Text Input
  const inputText = document.getElementById('inputEditorSyllableText');
  if (inputText) {
    inputText.addEventListener('input', (e) => {
      if (editorState.selectedNoteIndex >= 0 && editorState.notes[editorState.selectedNoteIndex]) {
        editorState.notes[editorState.selectedNoteIndex].text = e.target.value;
        renderChartEditorCanvas();
      }
    });
  }

  // Split and Delete Buttons
  const btnSplit = document.getElementById('btnEditorSplitNote');
  if (btnSplit) btnSplit.addEventListener('click', splitSelectedNote);

  const btnDelete = document.getElementById('btnEditorDeleteNote');
  if (btnDelete) btnDelete.addEventListener('click', deleteSelectedNote);

  // Zoom Toolbar Buttons
  const btnZoomIn = document.getElementById('btnEditorZoomIn');
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      editorState.viewportDuration = Math.max(2, editorState.viewportDuration * 0.75);
      renderChartEditorCanvas();
    });
  }
  const btnZoomOut = document.getElementById('btnEditorZoomOut');
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      editorState.viewportDuration = Math.min(30, editorState.viewportDuration * 1.33);
      renderChartEditorCanvas();
    });
  }

  // Transport Buttons
  const btnRewind = document.getElementById('btnEditorRewind');
  if (btnRewind) {
    btnRewind.addEventListener('click', () => {
      editorState.scrollTime = Math.max(0, editorState.scrollTime - 2.0);
      renderChartEditorCanvas();
    });
  }
  const btnForward = document.getElementById('btnEditorForward');
  if (btnForward) {
    btnForward.addEventListener('click', () => {
      editorState.scrollTime += 2.0;
      renderChartEditorCanvas();
    });
  }

  const btnPlayPause = document.getElementById('btnEditorPlayPause');
  if (btnPlayPause) {
    btnPlayPause.addEventListener('click', toggleEditorAudioPreview);
  }

  // Canvas Mouse Interactions (Drag & Drop, Resize, Pan, Select)
  if (canvas) {
    canvas.addEventListener('mousedown', onEditorCanvasMouseDown);
    window.addEventListener('mousemove', onEditorCanvasMouseMove);
    window.addEventListener('mouseup', onEditorCanvasMouseUp);
    canvas.addEventListener('wheel', onEditorCanvasWheel, { passive: false });
  }

  window.addEventListener('resize', () => {
    if (editorState.isOpen) {
      resizeEditorCanvas();
      renderChartEditorCanvas();
    }
  });
}

function openChartEditorFromStage() {
  if (!state.currentSong || !state.notes || state.notes.length === 0) {
    showToast('Please select a song first or load a track from your library.', 'warning');
    return;
  }
  const songMeta = {
    ...state.currentSong,
    slug: state.currentSong.slug || null,
  };
  openChartEditor(songMeta, state.notes);
}

function openChartEditorForSong(song, txtContent) {
  const parsed = parseUltraStarTxt(txtContent);
  const trackNotes = (parsed.tracks && parsed.tracks[0] && parsed.tracks[0].notes) ? parsed.tracks[0].notes : [];
  const songMeta = {
    slug: song.slug,
    trackName: song.title || parsed.title,
    artistName: song.artist || parsed.artist,
    instrumentalUrl: song.instrumentalUrl,
    vocalsUrl: song.vocalsUrl,
  };
  openChartEditor(songMeta, trackNotes);
}

function openChartEditor(songMeta, initialNotes) {
  editorState.isOpen = true;
  editorState.slug = songMeta.slug || null;
  editorState.songMeta = songMeta;
  editorState.notes = (initialNotes || []).map((n, idx) => ({
    id: idx + 1,
    startTime: n.startTime,
    endTime: n.endTime,
    duration: n.duration || (n.endTime - n.startTime),
    midi: Math.round(n.midi),
    text: n.text || '',
    isGolden: !!n.isGolden,
  }));
  editorState.selectedNoteIndex = -1;

  // Compute bounding pitches
  const pitches = editorState.notes.map((n) => n.midi).filter((m) => !isNaN(m) && m > 0);
  if (pitches.length > 0) {
    editorState.minMidi = Math.max(24, Math.min(...pitches) - 4);
    editorState.maxMidi = Math.min(108, Math.max(...pitches) + 4);
  } else {
    editorState.minMidi = 48;
    editorState.maxMidi = 76;
  }

  // Scroll to first note
  if (editorState.notes.length > 0) {
    editorState.scrollTime = Math.max(0, editorState.notes[0].startTime - 1.0);
  } else {
    editorState.scrollTime = 0;
  }

  const titleEl = document.getElementById('editorSongTitle');
  if (titleEl) {
    const slugLabel = editorState.slug ? ` [${editorState.slug}]` : '';
    titleEl.textContent = `${songMeta.artistName ? songMeta.artistName + ' - ' : ''}${songMeta.trackName || 'Song'}${slugLabel}`;
  }

  updateSelectedNoteUI();

  // Load vocal waveform in background (Phase 8)
  editorState.waveformPeaks = null;
  editorState.waveformDuration = 0;
  const vocalAudioUrl = songMeta.vocalsUrl || songMeta.instrumentalUrl || null;
  if (vocalAudioUrl) {
    loadEditorWaveform(vocalAudioUrl);
  }

  const modal = document.getElementById('modalChartEditor');
  if (modal) modal.classList.remove('hidden');

  setTimeout(() => {
    resizeEditorCanvas();
    renderChartEditorCanvas();
  }, 50);
}

function closeChartEditor() {
  editorState.isOpen = false;
  if (editorState.isPlayingPreview && editorState.previewAudio) {
    try {
      editorState.previewAudio.pause();
    } catch (_) {}
  }
  stopEditorGuideTone();
  editorState.isPlayingPreview = false;
  if (editorState.previewTimer) {
    clearInterval(editorState.previewTimer);
    editorState.previewTimer = null;
  }
  const modal = document.getElementById('modalChartEditor');
  if (modal) modal.classList.add('hidden');
}

function resizeEditorCanvas() {
  const canvas = document.getElementById('editorCanvas');
  const container = document.getElementById('editorCanvasContainer');
  if (!canvas || !container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
  }
}

function renderChartEditorCanvas() {
  const canvas = document.getElementById('editorCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Background
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#090c1a');
  bgGrad.addColorStop(1, '#0c1024');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  const leftMargin = 50;
  const timeW = W - leftMargin;
  const topMargin = 26;
  const bottomMargin = 28;
  const usableH = H - topMargin - bottomMargin;

  const minM = editorState.minMidi;
  const maxM = editorState.maxMidi;
  const numLanes = Math.max(1, maxM - minM + 1);
  const laneHeight = usableH / numLanes;

  const midiToY = (m) => topMargin + (maxM - m) * laneHeight;
  const timeToX = (t) => leftMargin + ((t - editorState.scrollTime) / editorState.viewportDuration) * timeW;

  // 1. Horizontal Pitch Lanes & Piano Labels
  for (let m = minM; m <= maxM; m++) {
    const y = midiToY(m);
    const isC = m % 12 === 0;
    const isBlackKey = [1, 3, 6, 8, 10].includes(m % 12);

    if (isBlackKey) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(leftMargin, y, timeW, laneHeight);
    }

    ctx.strokeStyle = isC ? 'rgba(0, 242, 254, 0.25)' : 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = isC ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(leftMargin, y);
    ctx.lineTo(W, y);
    ctx.stroke();

    ctx.fillStyle = isC ? '#00f2fe' : (isBlackKey ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.85)');
    ctx.font = isC ? 'bold 11px sans-serif' : '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${midiToNoteName(m)} (${m})`, leftMargin - 6, y + laneHeight * 0.75);
  }

  // 2. Vocal Waveform Overlay (Phase 8: Background of notes)
  if (editorState.waveformPeaks && editorState.waveformPeaks.length > 0) {
    const peaks = editorState.waveformPeaks;
    const bucketRate = editorState.waveformSampleRate || 50;
    const centerY = topMargin + usableH / 2;
    const maxWaveHeight = usableH * 0.42;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 242, 254, 0.14)';
    const stepPx = 2;
    for (let px = leftMargin; px < W; px += stepPx) {
      const timeAtPx = editorState.scrollTime + ((px - leftMargin) / timeW) * editorState.viewportDuration;
      if (timeAtPx < 0 || timeAtPx > editorState.waveformDuration) continue;
      const bucketIdx = Math.floor(timeAtPx * bucketRate);
      if (bucketIdx >= 0 && bucketIdx < peaks.length) {
        const amp = peaks[bucketIdx];
        if (amp > 0.02) {
          const barH = Math.max(2, amp * maxWaveHeight);
          ctx.fillRect(px, centerY - barH, stepPx, barH * 2);
        }
      }
    }
    ctx.restore();
  }

  // 3. Vertical Time Grid Lines
  const startTimeSec = Math.floor(editorState.scrollTime);
  const endTimeSec = Math.ceil(editorState.scrollTime + editorState.viewportDuration);

  ctx.textAlign = 'center';
  ctx.font = '10px monospace';

  for (let s = startTimeSec; s <= endTimeSec; s++) {
    const x = timeToX(s);
    if (x < leftMargin || x > W) continue;

    ctx.strokeStyle = (s % 5 === 0) ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = (s % 5 === 0) ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x, topMargin);
    ctx.lineTo(x, H - bottomMargin);
    ctx.stroke();

    ctx.fillStyle = (s % 5 === 0) ? '#ffcf33' : 'rgba(255, 255, 255, 0.5)';
    ctx.fillText(`${s.toFixed(0)}s`, x, topMargin - 8);
    ctx.fillText(`${s.toFixed(0)}s`, x, H - 10);
  }

  // 4. Render Note Blocks
  const visualGap = 2;

  for (let i = 0; i < editorState.notes.length; i++) {
    const note = editorState.notes[i];
    if (note.endTime < editorState.scrollTime - 0.5 || note.startTime > editorState.scrollTime + editorState.viewportDuration + 0.5) {
      continue;
    }

    const x1 = Math.max(leftMargin, timeToX(note.startTime));
    const x2 = timeToX(note.endTime);
    const rawW = Math.max(8, x2 - timeToX(note.startTime));
    const drawW = Math.max(6, rawW - visualGap);
    const y = midiToY(note.midi) + 1;
    const drawH = Math.max(8, laneHeight - 2);

    const isSelected = i === editorState.selectedNoteIndex;

    if (isSelected) {
      ctx.fillStyle = 'rgba(0, 242, 254, 0.65)';
      ctx.strokeStyle = '#00f2fe';
      ctx.lineWidth = 2.5;
    } else if (note.isGolden) {
      ctx.fillStyle = 'rgba(255, 207, 51, 0.55)';
      ctx.strokeStyle = '#ffcf33';
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = 'rgba(180, 110, 255, 0.5)';
      ctx.strokeStyle = '#d8b4fe';
      ctx.lineWidth = 1.2;
    }

    roundRect(ctx, x1, y, drawW, drawH, 4);
    ctx.fill();
    ctx.stroke();

    // Selected Note Handle Bars on borders (Phase 8: drag resize affordance)
    if (isSelected) {
      ctx.fillStyle = '#00f2fe';
      // Left border handle
      ctx.fillRect(x1, y, 4, drawH);
      // Right border handle
      ctx.fillRect(x1 + drawW - 4, y, 4, drawH);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    const textLabel = note.text ? `${note.text.trim()} [${note.midi}]` : `[${note.midi}]`;
    ctx.fillText(textLabel, x1 + 6, y + drawH * 0.72);
  }

  // 5. Playhead
  if (editorState.isPlayingPreview && editorState.previewAudio) {
    const curTime = editorState.previewAudio.currentTime;
    const curX = timeToX(curTime);
    if (curX >= leftMargin && curX <= W) {
      ctx.strokeStyle = '#ff2a85';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(curX, topMargin);
      ctx.lineTo(curX, H - bottomMargin);
      ctx.stroke();
    }
  }
}

function onEditorCanvasMouseDown(e) {
  const canvas = document.getElementById('editorCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const leftMargin = 50;
  const timeW = canvas.width - leftMargin;
  const topMargin = 26;
  const bottomMargin = 28;
  const usableH = canvas.height - topMargin - bottomMargin;
  const laneHeight = usableH / Math.max(1, editorState.maxMidi - editorState.minMidi + 1);

  const midiToY = (m) => topMargin + (editorState.maxMidi - m) * laneHeight;
  const timeToX = (t) => leftMargin + ((t - editorState.scrollTime) / editorState.viewportDuration) * timeW;

  editorState.dragStartX = mx;
  editorState.dragStartY = my;
  editorState.dragInitialScroll = editorState.scrollTime;

  let clickedNoteIdx = -1;
  let clickedMode = 'move';
  const borderThresholdPx = 10;

  for (let i = editorState.notes.length - 1; i >= 0; i--) {
    const n = editorState.notes[i];
    const nx1 = timeToX(n.startTime);
    const nx2 = timeToX(n.endTime);
    const ny = midiToY(n.midi);

    if (mx >= nx1 - 4 && mx <= nx2 + 4 && my >= ny && my <= ny + laneHeight) {
      clickedNoteIdx = i;
      if (mx <= nx1 + borderThresholdPx) {
        clickedMode = 'resize-start';
      } else if (mx >= nx2 - borderThresholdPx) {
        clickedMode = 'resize-end';
      } else {
        clickedMode = 'move';
      }
      break;
    }
  }

  if (clickedNoteIdx >= 0) {
    editorState.selectedNoteIndex = clickedNoteIdx;
    editorState.isDragging = true;
    editorState.dragMode = clickedMode;
    editorState.dragInitialNote = { ...editorState.notes[clickedNoteIdx] };
    playSinglePitchTone(editorState.notes[clickedNoteIdx].midi, 0.12);
  } else {
    editorState.isDragging = true;
    editorState.dragMode = 'pan';
  }

  updateSelectedNoteUI();
  renderChartEditorCanvas();
}

function onEditorCanvasMouseMove(e) {
  const canvas = document.getElementById('editorCanvas');
  if (!canvas || !editorState.isOpen) return;

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const leftMargin = 50;
  const timeW = canvas.width - leftMargin;
  const topMargin = 26;
  const bottomMargin = 28;
  const usableH = canvas.height - topMargin - bottomMargin;
  const laneHeight = usableH / Math.max(1, editorState.maxMidi - editorState.minMidi + 1);

  const midiToY = (m) => topMargin + (editorState.maxMidi - m) * laneHeight;
  const timeToX = (t) => leftMargin + ((t - editorState.scrollTime) / editorState.viewportDuration) * timeW;

  if (!editorState.isDragging) {
    // Dynamic hover cursor feedback
    let hoverCursor = 'crosshair';
    const borderThresholdPx = 10;
    for (let i = editorState.notes.length - 1; i >= 0; i--) {
      const n = editorState.notes[i];
      const nx1 = timeToX(n.startTime);
      const nx2 = timeToX(n.endTime);
      const ny = midiToY(n.midi);

      if (mx >= nx1 - 4 && mx <= nx2 + 4 && my >= ny && my <= ny + laneHeight) {
        if (mx <= nx1 + borderThresholdPx || mx >= nx2 - borderThresholdPx) {
          hoverCursor = 'ew-resize';
        } else {
          hoverCursor = 'grab';
        }
        break;
      }
    }
    canvas.style.cursor = hoverCursor;
    return;
  }

  // Active dragging cursor
  canvas.style.cursor = (editorState.dragMode === 'resize-start' || editorState.dragMode === 'resize-end')
    ? 'ew-resize'
    : 'grabbing';

  const deltaX = mx - editorState.dragStartX;
  const deltaY = my - editorState.dragStartY;
  const deltaSec = (deltaX / timeW) * editorState.viewportDuration;

  if (editorState.dragMode === 'pan') {
    editorState.scrollTime = Math.max(0, editorState.dragInitialScroll - deltaSec);
    renderChartEditorCanvas();
    return;
  }

  if (editorState.selectedNoteIndex < 0 || !editorState.dragInitialNote) return;
  const curNote = editorState.notes[editorState.selectedNoteIndex];

  if (editorState.dragMode === 'resize-start') {
    const newStart = Math.min(editorState.dragInitialNote.endTime - 0.03, Math.max(0, editorState.dragInitialNote.startTime + deltaSec));
    curNote.startTime = Math.round(newStart * 100) / 100;
    curNote.duration = Math.round((curNote.endTime - curNote.startTime) * 100) / 100;
  } else if (editorState.dragMode === 'resize-end') {
    const newEnd = Math.max(curNote.startTime + 0.03, editorState.dragInitialNote.endTime + deltaSec);
    curNote.endTime = Math.round(newEnd * 100) / 100;
    curNote.duration = Math.round((curNote.endTime - curNote.startTime) * 100) / 100;
  } else if (editorState.dragMode === 'move') {
    const dur = editorState.dragInitialNote.endTime - editorState.dragInitialNote.startTime;
    const newStart = Math.max(0, editorState.dragInitialNote.startTime + deltaSec);
    curNote.startTime = Math.round(newStart * 100) / 100;
    curNote.endTime = Math.round((curNote.startTime + dur) * 100) / 100;

    const semitoneDelta = Math.round(-deltaY / laneHeight);
    const newMidi = Math.max(24, Math.min(108, editorState.dragInitialNote.midi + semitoneDelta));
    if (newMidi !== curNote.midi) {
      curNote.midi = newMidi;
      playSinglePitchTone(newMidi, 0.08);
    }
  }

  updateSelectedNoteUI();
  renderChartEditorCanvas();
}

function onEditorCanvasMouseUp() {
  if (editorState.isDragging) {
    editorState.isDragging = false;
    editorState.dragMode = null;
    editorState.dragInitialNote = null;
    renderChartEditorCanvas();
  }
}

function onEditorCanvasWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const factor = e.deltaY > 0 ? 1.15 : 0.85;
    editorState.viewportDuration = Math.max(2, Math.min(30, editorState.viewportDuration * factor));
  } else {
    const scrollDelta = (e.deltaY / 100) * (editorState.viewportDuration * 0.15);
    editorState.scrollTime = Math.max(0, editorState.scrollTime + scrollDelta);
  }
  renderChartEditorCanvas();
}

function shiftSelectedNotePitch(delta) {
  if (editorState.selectedNoteIndex < 0 || !editorState.notes[editorState.selectedNoteIndex]) return;
  const note = editorState.notes[editorState.selectedNoteIndex];
  note.midi = Math.max(24, Math.min(108, note.midi + delta));

  if (note.midi < editorState.minMidi + 2) editorState.minMidi = Math.max(24, note.midi - 3);
  if (note.midi > editorState.maxMidi - 2) editorState.maxMidi = Math.min(108, note.midi + 3);

  playSinglePitchTone(note.midi, 0.15);
  updateSelectedNoteUI();
  renderChartEditorCanvas();
}

function nudgeSelectedNoteTiming(deltaStart, deltaEnd) {
  if (editorState.selectedNoteIndex < 0 || !editorState.notes[editorState.selectedNoteIndex]) return;
  const note = editorState.notes[editorState.selectedNoteIndex];

  if (deltaStart !== 0) {
    note.startTime = Math.max(0, Math.round((note.startTime + deltaStart) * 100) / 100);
    if (note.endTime < note.startTime + 0.03) {
      note.endTime = note.startTime + 0.03;
    }
  }

  if (deltaEnd !== 0) {
    note.endTime = Math.max(note.startTime + 0.03, Math.round((note.endTime + deltaEnd) * 100) / 100);
  }

  note.duration = Math.round((note.endTime - note.startTime) * 100) / 100;
  updateSelectedNoteUI();
  renderChartEditorCanvas();
}

function shiftAllNotesTiming(deltaSec) {
  if (!editorState.notes || editorState.notes.length === 0) return;
  const minStart = Math.min(...editorState.notes.map((n) => n.startTime));
  let safeDelta = deltaSec;
  if (minStart + deltaSec < 0) {
    safeDelta = -minStart;
  }
  if (Math.abs(safeDelta) < 0.0001) {
    showToast('Cannot shift notes earlier than 0.00s', 'warning');
    return;
  }
  for (const n of editorState.notes) {
    n.startTime = Math.max(0, Math.round((n.startTime + safeDelta) * 1000) / 1000);
    n.endTime = Math.max(n.startTime + 0.03, Math.round((n.endTime + safeDelta) * 1000) / 1000);
    n.duration = Math.round((n.endTime - n.startTime) * 1000) / 1000;
  }
  updateSelectedNoteUI();
  renderChartEditorCanvas();
  const sign = safeDelta > 0 ? '+' : '';
  showToast(`Shifted all notes by ${sign}${(safeDelta * 1000).toFixed(0)} ms`, 'info', 1500);
}

function shiftAllNotesPitch(semitones) {
  if (!editorState.notes || editorState.notes.length === 0) return;
  for (const n of editorState.notes) {
    n.midi = Math.max(24, Math.min(108, n.midi + semitones));
  }
  const pitches = editorState.notes.map((n) => n.midi).filter((m) => !isNaN(m) && m > 0);
  if (pitches.length > 0) {
    editorState.minMidi = Math.max(24, Math.min(...pitches) - 4);
    editorState.maxMidi = Math.min(108, Math.max(...pitches) + 4);
  }
  if (editorState.selectedNoteIndex >= 0 && editorState.notes[editorState.selectedNoteIndex]) {
    playSinglePitchTone(editorState.notes[editorState.selectedNoteIndex].midi, 0.15);
  }
  updateSelectedNoteUI();
  renderChartEditorCanvas();
  const sign = semitones > 0 ? '+' : '';
  showToast(`Transposed all notes by ${sign}${semitones} semitone(s)`, 'info', 1500);
}

function splitSelectedNote() {
  if (editorState.selectedNoteIndex < 0 || !editorState.notes[editorState.selectedNoteIndex]) return;
  const note = editorState.notes[editorState.selectedNoteIndex];
  const dur = note.endTime - note.startTime;
  if (dur < 0.10) {
    showToast('Note is too short to split (min. 100 ms required).', 'warning');
    return;
  }

  const midTime = Math.round((note.startTime + dur / 2) * 100) / 100;
  const origEnd = note.endTime;
  const origText = note.text ? note.text.trim().replace(/-$/, '') : '';

  note.endTime = midTime;
  note.duration = midTime - note.startTime;
  note.text = `${origText}-`;

  const newNote = {
    id: Date.now(),
    startTime: midTime,
    endTime: origEnd,
    duration: origEnd - midTime,
    midi: note.midi,
    text: '~ ',
    isGolden: note.isGolden,
  };

  editorState.notes.splice(editorState.selectedNoteIndex + 1, 0, newNote);
  editorState.selectedNoteIndex += 1;

  updateSelectedNoteUI();
  renderChartEditorCanvas();
}

function deleteSelectedNote() {
  if (editorState.selectedNoteIndex < 0 || !editorState.notes[editorState.selectedNoteIndex]) return;
  editorState.notes.splice(editorState.selectedNoteIndex, 1);
  editorState.selectedNoteIndex = Math.min(editorState.selectedNoteIndex, editorState.notes.length - 1);

  updateSelectedNoteUI();
  renderChartEditorCanvas();
}

function updateSelectedNoteUI() {
  const infoEl = document.getElementById('editorSelectedNoteInfo');
  const inputEl = document.getElementById('inputEditorSyllableText');

  if (editorState.selectedNoteIndex >= 0 && editorState.notes[editorState.selectedNoteIndex]) {
    const n = editorState.notes[editorState.selectedNoteIndex];
    if (infoEl) {
      infoEl.textContent = `Syllable: "${n.text.trim()}" | Start: ${n.startTime.toFixed(2)}s | Duration: ${(n.duration * 1000).toFixed(0)}ms | Pitch: ${midiToNoteName(n.midi)} (MIDI ${n.midi})`;
    }
    if (inputEl) {
      inputEl.value = n.text;
    }
  } else {
    if (infoEl) {
      infoEl.textContent = `Total notes: ${editorState.notes.length} | No note selected`;
    }
    if (inputEl) {
      inputEl.value = '';
    }
  }
}

function toggleEditorAudioPreview() {
  const btn = document.getElementById('btnEditorPlayPause');
  const instUrl = editorState.songMeta?.instrumentalUrl || (state.currentSong?.instrumentalUrl || null);
  const vocalUrl = editorState.songMeta?.vocalsUrl || (state.currentSong?.vocalsUrl || null);
  const audioUrl = instUrl || vocalUrl;

  if (!audioUrl) {
    showToast('No audio file available for preview.', 'warning');
    return;
  }

  if (editorState.isPlayingPreview && editorState.previewAudio) {
    editorState.previewAudio.pause();
    editorState.isPlayingPreview = false;
    stopEditorGuideTone();
    if (btn) btn.textContent = '▶ Play';
    if (editorState.previewTimer) {
      clearInterval(editorState.previewTimer);
      editorState.previewTimer = null;
    }
    renderChartEditorCanvas();
    return;
  }

  if (!editorState.previewAudio) {
    editorState.previewAudio = new Audio(audioUrl);
    editorState.previewAudio.addEventListener('ended', () => {
      editorState.isPlayingPreview = false;
      stopEditorGuideTone();
      if (btn) btn.textContent = '▶ Play';
      if (editorState.previewTimer) {
        clearInterval(editorState.previewTimer);
        editorState.previewTimer = null;
      }
      renderChartEditorCanvas();
    });
  }

  editorState.previewAudio.currentTime = Math.max(0, editorState.scrollTime);
  startEditorGuideTone();

  editorState.previewAudio.play().then(() => {
    editorState.isPlayingPreview = true;
    if (btn) btn.textContent = '⏸ Pause';
    editorState.previewTimer = setInterval(() => {
      if (editorState.previewAudio) {
        const cur = editorState.previewAudio.currentTime;
        updateEditorGuideTone(cur);
        if (cur > editorState.scrollTime + editorState.viewportDuration - 0.2) {
          editorState.scrollTime = cur - 0.5;
        }
        renderChartEditorCanvas();
      }
    }, 25);
  }).catch((err) => {
    stopEditorGuideTone();
    showToast('Playback error: ' + err.message, 'error');
  });
}

async function saveChartEditorChanges() {
  if (editorState.notes.length === 0) {
    showToast('No notes to save.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btnSaveChart');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    const title = editorState.songMeta?.trackName || 'Song';
    const artist = editorState.songMeta?.artistName || 'Unknown Artist';
    const displayBpm = state.displayBpm || 120;

    const lines = [];
    lines.push(`#TITLE:${title}`);
    lines.push(`#ARTIST:${artist}`);
    lines.push('#BPM:1500');
    lines.push(`#REALBPM:${displayBpm}`);
    lines.push('#GAP:0');
    if (editorState.songMeta?.videoId) {
      lines.push(`#VIDEO:v=${editorState.songMeta.videoId}`);
    }

    const sortedNotes = [...editorState.notes].sort((a, b) => a.startTime - b.startTime);
    let lastEndBeat = 0;

    for (let i = 0; i < sortedNotes.length; i++) {
      const n = sortedNotes[i];
      const sBeat = Math.round(n.startTime / 0.01);
      const eBeat = Math.round(n.endTime / 0.01);
      const dBeat = Math.max(3, eBeat - sBeat);

      if (i > 0) {
        const prevN = sortedNotes[i - 1];
        const gapSec = n.startTime - prevN.endTime;
        if (gapSec >= 0.50) {
          const pauseBeat = Math.round((prevN.endTime + gapSec / 2) / 0.01);
          lines.push(`- ${pauseBeat}`);
          lastEndBeat = Math.max(lastEndBeat, pauseBeat);
        }
      }

      const prefix = n.isGolden ? '*' : ':';
      const textVal = n.text || '';
      lines.push(`${prefix} ${sBeat} ${dBeat} ${Math.round(n.midi)} ${textVal}`);
      lastEndBeat = sBeat + dBeat;
    }

    lines.push('E');
    const chartText = lines.join('\n') + '\n';

    const slug = editorState.slug || (state.currentSong?.slug || null);
    if (slug) {
      const res = await fetch(`/api/library/${encodeURIComponent(slug)}/chart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chartText }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
    } else {
      const blob = new Blob([chartText], { type: 'text/plain;charset=utf-8' });
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${artist} - ${title}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    }

    if (state.currentSong) {
      await applyParsedUltraStarChart(chartText, editorState.songMeta || state.currentSong);
    }

    const statusEl = document.getElementById('editorStatusText');
    if (statusEl) {
      statusEl.textContent = `✓ Chart saved successfully! (${sortedNotes.length} notes, meta.json.edited = true)`;
      statusEl.style.color = '#18e882';
    }

    showToast('Chart saved successfully! The changes are immediately active in the game.', 'success');
    if (slug) {
      await loadLibrarySongs();
    }
  } catch (err) {
    showToast(`Error saving chart: ${err.message}`, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
}


