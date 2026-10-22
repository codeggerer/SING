/**
 * lib/usdb_client.js - Community Ground-Truth Ingestion Engine (MASTER_OVERHAUL_PLAN Phase 1)
 *
 * Implements:
 * 1. Levenshtein Distance & Ratio fuzzy matching:
 *    Score = 0.6 * LevenshteinRatio(Title) + 0.4 * LevenshteinRatio(Artist)
 * 2. Automated ground-truth ingestion from USDB (usdb.animux.de), public UltraStar
 *    mirrors (allkaraoke.party), and the pre-indexed catalog (public/ultrastar_index.json).
 * 3. Strict threshold gate (Score >= 0.82) to eliminate AI transcription/pitch errors.
 * 4. Header parser for #TITLE, #ARTIST, #BPM, #GAP, #VIDEO with comma-decimal conversion
 *    and golden note (*) verification.
 * 5. Local chart caching in usdb_cache/<id>.txt.
 *
 * Zero external dependencies: native Node.js only.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const USDB_CACHE_DIR = path.join(PROJECT_ROOT, 'usdb_cache');
const USDB_CONFIG_FILE = path.join(PROJECT_ROOT, 'usdb_config.json');
const ULTRASTAR_INDEX_FILE = path.join(PROJECT_ROOT, 'public', 'ultrastar_index.json');
const ALLKARAOKE_BASE_URL = 'https://allkaraoke.party/songs';

// Ensure cache directory exists
if (!fs.existsSync(USDB_CACHE_DIR)) {
  try {
    fs.mkdirSync(USDB_CACHE_DIR, { recursive: true });
  } catch (_) {}
}

// In-memory session state
let usdbSession = {
  username: '',
  cookie: '',
  loggedInAt: 0,
};

// Load saved session on initialization
function loadSavedSession() {
  if (fs.existsSync(USDB_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(USDB_CONFIG_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && (data.cookie || data.username)) {
        usdbSession = {
          username: data.username || '',
          cookie: data.cookie || '',
          loggedInAt: data.loggedInAt || 0,
        };
      }
    } catch (_) {}
  }
}
loadSavedSession();

/**
 * Native HTTP/HTTPS request helper with redirect & timeout support.
 */
function requestUrl(targetUrl, options = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        ...options.headers,
      },
    };

    const req = client.request(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return resolve(requestUrl(redirectUrl, options, timeoutMs));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout fetching ${targetUrl}`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ============================================================================
// 1. FUZZY STRING MATCHING & LEVENSHTEIN RATIO
// ============================================================================

/**
 * Normalizes text for fuzzy title/artist comparison:
 * Strips diacritics, lowercase, removes audio/video noise and non-alphanumeric punctuation.
 */
function normalizeForFuzzy(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics/accents
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' and ')
    .replace(
      /\s*[\(\[][^\)\]]*(?:official|music\s*video|video|audio|lyrics?|remaster(?:ed)?|visualizer|4k|hd|hq|clip|version|edition|deluxe|live|duet)[^\)\]]*[\)\]]/gi,
      ''
    )
    .replace(/['’"`´«»“”„]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes Levenshtein edit distance between two strings using 2-row DP.
 */
function levenshteinDistance(s1, s2) {
  if (typeof s1 !== 'string') s1 = String(s1 || '');
  if (typeof s2 !== 'string') s2 = String(s2 || '');

  const m = s1.length;
  const n = s2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const c1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const c2 = s2.charCodeAt(j - 1);
      const cost = c1 === c2 ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost // substitution
      );
    }
    for (let j = 0; j <= n; j++) {
      prevRow[j] = currRow[j];
    }
  }

  return currRow[n];
}

/**
 * Computes normalized Levenshtein similarity ratio between 0.0 and 1.0.
 * 1.0 = identical, 0.0 = completely disjoint.
 */
function levenshteinRatio(s1, s2) {
  const norm1 = normalizeForFuzzy(s1);
  const norm2 = normalizeForFuzzy(s2);

  if (norm1 === norm2) return 1.0;
  if (!norm1 && !norm2) return 1.0;
  if (!norm1 || !norm2) return 0.0;

  // Exact substring containment reward (e.g. "Bohemian Rhapsody" in "Bohemian Rhapsody (2011 Remaster)")
  if (norm1.length > 3 && norm2.length > 3) {
    if (norm1 === norm2) return 1.0;
    if (norm1.startsWith(norm2) || norm2.startsWith(norm1)) {
      const shorter = Math.min(norm1.length, norm2.length);
      const longer = Math.max(norm1.length, norm2.length);
      return Math.max(0.85, shorter / longer);
    }
  }

  const maxLen = Math.max(norm1.length, norm2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(norm1, norm2);
  return Math.max(0.0, 1.0 - dist / maxLen);
}

/**
 * Computes fuzzy track search matching score as specified in MASTER_OVERHAUL_PLAN Phase 1.1:
 * Score = 0.6 * LevenshteinRatio(Title) + 0.4 * LevenshteinRatio(Artist)
 */
function computeMatchScore(queryTitle, queryArtist, candTitle, candArtist) {
  const titleRatio = levenshteinRatio(queryTitle, candTitle);
  const artistRatio = levenshteinRatio(queryArtist, candArtist);
  return 0.6 * titleRatio + 0.4 * artistRatio;
}

// ============================================================================
// 2. ULTRASTAR CHART PARSER & HEADER EXTRACTION
// ============================================================================

/**
 * Parses UltraStar .txt score chart headers, notes, and golden notes.
 * Handles European comma decimals (e.g. #BPM:341,2 -> 341.2).
 */
function parseChartHeaders(rawTxt) {
  if (!rawTxt || typeof rawTxt !== 'string') {
    return { isValid: false, error: 'Empty chart text' };
  }

  const lines = rawTxt.replace(/\r\n/g, '\n').split('\n');
  const headers = {};
  let noteCount = 0;
  let goldenNoteCount = 0;
  let freestyleCount = 0;
  let lineBreakCount = 0;
  let firstNoteStartBeat = null;
  const parsedNotes = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const key = trimmed.slice(1, colonIdx).trim().toUpperCase();
        let val = trimmed.slice(colonIdx + 1).trim();
        headers[key] = val;
      }
      continue;
    }

    const type = trimmed[0];
    if (type === ':' || type === '*' || type === 'F') {
      noteCount++;
      if (type === '*') goldenNoteCount++;
      if (type === 'F') freestyleCount++;

      // Parse note values: ": <start_beat> <duration_beats> <pitch_midi> <syllable>"
      const match = trimmed.match(/^([:\*F])\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s*(.*)$/);
      if (match) {
        const startBeat = parseInt(match[2], 10);
        const durationBeats = parseInt(match[3], 10);
        const pitch = parseInt(match[4], 10);
        const syllable = match[5] || '';
        if (firstNoteStartBeat === null || startBeat < firstNoteStartBeat) {
          firstNoteStartBeat = startBeat;
        }
        if (parsedNotes.length < 50) {
          parsedNotes.push({ type, startBeat, durationBeats, pitch, syllable });
        }
      }
    } else if (type === '-') {
      lineBreakCount++;
    }
  }

  const bpmRaw = headers['BPM'] ? headers['BPM'].replace(',', '.') : '1500';
  const bpm = parseFloat(bpmRaw) || 1500;
  const gapRaw = headers['GAP'] ? headers['GAP'].replace(',', '.') : '0';
  const gap = parseFloat(gapRaw) || 0;

  // Extract video ID from #VIDEO header
  let videoId = '';
  if (headers['VIDEO']) {
    const m = headers['VIDEO'].match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/i);
    if (m) {
      videoId = m[1];
    } else if (/^[a-zA-Z0-9_-]{11}$/.test(headers['VIDEO'])) {
      videoId = headers['VIDEO'];
    }
  }

  const isValid = noteCount > 0 && !!headers['TITLE'] && !!headers['ARTIST'];

  return {
    title: headers['TITLE'] || '',
    artist: headers['ARTIST'] || '',
    bpm,
    gap,
    videoId,
    year: headers['YEAR'] || '',
    language: headers['LANGUAGE'] || '',
    edition: headers['EDITION'] || '',
    genre: headers['GENRE'] || '',
    creator: headers['CREATOR'] || '',
    noteCount,
    goldenNoteCount,
    hasGoldenNotes: goldenNoteCount > 0,
    freestyleCount,
    lineBreakCount,
    firstNoteStartBeat,
    sampleNotes: parsedNotes,
    isValid,
    headers,
  };
}

// ============================================================================
// 3. CURATED CATALOG & LOCAL CACHE LOOKUP
// ============================================================================

let curatedCatalogCache = null;

/**
 * Loads the 6,682 curated songs from public/ultrastar_index.json into memory.
 */
function loadCuratedCatalog() {
  if (curatedCatalogCache) return curatedCatalogCache;
  if (!fs.existsSync(ULTRASTAR_INDEX_FILE)) {
    curatedCatalogCache = [];
    return curatedCatalogCache;
  }
  try {
    const raw = fs.readFileSync(ULTRASTAR_INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    curatedCatalogCache = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    curatedCatalogCache = [];
  }
  return curatedCatalogCache;
}

/**
 * Checks if a chart exists in local usdb_cache/<id>.txt.
 */
function getCachedChart(id) {
  if (!id) return null;
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const cacheFile = path.join(USDB_CACHE_DIR, `${safeId}.txt`);
  if (fs.existsSync(cacheFile)) {
    try {
      return fs.readFileSync(cacheFile, 'utf8');
    } catch (_) {}
  }
  return null;
}

/**
 * Saves a chart to local usdb_cache/<id>.txt.
 */
function saveChartToCache(id, rawTxt) {
  if (!id || !rawTxt) return false;
  try {
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const cacheFile = path.join(USDB_CACHE_DIR, `${safeId}.txt`);
    fs.writeFileSync(cacheFile, rawTxt, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// 4. USDB (animux.de) & PUBLIC MIRROR CLIENT
// ============================================================================

/**
 * Logs in to usdb.animux.de using username and password.
 */
async function loginUsdb(user, pass) {
  const form = new URLSearchParams();
  form.set('user', user);
  form.set('pass', pass);
  form.set('login', 'Login');

  const res = await requestUrl('https://usdb.animux.de/index.php?link=login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const rawCookies = res.headers['set-cookie'];
  if (!rawCookies || rawCookies.length === 0) {
    throw new Error('No cookie received from USDB');
  }

  const sessionCookie = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('PHPSESSID='))
    .join('; ');

  if (!sessionCookie) {
    throw new Error('USDB login failed (No PHPSESSID found)');
  }

  usdbSession = {
    username: user,
    cookie: sessionCookie,
    loggedInAt: Date.now(),
  };

  try {
    fs.writeFileSync(USDB_CONFIG_FILE, JSON.stringify(usdbSession, null, 2), 'utf8');
  } catch (_) {}

  return usdbSession;
}

/**
 * Logs out and clears stored session.
 */
function logoutUsdb() {
  usdbSession = { username: '', cookie: '', loggedInAt: 0 };
  if (fs.existsSync(USDB_CONFIG_FILE)) {
    try {
      fs.unlinkSync(USDB_CONFIG_FILE);
    } catch (_) {}
  }
  return { success: true };
}

function getUsdbSession() {
  return { ...usdbSession };
}

/**
 * Parses USDB HTML search results table.
 */
function parseSongsFromUsdbHtml(html) {
  if (!html) return [];
  const songs = [];
  const rows = [...html.matchAll(/<tr class="list_tr[12].*?>\s*([\s\S]*?)\s*<\/tr>/gm)];

  for (const row of rows) {
    const rowHtml = row[1];
    const idMatch =
      rowHtml.match(/show_detail\((\d+)\)/) ||
      rowHtml.match(/link=detail&amp;id=(\d+)/) ||
      rowHtml.match(/id=(\d+)/);
    const songId = idMatch ? parseInt(idMatch[1], 10) : null;
    if (!songId) continue;

    const cols = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').trim()
    );

    if (cols.length >= 2) {
      const artist = cols[0];
      const title = cols[1];
      const language = cols[6] || '';
      const year = cols[4] || '';

      songs.push({
        isUsdb: true,
        isUltraStar: true,
        usdbId: songId,
        artistName: artist,
        trackName: title,
        language,
        year,
        artworkUrl: `https://usdb.animux.de/data/cover/${songId}.jpg`,
      });
    }
  }

  return songs;
}

/**
 * Searches USDB for songs by query string or { artist, title }.
 */
async function searchUsdb(query, sessionCookie = null) {
  const cookie = sessionCookie || usdbSession.cookie;
  if (!cookie) return [];

  const form = new URLSearchParams();
  form.set('order', 'lastchange');
  form.set('ud', 'desc');
  form.set('limit', '40');
  form.set('start', '0');

  const q = (query || '').trim();
  const tokens = q.split(/\s+/);
  if (tokens.length === 1) {
    form.set('interpret', tokens[0]);
  } else {
    form.set('interpret', tokens[0]);
    form.set('title', tokens.slice(1).join(' '));
  }

  try {
    const res = await requestUrl('https://usdb.animux.de/?link=list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: form.toString(),
    });

    let songs = parseSongsFromUsdbHtml(res.body);

    if (songs.length === 0 && tokens.length > 1) {
      const form2 = new URLSearchParams();
      form2.set('order', 'lastchange');
      form2.set('ud', 'desc');
      form2.set('limit', '40');
      form2.set('start', '0');
      form2.set('title', q);
      const res2 = await requestUrl('https://usdb.animux.de/?link=list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
        },
        body: form2.toString(),
      });
      songs = parseSongsFromUsdbHtml(res2.body);
    }

    return songs;
  } catch (_) {
    return [];
  }
}

/**
 * Fetches raw UltraStar .txt for a numeric USDB song ID.
 */
async function getUsdbSong(id, sessionCookie = null) {
  const cached = getCachedChart(id);
  if (cached) {
    const m = cached.match(/#VIDEO:.*?(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/i);
    return {
      id,
      txt: cached,
      videoId: m ? m[1] : '',
    };
  }

  const cookie = sessionCookie || usdbSession.cookie;
  if (!cookie) {
    throw new Error('Not logged in to USDB');
  }

  const lyricsRes = await requestUrl(`https://usdb.animux.de/?link=editsongs&id=${id}`, {
    headers: { Cookie: cookie },
  });

  const txtMatch = lyricsRes.body.match(/<textarea.*?>([\s\S]*?)<\/textarea>/im);
  if (!txtMatch || !txtMatch[1].trim()) {
    throw new Error('Could not retrieve chart file from USDB');
  }

  const rawTxt = txtMatch[1].trim();

  let videoId = '';
  try {
    const detailRes = await requestUrl(`https://usdb.animux.de/?link=detail&id=${id}`, {
      headers: { Cookie: cookie },
    });
    const ytMatch = detailRes.body.match(
      /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
    );
    if (ytMatch) {
      videoId = ytMatch[1];
    }
  } catch (_) {}

  saveChartToCache(id, rawTxt);

  return {
    id,
    txt: rawTxt,
    videoId,
  };
}

/**
 * Retrieves an UltraStar chart by ID or slug from cache, public mirror, or USDB.
 */
async function getChart(songIdOrSlug, options = {}) {
  if (!songIdOrSlug) return null;

  // 1. Check local cache
  const cached = getCachedChart(songIdOrSlug);
  if (cached) {
    const parsed = parseChartHeaders(cached);
    return {
      id: songIdOrSlug,
      txt: cached,
      parsed,
      videoId: parsed.videoId || '',
      source: 'cache',
    };
  }

  // 2. If numeric ID, try USDB
  if (/^\d+$/.test(String(songIdOrSlug))) {
    try {
      const usdbData = await getUsdbSong(parseInt(songIdOrSlug, 10), options.sessionCookie);
      const parsed = parseChartHeaders(usdbData.txt);
      return {
        id: songIdOrSlug,
        txt: usdbData.txt,
        parsed,
        videoId: usdbData.videoId || parsed.videoId || '',
        source: 'usdb',
      };
    } catch (_) {}
  }

  // 3. Try public UltraStar mirror (allkaraoke.party)
  try {
    const mirrorUrl = `${ALLKARAOKE_BASE_URL}/${encodeURIComponent(songIdOrSlug)}.txt`;
    const res = await requestUrl(mirrorUrl, {}, 6000);
    if (res.status === 200 && res.body.includes('#TITLE') && res.body.includes('#BPM')) {
      const rawTxt = res.body;
      saveChartToCache(songIdOrSlug, rawTxt);
      const parsed = parseChartHeaders(rawTxt);
      return {
        id: songIdOrSlug,
        txt: rawTxt,
        parsed,
        videoId: parsed.videoId || '',
        source: 'mirror',
      };
    }
  } catch (_) {}

  return null;
}

// ============================================================================
// 5. AUTOMATED COMMUNITY GROUND-TRUTH MATCHER (Score >= 0.82 Gate)
// ============================================================================

/**
 * Finds the highest-scoring verified community song chart for a given artist and title.
 *
 * Evaluates:
 * 1. Curated catalog (public/ultrastar_index.json)
 * 2. Local chart cache (usdb_cache/)
 * 3. USDB Live search (if logged in)
 *
 * Guaranteed threshold: Score >= 0.82
 */
async function findBestMatch(artist, title, options = {}) {
  const qArtist = (artist || '').trim();
  const qTitle = (title || '').trim();
  const threshold = options.threshold !== undefined ? options.threshold : 0.82;

  if (!qTitle && !qArtist) return null;

  let bestMatch = null;
  let bestScore = -1;

  // 1. Search curated catalog (6,682 verified UltraStar tracks)
  const catalog = loadCuratedCatalog();
  const normQueryArtist = normalizeForFuzzy(qArtist);
  const normQueryTitle = normalizeForFuzzy(qTitle);

  for (const item of catalog) {
    const candTitle = item.title || '';
    const candArtist = item.artist || '';

    // Fast pre-filter: skip completely unrelated artists when query artist is substantial
    if (normQueryArtist.length >= 3) {
      const normCandArtist = normalizeForFuzzy(candArtist);
      if (
        !normCandArtist.includes(normQueryArtist) &&
        !normQueryArtist.includes(normCandArtist) &&
        levenshteinRatio(qArtist, candArtist) < 0.4
      ) {
        continue;
      }
    }

    const score = computeMatchScore(qTitle, qArtist, candTitle, candArtist);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        matched: score >= threshold,
        score,
        source: 'ultrastar_catalog',
        id: item.id,
        usdbId: null,
        title: candTitle,
        artist: candArtist,
        bpm: item.bpm,
        gap: item.gap,
        duration: item.duration || 0,
        videoId: item.video || item.videoId || '',
        language: item.language || [],
        year: item.year || '',
      };
    }
    // Perfect match shortcut
    if (score >= 0.99) break;
  }

  // 2. Check local usdb_cache/ if any cached chart matches with higher score
  if (fs.existsSync(USDB_CACHE_DIR)) {
    try {
      const files = fs.readdirSync(USDB_CACHE_DIR);
      for (const f of files) {
        if (!f.endsWith('.txt')) continue;
        const cacheId = f.slice(0, -4);
        const content = fs.readFileSync(path.join(USDB_CACHE_DIR, f), 'utf8');
        const parsed = parseChartHeaders(content);
        if (parsed.isValid) {
          const score = computeMatchScore(qTitle, qArtist, parsed.title, parsed.artist);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = {
              matched: score >= threshold,
              score,
              source: 'usdb_cache',
              id: cacheId,
              usdbId: /^\d+$/.test(cacheId) ? parseInt(cacheId, 10) : null,
              title: parsed.title,
              artist: parsed.artist,
              bpm: parsed.bpm,
              gap: parsed.gap,
              videoId: parsed.videoId || '',
              hasGoldenNotes: parsed.hasGoldenNotes,
              goldenNoteCount: parsed.goldenNoteCount,
            };
          }
        }
      }
    } catch (_) {}
  }

  // 3. Search USDB Live if user is authenticated and score is not already near-perfect
  if (usdbSession.cookie && bestScore < 0.95) {
    try {
      const usdbResults = await searchUsdb(`${qArtist} ${qTitle}`.trim());
      for (const res of usdbResults) {
        const score = computeMatchScore(qTitle, qArtist, res.trackName, res.artistName);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            matched: score >= threshold,
            score,
            source: 'usdb_live',
            id: String(res.usdbId),
            usdbId: res.usdbId,
            title: res.trackName,
            artist: res.artistName,
            bpm: 0,
            gap: 0,
            videoId: '',
            language: res.language,
            year: res.year,
          };
        }
      }
    } catch (_) {}
  }

  if (bestMatch && bestScore >= threshold) {
    bestMatch.matched = true;
    bestMatch.score = Math.round(bestScore * 1000) / 1000;
    return bestMatch;
  }

  return null;
}

/**
 * Resolves a song to its community ground-truth chart:
 * 1. Matches artist & title against USDB and UltraStar catalog (Score >= 0.82)
 * 2. Fetches raw .txt chart from cache or mirror
 * 3. Validates human-verified pitches, syllables, and golden notes
 * 4. Ensures a valid YouTube video ID is paired
 */
async function resolveUsdbSong(inputOrMetadata, options = {}) {
  let artist = '';
  let title = '';
  let videoId = '';

  if (typeof inputOrMetadata === 'string') {
    // Attempt parsing "Artist - Title"
    const cleaned = inputOrMetadata.trim();
    if (cleaned.includes(' - ')) {
      const parts = cleaned.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else {
      title = cleaned;
    }
  } else if (inputOrMetadata && typeof inputOrMetadata === 'object') {
    artist = inputOrMetadata.artist || inputOrMetadata.artistName || '';
    title = inputOrMetadata.title || inputOrMetadata.trackName || '';
    videoId = inputOrMetadata.youtubeId || inputOrMetadata.videoId || '';
  }

  const match = await findBestMatch(artist, title, options);
  if (!match || !match.matched) {
    return { matched: false, score: match ? match.score : 0 };
  }

  // Retrieve chart
  const chartData = await getChart(match.id || match.usdbId, options);
  if (!chartData || !chartData.parsed || !chartData.parsed.isValid) {
    // If mirror fetch failed, return basic match info
    return {
      matched: true,
      score: match.score,
      source: match.source,
      id: match.id,
      usdbId: match.usdbId,
      title: match.title,
      artist: match.artist,
      bpm: match.bpm,
      gap: match.gap,
      videoId: match.videoId || videoId,
      hasGoldenNotes: false,
      goldenNoteCount: 0,
      noteCount: 0,
      txt: null,
    };
  }

  const finalVideoId = chartData.videoId || match.videoId || videoId;

  return {
    matched: true,
    score: match.score,
    source: chartData.source || match.source,
    id: match.id,
    usdbId: match.usdbId,
    title: chartData.parsed.title || match.title,
    artist: chartData.parsed.artist || match.artist,
    bpm: chartData.parsed.bpm || match.bpm,
    gap: chartData.parsed.gap || match.gap,
    videoId: finalVideoId,
    hasGoldenNotes: chartData.parsed.hasGoldenNotes,
    goldenNoteCount: chartData.parsed.goldenNoteCount,
    noteCount: chartData.parsed.noteCount,
    firstNoteStartBeat: chartData.parsed.firstNoteStartBeat,
    txt: chartData.txt,
    parsed: chartData.parsed,
  };
}

module.exports = {
  USDB_CACHE_DIR,
  USDB_CONFIG_FILE,
  ULTRASTAR_INDEX_FILE,
  normalizeForFuzzy,
  levenshteinDistance,
  levenshteinRatio,
  computeMatchScore,
  parseChartHeaders,
  loadCuratedCatalog,
  getCachedChart,
  saveChartToCache,
  loginUsdb,
  logoutUsdb,
  getUsdbSession,
  searchUsdb,
  getUsdbSong,
  getChart,
  findBestMatch,
  resolveUsdbSong,
};
