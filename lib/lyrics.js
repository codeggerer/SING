/**
 * lib/lyrics.js - Multi-Provider Lyrics Engine (PLAN.md Phase 2)
 *
 * Implements canonical LyricsDoc normalization, rate-limited provider queries
 * (Spicy Lyrics -> Spotify Color-Lyrics -> LRCLIB), quality gating, and local caching.
 *
 * Zero external dependencies: native Node.js only.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.local.json');
const CACHE_DIR = path.join(PROJECT_ROOT, 'lyrics_cache');
const USER_AGENT = 'SingKaraokeEngine/2.0 (+https://github.com/sing-karaoke)';

function readDotEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const result = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
    return result;
  } catch (_) {
    return {};
  }
}

// In-memory runtime state for tokens and health
let memState = {
  pkceToken: null,
  spDcToken: null,
  spDcTokenExpiry: 0,
  spicyKeyValid: true,
  lastRateLimitHeaders: null,
};

// ==============================================================================
// 1. Config & Secret Storage (0600 mode)
// ==============================================================================

function getLocalConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function setLocalConfig(updates) {
  const current = getLocalConfig();
  const updated = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), {
    mode: 0o600,
  });
  return updated;
}

function getSpicyLyricsKey() {
  const dotEnv = readDotEnv();
  return (
    process.env.SPICY_LYRICS_KEY ||
    dotEnv.SPICY_LYRICS_KEY ||
    getLocalConfig().spicyLyricsKey ||
    null
  );
}

function getSpDcCookie() {
  const dotEnv = readDotEnv();
  return (
    process.env.SPOTIFY_SP_DC ||
    dotEnv.SPOTIFY_SP_DC ||
    getLocalConfig().spotifySpDc ||
    null
  );
}

function setPkceToken(token) {
  memState.pkceToken = token ? token.trim() : null;
}

function getLyricsStatus() {
  const spicyKey = getSpicyLyricsKey();
  const spDc = getSpDcCookie();
  let spotifyMethod = null;
  if (memState.pkceToken) {
    spotifyMethod = 'pkce';
  } else if (spDc) {
    spotifyMethod = 'sp_dc';
  }

  return {
    spicyConfigured: !!spicyKey,
    spicyKeyValid: memState.spicyKeyValid,
    spotifyLyricsMethod: spotifyMethod,
  };
}

// ==============================================================================
// 2. Token Bucket Rate Limiter
// ==============================================================================

class TokenBucket {
  constructor({ maxPerSec = 1, maxPerMin = 30 } = {}) {
    this.maxPerSec = maxPerSec;
    this.maxPerMin = maxPerMin;
    this.secTokens = maxPerSec;
    this.minTokens = maxPerMin;
    this.lastSec = Date.now();
    this.lastMin = Date.now();
  }

  async acquire() {
    while (true) {
      const now = Date.now();
      // Replenish 1s bucket
      if (now - this.lastSec >= 1000) {
        this.secTokens = this.maxPerSec;
        this.lastSec = now;
      }
      // Replenish 60s bucket
      if (now - this.lastMin >= 60000) {
        this.minTokens = this.maxPerMin;
        this.lastMin = now;
      }

      if (this.secTokens > 0 && this.minTokens > 0) {
        this.secTokens--;
        this.minTokens--;
        return;
      }
      // Wait a short slice
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const spicyRateLimiter = new TokenBucket({ maxPerSec: 1, maxPerMin: 30 });

// ==============================================================================
// 3. Network Fetch Helper with Timeout & RateLimit Logging
// ==============================================================================

function fetchHttp(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'https:' ? https : http;
    const timeoutMs = options.timeoutMs || 8000;

    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...options.headers,
    };

    const req = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          // Log rate limit headers once
          const rlHeader =
            res.headers['x-ratelimit-remaining'] ||
            res.headers['ratelimit-remaining'] ||
            res.headers['retry-after'];
          if (rlHeader && !memState.lastRateLimitHeaders) {
            memState.lastRateLimitHeaders = {
              rateLimit: res.headers['x-ratelimit-limit'] || res.headers['ratelimit-limit'],
              remaining: rlHeader,
              reset: res.headers['x-ratelimit-reset'] || res.headers['ratelimit-reset'],
            };
            console.debug('ℹ️ [RateLimit Info]', url.hostname, memState.lastRateLimitHeaders);
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms for ${urlStr}`));
    });

    req.on('error', (err) => reject(err));

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ==============================================================================
// 4. Disk Caching Layer (30-day hit, 24-hour negative cache)
// ==============================================================================

function getCacheFilePath(provider, key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  const dir = path.join(CACHE_DIR, provider);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${hash}.json`);
}

function readCache(provider, key) {
  const filePath = getCacheFilePath(provider, key);
  if (!fs.existsSync(filePath)) return null;

  try {
    const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const now = Date.now();
    if (entry.isMiss) {
      // 24h negative cache TTL
      if (now - entry.timestamp > 24 * 3600 * 1000) {
        return null;
      }
      return { isMiss: true };
    }
    // 30-day valid cache TTL
    if (now - entry.timestamp > 30 * 24 * 3600 * 1000) {
      return null;
    }
    return entry.data;
  } catch (_) {
    return null;
  }
}

function writeCache(provider, key, data, isMiss = false) {
  try {
    const filePath = getCacheFilePath(provider, key);
    const entry = {
      timestamp: Date.now(),
      isMiss: !!isMiss,
      data: isMiss ? null : data,
    };
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');
  } catch (err) {
    console.warn(`⚠️ Could not write lyrics cache for ${provider}: ${err.message}`);
  }
}

// ==============================================================================
// 5. Canonical Data Model & Normalizers
// ==============================================================================

/**
 * Text normalizer:
 * - strips \u200b and BOM \ufeff
 * - removes \r
 * - trims whitespace
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * Determine if text is background vocals, e.g. "(backing lyrics)"
 */
function isBackgroundAgent(text) {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith('(') && trimmed.endsWith(')')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

/**
 * Normalizes Spicy Lyrics response payload to canonical LyricsDoc.
 * Handles both the official Spicy Lyrics API schema (Body.Content with Lead/Background)
 * and generic line/syllable schemas.
 */
function normalizeSpicyLyrics(payload, meta = {}) {
  if (!payload) return null;
  const body = payload.Body || payload;

  const rawSync = (body.Type || body.syncType || meta.syncType || 'line').toLowerCase();
  let syncType = 'line';
  if (rawSync.includes('syllable')) syncType = 'syllable';
  else if (rawSync.includes('word')) syncType = 'word';
  else if (rawSync.includes('static') || rawSync.includes('unsynced')) syncType = 'static';

  const lines = [];

  // Schema A: Official Spicy Lyrics v1 API (Body.Content array)
  if (Array.isArray(body.Content)) {
    for (const item of body.Content) {
      // Process Lead vocal line
      if (item.Lead && Array.isArray(item.Lead.Syllables) && item.Lead.Syllables.length > 0) {
        const leadSyllables = [];
        const wordsList = [];

        for (const s of item.Lead.Syllables) {
          const text = cleanText(s.Text || s.text || '');
          if (!text) continue;
          // Times in official API are floats in seconds
          const sStart = typeof s.StartTime === 'number' ? s.StartTime : (Number(s.startTimeMs || 0) / 1000);
          const sEnd = typeof s.EndTime === 'number' ? s.EndTime : (Number(s.endTimeMs || 0) / 1000);
          const joinNext = Boolean(s.IsPartOfWord ?? s.joinNext);

          leadSyllables.push({
            text,
            start: Math.round(sStart * 1000) / 1000,
            end: Math.round(Math.max(sStart + 0.03, sEnd) * 1000) / 1000,
            joinNext,
          });

          wordsList.push(text + (joinNext ? '' : ' '));
        }

        if (leadSyllables.length > 0) {
          const lStart = typeof item.Lead.StartTime === 'number'
            ? item.Lead.StartTime
            : leadSyllables[0].start;
          const lEnd = typeof item.Lead.EndTime === 'number'
            ? item.Lead.EndTime
            : leadSyllables[leadSyllables.length - 1].end;

          lines.push({
            start: Math.round(lStart * 1000) / 1000,
            end: Math.round(Math.max(lStart + 0.1, lEnd) * 1000) / 1000,
            agent: 'lead',
            words: wordsList.join('').trim(),
            syllables: leadSyllables,
          });
        }
      }

      // Process Background vocal lines
      if (Array.isArray(item.Background)) {
        for (const bg of item.Background) {
          if (Array.isArray(bg.Syllables) && bg.Syllables.length > 0) {
            const bgSyllables = [];
            const wordsList = [];

            for (const s of bg.Syllables) {
              const text = cleanText(s.Text || s.text || '');
              if (!text) continue;
              const sStart = typeof s.StartTime === 'number' ? s.StartTime : (Number(s.startTimeMs || 0) / 1000);
              const sEnd = typeof s.EndTime === 'number' ? s.EndTime : (Number(s.endTimeMs || 0) / 1000);
              const joinNext = Boolean(s.IsPartOfWord ?? s.joinNext);

              bgSyllables.push({
                text,
                start: Math.round(sStart * 1000) / 1000,
                end: Math.round(Math.max(sStart + 0.03, sEnd) * 1000) / 1000,
                joinNext,
              });

              wordsList.push(text + (joinNext ? '' : ' '));
            }

            if (bgSyllables.length > 0) {
              const bgStart = typeof bg.StartTime === 'number' ? bg.StartTime : bgSyllables[0].start;
              const bgEnd = typeof bg.EndTime === 'number' ? bg.EndTime : bgSyllables[bgSyllables.length - 1].end;

              lines.push({
                start: Math.round(bgStart * 1000) / 1000,
                end: Math.round(Math.max(bgStart + 0.1, bgEnd) * 1000) / 1000,
                agent: 'background',
                words: wordsList.join('').trim(),
                syllables: bgSyllables,
              });
            }
          }
        }
      }
    }
  }

  // Schema B: Flat lines array (legacy / conceptual schema)
  const rawLines = body.lines || payload.lines;
  if (lines.length === 0 && Array.isArray(rawLines)) {
    for (const rawLine of rawLines) {
      const rawWords = cleanText(rawLine.words || rawLine.text || '');
      if (!rawWords || rawWords === '♪' || rawWords === '♫') continue;

      const startSec = (Number(rawLine.startTimeMs || rawLine.start || 0) || 0) / (rawLine.startTimeMs ? 1000 : 1);
      let endSec = (Number(rawLine.endTimeMs || rawLine.end || 0) || 0) / (rawLine.endTimeMs ? 1000 : 1);
      if (endSec <= startSec) {
        endSec = startSec + 3.0;
      }

      const agent = rawLine.agent === 'background' || isBackgroundAgent(rawWords)
        ? 'background'
        : 'lead';

      const syllables = [];
      if (Array.isArray(rawLine.syllables) && rawLine.syllables.length > 0) {
        for (const s of rawLine.syllables) {
          const text = cleanText(s.text || s.words || s.Text || '');
          if (!text) continue;
          const sStart = (Number(s.startTimeMs || s.start || s.StartTime || 0) || 0) / (s.startTimeMs ? 1000 : 1);
          let sEnd = (Number(s.endTimeMs || s.end || s.EndTime || 0) || 0) / (s.endTimeMs ? 1000 : 1);
          if (sEnd <= sStart) sEnd = sStart + 0.1;
          syllables.push({
            text,
            start: Math.round(sStart * 1000) / 1000,
            end: Math.round(sEnd * 1000) / 1000,
            joinNext: Boolean(s.joinNext || s.IsPartOfWord),
          });
        }
      }

      lines.push({
        start: Math.round(startSec * 1000) / 1000,
        end: Math.round(endSec * 1000) / 1000,
        agent,
        words: rawWords,
        syllables: syllables.length > 0 ? syllables : undefined,
      });
    }
  }

  if (lines.length === 0) return null;

  // Sort lines chronologically
  lines.sort((a, b) => a.start - b.start);

  const doc = {
    source: 'spicylyrics',
    syncType: syllablesExist(lines) ? 'syllable' : syncType,
    language: body.language || meta.language || detectLanguage(lines),
    lines,
  };

  return doc;
}

/**
 * Normalizes Spotify Color-Lyrics response payload to canonical LyricsDoc.
 */
function normalizeSpotifyColorLyrics(payload) {
  const lyrics = payload?.lyrics || payload;
  if (!lyrics || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) {
    return null;
  }

  const rawSync = (lyrics.syncType || '').toLowerCase();
  let syncType = 'line';
  if (rawSync.includes('syllable')) syncType = 'syllable';
  else if (rawSync.includes('line')) syncType = 'line';
  else if (rawSync.includes('unsynced')) syncType = 'static';

  const lines = [];

  for (let i = 0; i < lyrics.lines.length; i++) {
    const rawLine = lyrics.lines[i];
    const rawWords = cleanText(rawLine.words || '');
    if (!rawWords || rawWords === '♪' || rawWords === '♫') continue;

    const startSec = (Number(rawLine.startTimeMs || 0) || 0) / 1000;
    let endSec = (Number(rawLine.endTimeMs || 0) || 0) / 1000;

    // Spotify often returns endTimeMs = "0". Derive from next line's start if so.
    if (endSec <= startSec) {
      if (i + 1 < lyrics.lines.length) {
        const nextStart = (Number(lyrics.lines[i + 1].startTimeMs || 0) || 0) / 1000;
        endSec = nextStart > startSec ? nextStart : startSec + 3.0;
      } else {
        endSec = startSec + 3.0;
      }
    }

    const agent = isBackgroundAgent(rawWords) ? 'background' : 'lead';

    const syllables = [];
    if (Array.isArray(rawLine.syllables) && rawLine.syllables.length > 0) {
      for (const s of rawLine.syllables) {
        const text = cleanText(s.text || s.words || '');
        if (!text) continue;
        const sStart = (Number(s.startTimeMs || 0) || 0) / 1000;
        let sEnd = (Number(s.endTimeMs || 0) || 0) / 1000;
        if (sEnd <= sStart) sEnd = sStart + 0.1;
        syllables.push({
          text,
          start: Math.round(sStart * 1000) / 1000,
          end: Math.round(sEnd * 1000) / 1000,
          joinNext: !!s.joinNext,
        });
      }
    }

    lines.push({
      start: Math.round(startSec * 1000) / 1000,
      end: Math.round(endSec * 1000) / 1000,
      agent,
      words: rawWords,
      syllables: syllables.length > 0 ? syllables : undefined,
    });
  }

  const doc = {
    source: 'spotify',
    syncType: syllablesExist(lines) ? 'syllable' : syncType,
    language: lyrics.language || detectLanguage(lines),
    lines,
  };

  return doc;
}

/**
 * Normalizes LRCLIB syncedLyrics (LRC string) to canonical LyricsDoc.
 */
function normalizeLrclib(payload) {
  if (!payload || !payload.syncedLyrics) return null;

  const lrcText = payload.syncedLyrics;
  const lrcLines = lrcText.split('\n');
  const lines = [];

  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

  for (const raw of lrcLines) {
    const match = timeRegex.exec(raw);
    if (!match) continue;

    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    const msFraction = match[3];
    const ms = msFraction.length === 2 ? parseInt(msFraction, 10) * 10 : parseInt(msFraction, 10);
    const startSec = min * 60 + sec + ms / 1000;

    let text = cleanText(match[4] || '');
    if (!text || text === '♪' || text === '♫') continue;

    const agent = isBackgroundAgent(text) ? 'background' : 'lead';

    lines.push({
      start: Math.round(startSec * 1000) / 1000,
      end: Math.round((startSec + 3.0) * 1000) / 1000,
      agent,
      words: text,
    });
  }

  if (lines.length === 0) return null;

  // Refine end time: cap line duration based on word count so words don't stretch across long pauses
  for (let i = 0; i < lines.length - 1; i++) {
    const wordCount = (lines[i].words || '').split(/\s+/).filter(Boolean).length;
    const estDur = Math.max(1.8, Math.min(wordCount * 0.42 + 0.5, 6.0));
    lines[i].end = Math.min(lines[i].start + estDur, lines[i + 1].start);
  }

  const doc = {
    source: 'lrclib',
    syncType: 'line',
    language: detectLanguage(lines),
    lines,
  };

  return doc;
}

function syllablesExist(lines) {
  return lines.some((l) => Array.isArray(l.syllables) && l.syllables.length > 0);
}

// ==============================================================================
// 6. Language Detection & Quality Gate
// ==============================================================================

const GERMAN_STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'in', 'den', 'von', 'zu', 'mit', 'auf', 'ist', 'im',
  'nicht', 'eine', 'sie', 'sich', 'des', 'ich', 'wie', 'es', 'dem', 'dass', 'du',
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'to', 'of', 'a', 'in', 'that', 'is', 'was', 'for', 'it', 'with',
  'as', 'on', 'be', 'at', 'by', 'this', 'have', 'from', 'you', 'my', 'me', 'i',
]);

function detectLanguage(lines) {
  let deCount = 0;
  let enCount = 0;

  for (const l of lines) {
    const words = (l.words || '').toLowerCase().split(/\s+/);
    for (const w of words) {
      const clean = w.replace(/[^a-zäöüß]/g, '');
      if (GERMAN_STOPWORDS.has(clean)) deCount++;
      if (ENGLISH_STOPWORDS.has(clean)) enCount++;
    }
  }

  if (deCount > enCount && deCount >= 2) return 'de';
  if (enCount > 0) return 'en';
  return 'en';
}

/**
 * Quality Gate before trusting a doc:
 * - Line starts monotonic
 * - No syllable longer than 4s unless single held note
 * - Doc coverage >= 70% of audio duration (if durationSec provided)
 * - Has at least one valid line
 */
function validateLyricsDoc(doc, options = {}) {
  if (!doc || !Array.isArray(doc.lines) || doc.lines.length === 0) {
    return { valid: false, reason: 'Empty or missing lines' };
  }

  // Check monotonic line starts
  for (let i = 1; i < doc.lines.length; i++) {
    if (doc.lines[i].start < doc.lines[i - 1].start) {
      return {
        valid: false,
        reason: `Non-monotonic line timestamps at line ${i}: ${doc.lines[i].start} < ${doc.lines[i - 1].start}`,
      };
    }
  }

  // Check syllable duration cap (4s max)
  for (const l of doc.lines) {
    if (Array.isArray(l.syllables)) {
      for (const s of l.syllables) {
        const dur = s.end - s.start;
        if (dur > 4.0 && l.syllables.length > 1) {
          return {
            valid: false,
            reason: `Syllable '${s.text}' duration ${dur.toFixed(2)}s exceeds 4.0s limit`,
          };
        }
      }
    }
  }

  // Coverage check if target duration provided
  const durationSec = options.durationSec;
  if (durationSec && durationSec > 10) {
    const firstStart = doc.lines[0].start;
    const lastEnd = doc.lines[doc.lines.length - 1].end;
    const coveredSec = Math.max(0, lastEnd - firstStart);
    const coverage = coveredSec / durationSec;
    if (coverage < 0.7) {
      return {
        valid: false,
        reason: `Doc coverage ${(coverage * 100).toFixed(1)}% is below required 70% (${coveredSec.toFixed(1)}s / ${durationSec}s)`,
      };
    }
  }

  return { valid: true };
}

function rankSyncType(syncType) {
  switch ((syncType || '').toLowerCase()) {
    case 'syllable':
      return 4;
    case 'word':
      return 3;
    case 'line':
      return 2;
    case 'static':
      return 1;
    default:
      return 0;
  }
}

// ==============================================================================
// 7. Individual Provider Fetchers
// ==============================================================================

/**
 * Provider 1: Spicy Lyrics
 */
async function fetchSpicyLyrics(spotifyTrackId) {
  if (!spotifyTrackId) return null;
  const key = getSpicyLyricsKey();
  if (!key) return null;

  const cacheKey = `spicy_${spotifyTrackId}`;
  const cached = readCache('spicylyrics', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  await spicyRateLimiter.acquire();

  const url = `https://api.spicylyrics.org/v1/lyrics/${spotifyTrackId}`;
  try {
    const res = await fetchHttp(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    if (res.statusCode === 401 || res.statusCode === 403) {
      console.warn('⚠️ Spicy Lyrics API Key rejected (401/403). Marking invalid.');
      memState.spicyKeyValid = false;
      return null;
    }

    if (res.statusCode === 404) {
      writeCache('spicylyrics', cacheKey, null, true);
      return null;
    }

    if (res.statusCode !== 200) {
      console.warn(`⚠️ Spicy Lyrics returned status ${res.statusCode}`);
      return null;
    }

    const parsed = JSON.parse(res.body);
    const doc = normalizeSpicyLyrics(parsed);
    if (doc) {
      writeCache('spicylyrics', cacheKey, doc, false);
      return doc;
    } else {
      writeCache('spicylyrics', cacheKey, null, true);
      return null;
    }
  } catch (err) {
    console.warn(`⚠️ Spicy Lyrics fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Provider 2: Spotify Color-Lyrics
 */
async function getSpotifyLyricsToken() {
  // 1. Try PKCE token in memory
  if (memState.pkceToken) {
    return { token: memState.pkceToken, method: 'pkce' };
  }

  // 2. Try cached sp_dc web-player token
  const now = Date.now();
  if (memState.spDcToken && memState.spDcTokenExpiry > now + 60000) {
    return { token: memState.spDcToken, method: 'sp_dc' };
  }

  // 3. Try exchange sp_dc cookie
  const spDc = getSpDcCookie();
  if (!spDc) return null;

  try {
    const exchangeUrl = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player';
    const res = await fetchHttp(exchangeUrl, {
      headers: {
        Cookie: `sp_dc=${spDc}`,
      },
    });
    if (res.statusCode === 200) {
      const parsed = JSON.parse(res.body);
      if (parsed.accessToken) {
        memState.spDcToken = parsed.accessToken;
        memState.spDcTokenExpiry = parsed.accessTokenExpirationTimestampMs || now + 3600000;
        return { token: memState.spDcToken, method: 'sp_dc' };
      }
    }
  } catch (err) {
    console.warn(`⚠️ sp_dc exchange failed: ${err.message}`);
  }

  return null;
}

async function fetchSpotifyColorLyrics(spotifyTrackId) {
  if (!spotifyTrackId) return null;
  const tokenInfo = await getSpotifyLyricsToken();
  if (!tokenInfo) return null;

  const cacheKey = `spotify_${spotifyTrackId}`;
  const cached = readCache('spotify', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${spotifyTrackId}?format=json&vocalRemoval=false&market=from_token`;
  try {
    const res = await fetchHttp(url, {
      headers: {
        'app-platform': 'WebPlayer',
        authorization: `Bearer ${tokenInfo.token}`,
      },
    });

    if (res.statusCode === 401 || res.statusCode === 403) {
      // Clear token if invalid
      if (tokenInfo.method === 'pkce') memState.pkceToken = null;
      if (tokenInfo.method === 'sp_dc') memState.spDcToken = null;
      return null;
    }

    if (res.statusCode === 404) {
      writeCache('spotify', cacheKey, null, true);
      return null;
    }

    if (res.statusCode !== 200) {
      return null;
    }

    const parsed = JSON.parse(res.body);
    const doc = normalizeSpotifyColorLyrics(parsed);
    if (doc) {
      writeCache('spotify', cacheKey, doc, false);
      return doc;
    } else {
      writeCache('spotify', cacheKey, null, true);
      return null;
    }
  } catch (err) {
    console.warn(`⚠️ Spotify Color-Lyrics fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Provider 3: LRCLIB
 */
async function fetchLrclib({ title, artist, durationSec }) {
  if (!title && !artist) return null;

  const cacheKey = `lrclib_${artist}_${title}_${durationSec || 0}`;
  const cached = readCache('lrclib', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  // Step A: exact match via /api/get if duration is known
  if (durationSec && title && artist) {
    const getUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${Math.round(durationSec)}`;
    try {
      const res = await fetchHttp(getUrl);
      if (res.statusCode === 200) {
        const parsed = JSON.parse(res.body);
        const doc = normalizeLrclib(parsed);
        if (doc) {
          writeCache('lrclib', cacheKey, doc, false);
          return doc;
        }
      }
    } catch (_) {}
  }

  // Step B: fallback to /api/search
  const query = `${artist || ''} ${title || ''}`.trim();
  const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetchHttp(searchUrl);
    if (res.statusCode === 200) {
      const results = JSON.parse(res.body);
      if (Array.isArray(results) && results.length > 0) {
        // Find best match with synced lyrics
        const matched = results.find((r) => {
          if (!r.syncedLyrics) return false;
          if (durationSec && r.duration) {
            return Math.abs(r.duration - durationSec) <= 4;
          }
          return true;
        }) || results.find((r) => r.syncedLyrics);

        if (matched) {
          const doc = normalizeLrclib(matched);
          if (doc) {
            writeCache('lrclib', cacheKey, doc, false);
            return doc;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ LRCLIB search failed: ${err.message}`);
    return null;
  }

  writeCache('lrclib', cacheKey, null, true);
  return null;
}

// ==============================================================================
// 8. Main Orchestrator: fetchLyrics({ title, artist, durationSec, spotifyTrackId })
// ==============================================================================

async function fetchLyrics({ title, artist, durationSec, spotifyTrackId }) {
  const candidates = [];

  // Provider 1: Spicy Lyrics
  if (spotifyTrackId) {
    try {
      const doc = await fetchSpicyLyrics(spotifyTrackId);
      if (doc) {
        const val = validateLyricsDoc(doc, { durationSec });
        if (val.valid) {
          if (rankSyncType(doc.syncType) === 4) {
            // Found top-tier syllable sync! Return immediately.
            return doc;
          }
          candidates.push(doc);
        }
      }
    } catch (e) {
      console.warn('Spicy lyrics error:', e.message);
    }
  }

  // Provider 2: Spotify Color-Lyrics
  if (spotifyTrackId) {
    try {
      const doc = await fetchSpotifyColorLyrics(spotifyTrackId);
      if (doc) {
        const val = validateLyricsDoc(doc, { durationSec });
        if (val.valid) {
          if (rankSyncType(doc.syncType) === 4) {
            return doc;
          }
          candidates.push(doc);
        }
      }
    } catch (e) {
      console.warn('Spotify color lyrics error:', e.message);
    }
  }

  // Provider 3: LRCLIB
  try {
    const doc = await fetchLrclib({ title, artist, durationSec });
    if (doc) {
      const val = validateLyricsDoc(doc, { durationSec });
      if (val.valid) {
        candidates.push(doc);
      }
    }
  } catch (e) {
    console.warn('LRCLIB error:', e.message);
  }

  if (candidates.length === 0) {
    return null;
  }

  // Sort candidates by syncType rank descending
  candidates.sort((a, b) => rankSyncType(b.syncType) - rankSyncType(a.syncType));
  return candidates[0];
}

// ==============================================================================
// CLI Mode for direct offline testing and scripts
// ==============================================================================

async function runCli() {
  const args = process.argv.slice(2);
  let title = '';
  let artist = '';
  let durationSec = 0;
  let spotifyTrackId = '';
  let outPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title' && args[i + 1]) title = args[++i];
    else if (args[i] === '--artist' && args[i + 1]) artist = args[++i];
    else if (args[i] === '--duration' && args[i + 1]) durationSec = parseFloat(args[++i]);
    else if (args[i] === '--spotify-id' && args[i + 1]) spotifyTrackId = args[++i];
    else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
  }

  console.log(`🔍 Fetching lyrics for "${artist} - ${title}"...`);
  const doc = await fetchLyrics({ title, artist, durationSec, spotifyTrackId });
  if (!doc) {
    console.log('✗ No valid lyrics found from providers.');
    process.exit(1);
  }

  console.log(`✓ Got lyrics from ${doc.source} (syncType: ${doc.syncType}, lines: ${doc.lines.length})`);
  const outJson = JSON.stringify(doc, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, outJson, 'utf8');
    console.log(`✓ Saved to ${outPath}`);
  } else {
    console.log(outJson);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
}

module.exports = {
  fetchLyrics,
  fetchSpicyLyrics,
  fetchSpotifyColorLyrics,
  fetchLrclib,
  getSpicyLyricsKey,
  getSpDcCookie,
  normalizeSpicyLyrics,
  normalizeSpotifyColorLyrics,
  normalizeLrclib,
  validateLyricsDoc,
  rankSyncType,
  detectLanguage,
  cleanText,
  getLocalConfig,
  setLocalConfig,
  getLyricsStatus,
  setPkceToken,
  TokenBucket,
};
