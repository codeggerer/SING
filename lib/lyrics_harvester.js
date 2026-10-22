/**
 * lib/lyrics_harvester.js - Plain-Text Multi-Source Lyrics Harvester (UNSYNCED_LYRICS_OVERHAUL_PLAN Phase 1)
 *
 * Retrieves 100% accurate, unsynced plaintext lyrics for niche, indie, and unindexed songs
 * across 4 prioritized sources:
 *   1. User Manual Paste (Override)
 *   2. YouTube Video Description (regex extraction & cleaning)
 *   3. LRCLIB plainLyrics (free API)
 *   4. Genius Public Scraper (search + data-lyrics-container parsing)
 *
 * Features:
 * - Strips section header markers ([Intro], (Hook), Verse 1:, HOOK, etc.)
 * - Strips inline and standalone guitar chord annotations ([Am], C G D Em)
 * - Strips production credits, social links, URLs, and Genius artifacts
 * - Zero external dependencies (native Node.js http/https/fs/path/crypto/child_process)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(PROJECT_ROOT, 'lyrics_cache', 'harvester');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ==============================================================================
// 1. Text Normalization & Cleaning Utilities
// ==============================================================================

/**
 * Normalizes and cleans lyrics text:
 * - Strips HTML entities and decodes unicode escapes
 * - Strips section markers ([Intro], (Hook), Verse 1:, HOOK, VERSE 2, etc.)
 * - Strips guitar chords (both standalone lines like "Am C G D" and inline "[Am]")
 * - Strips credits, social links, URLs, and scraping noise
 * - Collapses redundant whitespace and returns clean line-separated lyrics
 */
function cleanLyricsText(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-');

  // Decode numeric and hex HTML entities
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    try {
      return String.fromCharCode(parseInt(dec, 10));
    } catch (_) {
      return '';
    }
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch (_) {
      return '';
    }
  });

  // Strip bracketed inline chords (e.g. "[Am]Text [G]zeile" -> "Text zeile")
  text = text.replace(
    /\[[A-G][b#]?(?:maj7?|min7?|m7?|dim7?|aug7?|sus[24]?|add[0-9]|7sus4|[0-9]{1,2})?(?:\/[A-G][b#]?)?\]/g,
    ''
  );

  const lines = text.split('\n');
  const cleanedLines = [];

  // Patterns for section headers
  const sectionKeywordRegex =
    /^(?:intro|outro|verse|strophe|teil|part|hook|refrain|chorus|bridge|pre-chorus|post-chorus|interlude|solo|instrumental|drop)\b/i;
  const sectionBracketHeaderRegex =
    /^\s*(?:\[|\()?[\s]*(?:intro|outro|verse|strophe|teil|part|hook|refrain|chorus|bridge|pre-chorus|post-chorus|interlude|solo|instrumental|drop)[\s\w:.-]*(?:\]|\))?\s*$/i;
  const genericBracketHeaderRegex = /^\s*\[[\w\s:.-]{2,35}\]\s*$/;
  const sectionStandaloneHeaderRegex =
    /^\s*(?:intro|outro|verse|strophe|teil|part|hook|refrain|chorus|bridge|pre-chorus|post-chorus|interlude|solo|drop)[\s\d:.-]*$/i;

  // Pattern for guitar chord tokens
  const singleChordRegex =
    /^[A-G][b#]?(?:maj7?|min7?|m7?|dim7?|aug7?|sus[24]?|add[0-9]|7sus4|[0-9]{1,2})?(?:\/[A-G][b#]?)?$/;
  const distinctiveChordRegex =
    /^(?:[A-G][b#](?:maj7?|min7?|m7?|dim7?|aug7?|sus[24]?|add[0-9]|7sus4|[0-9]{1,2})?|[A-G](?:maj7?|min7?|m7?|dim7?|aug7?|sus[24]?|add[0-9]|7sus4|[0-9]{1,2}))(?:\/[A-G][b#]?)?$/;

  // Patterns for noise, credits, and links
  const metaRegex =
    /(?:embed|\d+\s+contributors|\blyrics powered by\b|\bwritten by\b|\bget tickets\b|\bsee .* live\b|\byou might also like\b|https?:\/\/|www\.)/i;
  const creditsLineRegex =
    /^\s*(?:video|mix|prod|producer|production|master|mastering|label|artwork|cover|director|dop|edit|camera|styling|hair|makeup|car|titledesign|design|credits|written by|composed by|recorded by|engineered by|produced by|song[\s\w,]*mix[\s\w,.]*|all rights reserved)[\s:.-]/i;
  const socialLineRegex =
    /^\s*(?:follow|subscribe|stream|listen|buy|tickets|merch|socials|instagram|tiktok|twitter|spotify|apple music|facebook)[\s:.-]/i;

  for (let rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] !== '') {
        cleanedLines.push('');
      }
      continue;
    }

    // 1. Skip Section headers: [Hook], (Refrain), Verse 1:, HOOK, VERSE 2, etc.
    if (sectionBracketHeaderRegex.test(trimmed)) continue;
    if (genericBracketHeaderRegex.test(trimmed)) continue;
    if (sectionStandaloneHeaderRegex.test(trimmed)) continue;

    // 2. Skip Metadata, credits, socials, and URLs
    if (metaRegex.test(trimmed)) continue;
    if (creditsLineRegex.test(trimmed)) continue;
    if (socialLineRegex.test(trimmed)) continue;

    // 3. Skip Guitar chord lines (e.g. "Am C G D" or "Em7 A7 Dsus4 G")
    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 2 && tokens.every((t) => singleChordRegex.test(t))) {
      continue;
    }
    if (tokens.length === 1 && distinctiveChordRegex.test(tokens[0])) {
      continue;
    }

    cleanedLines.push(trimmed);
  }

  // Trim leading and trailing empty lines
  while (cleanedLines.length > 0 && cleanedLines[0] === '') cleanedLines.shift();
  while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] === '') cleanedLines.pop();

  return cleanedLines.join('\n');
}

/**
 * Extracts lyrics from a YouTube description string using prioritized regex patterns.
 */
function extractLyricsFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return null;

  const markers = [
    // Marker 1: explicit Lyrics / Songtext / Text label
    /(?:lyrics|songtext|text|lyric):\s*([\s\S]+?)(?:\n\s*\n\s*(?:follow|stream|socials|prod|beat|mix|master|video|credits|label|©|℗|http|www\.)|$)/i,
    // Marker 2: Section header in brackets [Hook], [Verse], etc.
    /(?:\[(?:hook|refrain|verse|strophe|intro|outro|part)[\s\S]+)/i,
    // Marker 3: Section header without brackets (e.g. HOOK, VERSE 1) at start of line
    /(?:^(?:hook|refrain|verse|strophe|part\s*\d*)\b[\s\S]+)/im,
  ];

  for (const pat of markers) {
    const m = desc.match(pat);
    if (m) {
      const cleaned = cleanLyricsText(m[1] || m[0]);
      if (cleaned.split('\n').filter(Boolean).length >= 4) {
        return cleaned;
      }
    }
  }

  // Fallback: If the whole description is the lyrics
  const cleanedFallback = cleanLyricsText(desc);
  if (cleanedFallback.split('\n').filter(Boolean).length >= 4) {
    return cleanedFallback;
  }

  return null;
}

// ==============================================================================
// 2. HTTP Fetch Helper (with Redirects & Timeout)
// ==============================================================================

function fetchHttp(targetUrl, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const transport = parsedUrl.protocol === 'http:' ? http : https;
    const timeoutMs = options.timeoutMs || 8000;

    const headers = {
      'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
      ...options.headers,
    };

    const req = transport.request(
      parsedUrl,
      {
        method: options.method || 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const redirectUrl = new URL(res.headers.location, targetUrl).toString();
          return resolve(fetchHttp(redirectUrl, options, maxRedirects - 1));
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
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
      reject(new Error(`Timeout after ${timeoutMs}ms for ${targetUrl}`));
    });

    req.on('error', (err) => reject(err));

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ==============================================================================
// 3. Disk Caching Layer
// ==============================================================================

function getCachePath(source, key) {
  const hash = crypto.createHash('sha1').update(key.toLowerCase()).digest('hex');
  const dir = path.join(CACHE_DIR, source);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }
  return path.join(dir, `${hash}.json`);
}

const MISS_TTL_MS = 60 * 1000; // 1 minute negative TTL to prevent persistent poisoning
const HIT_TTL_MS = 30 * 24 * 3600 * 1000; // 30-day positive hit TTL

function readCache(source, key) {
  const filePath = getCachePath(source, key);
  if (!fs.existsSync(filePath)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const now = Date.now();
    if (entry.isMiss) {
      if (now - entry.timestamp > MISS_TTL_MS) return null;
      return { isMiss: true };
    }
    if (now - entry.timestamp > HIT_TTL_MS) return null;
    return entry.lyrics || null;
  } catch (_) {
    return null;
  }
}

function writeCache(source, key, lyrics, isMiss = false) {
  const filePath = getCachePath(source, key);
  try {
    const entry = {
      source,
      key,
      timestamp: Date.now(),
      isMiss: !!isMiss,
      lyrics: isMiss ? null : lyrics,
    };
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');
  } catch (_) {}
}

// ==============================================================================
// 4. Source 1: YouTube Description Harvester
// ==============================================================================

/**
 * Fetches the raw video description for a YouTube video ID.
 * Tries fast watch page scraping first, falling back to fast yt-dlp --print description.
 */
async function fetchYouTubeDescription(videoId) {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;

  const cacheKey = `yt_${videoId}`;
  const cached = readCache('youtube_desc', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  // 1. Try lightweight HTTPS watch page scrape
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetchHttp(watchUrl, { timeoutMs: 4000 });
    if (res.statusCode === 200) {
      const match = res.body.match(/"shortDescription"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (match) {
        let desc = null;
        try {
          desc = JSON.parse(`"${match[1]}"`);
        } catch (_) {
          desc = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        if (desc && desc.trim()) {
          writeCache('youtube_desc', cacheKey, desc, false);
          return desc;
        }
      }
    }
  } catch (_) {}

  // 2. Fallback to fast yt-dlp --print description (lightweight, returns in ~2-4s)
  try {
    const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin'];
    const currentPath = process.env.PATH || '';
    const newPath = extraPaths.concat(currentPath.split(':')).filter(Boolean).join(':');

    const certPath = path.join(PROJECT_ROOT, 'venv/lib/python3.11/site-packages/certifi/cacert.pem');
    const env = { ...process.env, PATH: newPath };
    if (fs.existsSync(certPath)) {
      env.SSL_CERT_FILE = certPath;
      env.REQUESTS_CA_BUNDLE = certPath;
    }

    const out = execFileSync(
      'yt-dlp',
      [
        '--skip-download',
        '--no-playlist',
        '--no-check-certificates',
        '--print',
        'description',
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 8000, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (out && typeof out === 'string' && out.trim()) {
      const trimmed = out.trim();
      writeCache('youtube_desc', cacheKey, trimmed, false);
      return trimmed;
    }
  } catch (_) {}

  writeCache('youtube_desc', cacheKey, null, true);
  return null;
}

// ==============================================================================
// 5. Source 2: LRCLIB plainLyrics Harvester
// ==============================================================================

/**
 * Queries LRCLIB for plainLyrics (free, zero authentication).
 */
async function fetchLrclibPlain(artist, title, durationSec = 0) {
  if (!artist && !title) return null;

  const cleanArt = (artist || '').replace(/\s*(?:feat\.|ft\.|&|\bx\b)[\s\S]*$/i, '').trim();
  const cleanTit = (title || '').replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim();
  if (!cleanArt && !cleanTit) return null;

  const cacheKey = `lrclib_${cleanArt}_${cleanTit}_${Math.round(durationSec || 0)}`;
  const cached = readCache('lrclib_plain', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  // Step A: exact query via /api/get (with duration if provided)
  if (cleanArt && cleanTit) {
    try {
      let getUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(
        cleanArt
      )}&track_name=${encodeURIComponent(cleanTit)}`;
      if (durationSec && durationSec > 0) {
        getUrl += `&duration=${Math.round(durationSec)}`;
      }
      const res = await fetchHttp(getUrl, {
        headers: { 'User-Agent': 'SingKaraokeEngine/2.0 (+https://github.com/sing-karaoke)' },
        timeoutMs: 5000,
      });

      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (data && typeof data.plainLyrics === 'string' && data.plainLyrics.trim().length > 0) {
          const cleaned = cleanLyricsText(data.plainLyrics);
          if (cleaned.split('\n').filter(Boolean).length >= 4) {
            writeCache('lrclib_plain', cacheKey, cleaned, false);
            return cleaned;
          }
        }
      }
    } catch (_) {}
  }

  // Step B: query /api/get without duration (duration mismatch tolerance)
  if (cleanArt && cleanTit && durationSec > 0) {
    try {
      const getUrlNoDur = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(
        cleanArt
      )}&track_name=${encodeURIComponent(cleanTit)}`;
      const res = await fetchHttp(getUrlNoDur, {
        headers: { 'User-Agent': 'SingKaraokeEngine/2.0 (+https://github.com/sing-karaoke)' },
        timeoutMs: 5000,
      });

      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (data && typeof data.plainLyrics === 'string' && data.plainLyrics.trim().length > 0) {
          const cleaned = cleanLyricsText(data.plainLyrics);
          if (cleaned.split('\n').filter(Boolean).length >= 4) {
            writeCache('lrclib_plain', cacheKey, cleaned, false);
            return cleaned;
          }
        }
      }
    } catch (_) {}
  }

  // Step C: fallback via /api/search
  try {
    const query = `${cleanArt} ${cleanTit}`.trim();
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const res = await fetchHttp(searchUrl, {
      headers: { 'User-Agent': 'SingKaraokeEngine/2.0 (+https://github.com/sing-karaoke)' },
      timeoutMs: 5000,
    });

    if (res.statusCode === 200) {
      const results = JSON.parse(res.body);
      if (Array.isArray(results) && results.length > 0) {
        const match = results.find(
          (r) => typeof r.plainLyrics === 'string' && r.plainLyrics.trim().length > 0
        );
        if (match) {
          const cleaned = cleanLyricsText(match.plainLyrics);
          if (cleaned.split('\n').filter(Boolean).length >= 4) {
            writeCache('lrclib_plain', cacheKey, cleaned, false);
            return cleaned;
          }
        }
      }
    }
  } catch (_) {}

  writeCache('lrclib_plain', cacheKey, null, true);
  return null;
}

// ==============================================================================
// 5.5 Source: lyrics.ovh (Free, zero authentication, millions of tracks)
// ==============================================================================

/**
 * Fetches lyrics from lyrics.ovh API (fast, unblocked public endpoint).
 */
async function fetchLyricsOvh(artist, title) {
  if (!artist && !title) return null;

  const cleanArt = (artist || '').replace(/\s*(?:feat\.|ft\.|&|\bx\b)[\s\S]*$/i, '').trim();
  const cleanTit = (title || '').replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim();
  if (!cleanArt && !cleanTit) return null;

  const cacheKey = `ovh_${cleanArt}_${cleanTit}`;
  const cached = readCache('lyrics_ovh', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArt)}/${encodeURIComponent(cleanTit)}`;
    const res = await fetchHttp(url, { timeoutMs: 5000 });
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      if (data && typeof data.lyrics === 'string' && data.lyrics.trim().length > 0) {
        const cleaned = cleanLyricsText(data.lyrics);
        if (cleaned.split('\n').filter(Boolean).length >= 4) {
          writeCache('lyrics_ovh', cacheKey, cleaned, false);
          return cleaned;
        }
      }
    } else if (res.statusCode === 404) {
      writeCache('lyrics_ovh', cacheKey, null, true);
    }
  } catch (_) {}

  return null;
}

// ==============================================================================
// 6. Source 3: Genius Public Scraper
// ==============================================================================

/**
 * Extracts inner HTML of all data-lyrics-container elements, correctly handling nested <div>s.
 */
function extractGeniusContainers(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return [];
  const containers = [];
  const marker = 'data-lyrics-container="true"';
  let pos = 0;

  while ((pos = rawHtml.indexOf(marker, pos)) !== -1) {
    const startDiv = rawHtml.lastIndexOf('<div', pos);
    if (startDiv === -1) {
      pos += marker.length;
      continue;
    }

    const contentStart = rawHtml.indexOf('>', pos) + 1;
    let depth = 1;
    let cur = contentStart;

    while (depth > 0 && cur < rawHtml.length) {
      const nextOpen = rawHtml.indexOf('<div', cur);
      const nextClose = rawHtml.indexOf('</div>', cur);

      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cur = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          containers.push(rawHtml.slice(contentStart, nextClose));
          cur = nextClose + 6;
          break;
        }
        cur = nextClose + 6;
      }
    }

    pos = cur;
  }

  return containers;
}

/**
 * Searches Genius and scrapes plaintext lyrics from data-lyrics-container elements.
 */
async function fetchGeniusPlain(artist, title) {
  if (!artist && !title) return null;

  const cacheKey = `genius_${artist}_${title}`;
  const cached = readCache('genius', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  try {
    const query = `${artist || ''} ${title || ''}`.trim();
    const searchUrl = `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`;

    const res = await fetchHttp(searchUrl, { timeoutMs: 6000 });
    if (res.statusCode !== 200) {
      writeCache('genius', cacheKey, null, true);
      return null;
    }

    const data = JSON.parse(res.body);
    const sections = data?.response?.sections || [];

    let songHit = null;
    for (const sec of sections) {
      if (Array.isArray(sec.hits)) {
        for (const h of sec.hits) {
          if (h.type === 'song' && h.result && h.result.url) {
            songHit = h.result;
            break;
          }
        }
      }
      if (songHit) break;
    }

    if (!songHit || !songHit.url) {
      writeCache('genius', cacheKey, null, true);
      return null;
    }

    // Fetch the song webpage
    const pageRes = await fetchHttp(songHit.url, { timeoutMs: 8000 });
    if (pageRes.statusCode !== 200) {
      writeCache('genius', cacheKey, null, true);
      return null;
    }

    const html = pageRes.body;
    const containers = extractGeniusContainers(html);

    if (containers.length === 0) {
      writeCache('genius', cacheKey, null, true);
      return null;
    }

    const rawFragments = containers.map((c) => {
      return c
        .replace(/<div data-exclude-from-selection="true"[\s\S]*?<\/div>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    });

    const combinedRaw = rawFragments.join('\n');
    const cleaned = cleanLyricsText(combinedRaw);

    if (cleaned.split('\n').filter(Boolean).length >= 4) {
      writeCache('genius', cacheKey, cleaned, false);
      return cleaned;
    }
  } catch (_) {}

  writeCache('genius', cacheKey, null, true);
  return null;
}

// ==============================================================================
// 6.5 Source 4: DuckDuckGo Public Snippet Harvester (Phase 3.3)
// ==============================================================================

/**
 * Extracts and cleans lyrics from search engine snippet text.
 * Handles slash-separated lines, HTML artifacts, and entities.
 */
function extractSnippetLyrics(rawSnippet) {
  if (!rawSnippet || typeof rawSnippet !== 'string') return null;

  let text = rawSnippet
    .replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '$1')
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

  // Common search engine snippet pattern: lines separated by " / " or " // "
  if (text.includes('/') && text.split('/').length >= 4) {
    text = text.split(/\s*\/{1,2}\s*/).join('\n');
  }

  // Common snippet ellipsis cleanup
  text = text.replace(/(?:\.\.\.|…)\s*$/g, '').replace(/^\s*(?:\.\.\.|…)/g, '');

  const cleaned = cleanLyricsText(text);
  const lines = cleaned.split('\n').filter(Boolean);
  if (lines.length >= 4) {
    return cleaned;
  }
  return null;
}

/**
 * Searches DuckDuckGo HTML for lyrics snippets when Genius/Songtexte return 403 or fail.
 */
async function fetchDuckDuckGoSnippet(artist, title) {
  if (!artist && !title) return null;

  const cleanArt = (artist || '').replace(/\s*(?:feat\.|ft\.|&|\bx\b)[\s\S]*$/i, '').trim();
  const cleanTit = (title || '').replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim();
  if (!cleanArt && !cleanTit) return null;

  const cacheKey = `ddg_${cleanArt}_${cleanTit}`;
  const cached = readCache('duckduckgo', cacheKey);
  if (cached) {
    if (cached.isMiss) return null;
    return cached;
  }

  try {
    const query = `${cleanArt} ${cleanTit} lyrics songtext`.trim();
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const res = await fetchHttp(searchUrl, {
      timeoutMs: 6000,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://html.duckduckgo.com/',
      },
    });

    if (res.statusCode === 200 && res.body) {
      const html = res.body;

      const snippetPatterns = [
        /<(?:a|div|span|td)[^>]*class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/gi,
        /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi,
      ];

      for (const pat of snippetPatterns) {
        let match;
        while ((match = pat.exec(html)) !== null) {
          const rawSnippet = match[1];
          const extracted = extractSnippetLyrics(rawSnippet);
          if (extracted) {
            writeCache('duckduckgo', cacheKey, extracted, false);
            return extracted;
          }
        }
      }
    }
  } catch (_) {}

  writeCache('duckduckgo', cacheKey, null, true);
  return null;
}

// ==============================================================================
// 7. Master Harvester Pipeline (harvestPlainLyrics)
// ==============================================================================

/**
 * Harvests plain lyrics across prioritized sources:
 *   Priority 0: Manual rawLyricsText (user override)
 *   Priority 1: YouTube Video Description (primary video + candidates)
 *   Priority 2: lyrics.ovh (fast, unblocked global API)
 *   Priority 3: LRCLIB plainLyrics
 *   Priority 4: Genius Public Scraper
 *
 * Can be called with positional arguments:
 *   harvestPlainLyrics(artist, title, youtubeId, options)
 * or with an options object:
 *   harvestPlainLyrics({ artist, title, youtubeId, description, candidates, rawLyricsText, durationSec, ... })
 *
 * Returns cleaned lyrics string, or null if no lyrics could be found.
 */
async function harvestPlainLyrics(artistOrOptions, maybeTitle, maybeYoutubeId, maybeOptions = {}) {
  let artist = '';
  let title = '';
  let youtubeId = '';
  let description = '';
  let rawLyricsText = '';
  let durationSec = 0;
  let fullResult = false;
  let candidates = [];

  if (typeof artistOrOptions === 'object' && artistOrOptions !== null) {
    const opts = artistOrOptions;
    artist = opts.artist || '';
    title = opts.title || '';
    youtubeId = opts.youtubeId || opts.videoId || '';
    description = opts.description || '';
    rawLyricsText = opts.rawLyricsText || opts.customLyrics || '';
    durationSec = opts.durationSec || 0;
    fullResult = Boolean(opts.fullResult);
    candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
  } else {
    artist = artistOrOptions || '';
    title = maybeTitle || '';
    youtubeId = maybeYoutubeId || '';
    const opts = maybeOptions || {};
    description = opts.description || '';
    rawLyricsText = opts.rawLyricsText || opts.customLyrics || '';
    durationSec = opts.durationSec || 0;
    fullResult = Boolean(opts.fullResult);
    candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
  }

  function wrapResult(cleanedText, source) {
    const lineCount = cleanedText.split('\n').filter(Boolean).length;
    if (fullResult) {
      return { lyrics: cleanedText, source, lineCount };
    }
    // Return string with metadata attached
    const resStr = new String(cleanedText);
    resStr.lyrics = cleanedText;
    resStr.source = source;
    resStr.lineCount = lineCount;
    return resStr.toString();
  }

  // Priority 0: Manual user override
  if (rawLyricsText && typeof rawLyricsText === 'string' && rawLyricsText.trim()) {
    const cleaned = cleanLyricsText(rawLyricsText);
    if (cleaned.split('\n').filter(Boolean).length >= 1) {
      return wrapResult(cleaned, 'manual');
    }
  }

  // Priority 1: Direct YouTube Video Description if supplied
  if (description && typeof description === 'string') {
    const extracted = extractLyricsFromDescription(description);
    if (extracted) {
      return wrapResult(extracted, 'youtube_description');
    }
  }

  // Priority 1b: Primary YouTube ID and candidate video descriptions
  const ytIdsToCheck = [];
  if (youtubeId && /^[\w-]{11}$/.test(youtubeId)) {
    ytIdsToCheck.push(youtubeId);
  }

  if (candidates.length > 0) {
    // Sort official/visualizer candidates to the front
    const sorted = [...candidates].sort((a, b) => {
      const aScore = (/official/i.test(a.title || '') ? 2 : 0) + (/official/i.test(a.channel || '') ? 2 : 0);
      const bScore = (/official/i.test(b.title || '') ? 2 : 0) + (/official/i.test(b.channel || '') ? 2 : 0);
      return bScore - aScore;
    });
    for (const c of sorted) {
      const vid = c.videoId || c.id;
      if (vid && /^[\w-]{11}$/.test(vid) && !ytIdsToCheck.includes(vid)) {
        ytIdsToCheck.push(vid);
      }
    }
  }

  for (const vid of ytIdsToCheck.slice(0, 4)) {
    const ytDesc = await fetchYouTubeDescription(vid);
    if (ytDesc) {
      const extracted = extractLyricsFromDescription(ytDesc);
      if (extracted) {
        return wrapResult(extracted, 'youtube_description');
      }
    }
  }

  // Priority 2: lyrics.ovh (fast, unblocked global API with millions of tracks)
  if (artist || title) {
    const ovhLyrics = await fetchLyricsOvh(artist, title);
    if (ovhLyrics) {
      return wrapResult(ovhLyrics, 'lyrics_ovh');
    }
  }

  // Priority 3: LRCLIB plainLyrics
  if (artist || title) {
    const lrclibLyrics = await fetchLrclibPlain(artist, title, durationSec);
    if (lrclibLyrics) {
      return wrapResult(lrclibLyrics, 'lrclib_plain');
    }
  }

  // Priority 4: Genius Public Scraper
  if (artist || title) {
    try {
      const geniusLyrics = await fetchGeniusPlain(artist, title);
      if (geniusLyrics) {
        return wrapResult(geniusLyrics, 'genius');
      }
    } catch (_) {}
  }

  // Priority 5: DuckDuckGo Public Snippet Harvester (Phase 3.3)
  if (artist || title) {
    try {
      const ddgLyrics = await fetchDuckDuckGoSnippet(artist, title);
      if (ddgLyrics) {
        return wrapResult(ddgLyrics, 'duckduckgo_snippet');
      }
    } catch (_) {}
  }

  return null;
}

async function harvestPlainLyricsFull(artistOrOptions, maybeTitle, maybeYoutubeId, maybeOptions = {}) {
  if (typeof artistOrOptions === 'object' && artistOrOptions !== null) {
    return harvestPlainLyrics({
      ...artistOrOptions,
      fullResult: true,
    });
  }
  return harvestPlainLyrics({
    artist: artistOrOptions,
    title: maybeTitle,
    youtubeId: maybeYoutubeId,
    ...maybeOptions,
    fullResult: true,
  });
}

module.exports = {
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
};
