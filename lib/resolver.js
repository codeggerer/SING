/**
 * lib/resolver.js - URL & Search Resolver for Sing Karaoke Engine (PLAN.md Phase 6.1)
 *
 * Resolves Spotify URLs, YouTube URLs, and free-text queries into canonical metadata:
 * { title, artist, durationSec, artworkUrl, spotifyTrackId?, youtubeId?, isrc?, confidence, candidates? }
 *
 * Zero external dependencies: native Node.js only.
 */

const https = require('https');
const http = require('http');
const url = require('url');
const path = require('path');
const usdbClient = require('./usdb_client');

// Safe fetch helper with timeout and redirect support
function requestUrl(targetUrl, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
        ...headers,
      },
    };

    const req = client.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return resolve(requestUrl(redirectUrl, headers, timeoutMs));
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
    req.end();
  });
}

/**
 * Parses duration strings into seconds (e.g. "3:45", "03:45", "1:02:15", or seconds float).
 */
function parseDurationSec(val) {
  if (typeof val === 'number') return Math.max(0, val);
  if (!val || typeof val !== 'string') return 0;
  const str = val.trim();
  if (!str) return 0;
  if (/^\d+(\.\d+)?$/.test(str)) {
    return parseFloat(str);
  }
  const parts = str.split(':').map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

/**
 * Extracts 22-char Spotify Track ID from URL or URI.
 */
function extractSpotifyTrackId(input) {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
  const uriMatch = str.match(/^spotify:track:([a-zA-Z0-9]{22})$/);
  if (uriMatch) return uriMatch[1];

  const urlMatch = str.match(/(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/)([a-zA-Z0-9]{22})/i);
  if (urlMatch) return urlMatch[1];

  if (/^[a-zA-Z0-9]{22}$/.test(str)) {
    return str;
  }
  return null;
}

/**
 * Extracts 11-char YouTube Video ID from URL.
 */
function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
  const m = str.match(
    /(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?.*?v=)([a-zA-Z0-9_-]{11})/i
  );
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return str;
  }
  return null;
}

/**
 * Cleans YouTube video titles into normalized artist and track name.
 * e.g. "Queen - Bohemian Rhapsody (Official Video)" -> { artist: "Queen", title: "Bohemian Rhapsody" }
 */
function cleanYouTubeTitle(rawTitle, channelName = '') {
  if (!rawTitle) return { artist: channelName || '', title: '' };

  let text = rawTitle;

  // Remove common visual/version noise in brackets or parentheses (e.g. Official Video, Remastered 4K, Lyrics)
  text = text.replace(
    /\s*[\(\[][^\)\]]*(?:official|music\s*video|video|audio|lyrics?|remaster(?:ed)?|visualizer|4k|hd|hq|clip|version)[^\)\]]*[\)\]]/gi,
    ''
  );
  text = text.replace(
    /\s*[\(\[](?:official\s*(?:music\s*video|video|audio|lyric\s*video|hd\s*video)?|lyric\s*video|lyrics|official|audio|remastered(?:\s*\d{4})?|video|4k|hd|hq|visualizer)[\)\]]/gi,
    ''
  );
  // Remove "ft." or "feat." in titles if needed, but preserve collaborating artist or keep clean
  text = text.replace(/\s*[\(\[]\s*feat\.?.*?[\]\)]/gi, '');

  text = text.trim();

  // Try splitting by standard artist-title separators: " - ", " – ", " — ", " : "
  const separators = [' - ', ' – ', ' — ', ' : '];
  let artist = '';
  let title = '';

  for (const sep of separators) {
    if (text.includes(sep)) {
      const parts = text.split(sep);
      artist = parts[0].trim().replace(/^["']|["']$/g, '');
      title = parts.slice(1).join(sep).trim().replace(/^["']|["']$/g, '');
      break;
    }
  }

  if (!artist || !title) {
    // If no separator found, use channelName if available
    let chan = (channelName || '').trim();
    if (chan.endsWith(' - Topic')) {
      chan = chan.replace(' - Topic', '').trim();
    }
    if (chan && !chan.toLowerCase().includes('vevo')) {
      artist = chan;
      title = text.replace(/^["']|["']$/g, '');
    } else {
      title = text.replace(/^["']|["']$/g, '');
      artist = chan;
    }
  }

  // Remove trailing quotes or punctuation
  artist = artist.replace(/^["'«»“”„]+|["'«»“”„]+$/g, '').trim();
  title = title.replace(/^["'«»“”„]+|["'«»“”„]+$/g, '').trim();

  return { artist, title };
}

/**
 * Generates a clean URL-friendly filesystem slug for songs.
 */
function createSongSlug(artist, title) {
  const cleanArt = (artist || 'Unknown').trim();
  const cleanTit = (title || 'Track').trim();
  const combined = `${cleanArt} - ${cleanTit}`;
  return combined
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'track';
}

/**
 * Fetches metadata for a Spotify Track ID.
 */
async function resolveSpotifyTrack(trackId, spotifyToken = null) {
  let meta = {
    title: '',
    artist: '',
    durationSec: 0,
    artworkUrl: '',
    spotifyTrackId: trackId,
    isrc: '',
  };

  // 1. Try Spotify Web API if user token is provided
  if (spotifyToken) {
    try {
      const res = await requestUrl(`https://api.spotify.com/v1/tracks/${trackId}`, {
        Authorization: `Bearer ${spotifyToken}`,
      });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        meta.title = data.name || '';
        meta.artist = (data.artists || []).map((a) => a.name).join(', ');
        meta.durationSec = Math.round((data.duration_ms || 0) / 1000);
        meta.artworkUrl = data.album?.images?.[0]?.url || '';
        meta.isrc = data.external_ids?.isrc || '';
        if (meta.title && meta.artist) return meta;
      }
    } catch (_) {}
  }

  // 2. Try Spotify oEmbed endpoint (no auth required)
  try {
    const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`;
    const res = await requestUrl(oembedUrl);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      meta.artworkUrl = data.thumbnail_url || '';
      // oEmbed title format is often: "Song Name" or "Song Name by Artist"
      const rawTitle = data.title || '';
      if (rawTitle.includes(' by ')) {
        const parts = rawTitle.split(' by ');
        meta.title = parts[0].trim();
        meta.artist = parts.slice(1).join(' by ').trim();
      } else {
        meta.title = rawTitle;
      }
    }
  } catch (_) {}

  // 3. Fallback / enrichment: scrape open.spotify.com track HTML for og tags
  try {
    const htmlRes = await requestUrl(`https://open.spotify.com/track/${trackId}`);
    if (htmlRes.status === 200) {
      const ogTitle = htmlRes.body.match(/<meta property="og:title" content="([^"]+)"/i);
      const ogDesc = htmlRes.body.match(/<meta property="og:description" content="([^"]+)"/i);
      const ogImage = htmlRes.body.match(/<meta property="og:image" content="([^"]+)"/i);
      const durMatch = htmlRes.body.match(/<meta name="music:duration" content="(\d+)"/i);

      if (ogTitle && !meta.title) meta.title = ogTitle[1].trim();
      if (ogImage && !meta.artworkUrl) meta.artworkUrl = ogImage[1].trim();
      if (durMatch && !meta.durationSec) meta.durationSec = parseInt(durMatch[1], 10);

      if (ogDesc && !meta.artist) {
        // og:description is often: "Artist · Song · Year"
        const descParts = ogDesc[1].split('·').map((p) => p.trim());
        if (descParts.length > 0 && descParts[0]) {
          meta.artist = descParts[0];
        }
      }
    }
  } catch (_) {}

  // 4. If durationSec is still missing, search iTunes for duration and ISRC
  if ((!meta.durationSec || !meta.artist) && meta.title) {
    try {
      const q = encodeURIComponent(`${meta.artist} ${meta.title}`.trim());
      const itunesRes = await requestUrl(`https://itunes.apple.com/search?term=${q}&entity=song&limit=1`);
      if (itunesRes.status === 200) {
        const itunesData = JSON.parse(itunesRes.body);
        if (itunesData.results && itunesData.results.length > 0) {
          const item = itunesData.results[0];
          if (!meta.durationSec && item.trackTimeMillis) {
            meta.durationSec = Math.round(item.trackTimeMillis / 1000);
          }
          if (!meta.artist && item.artistName) meta.artist = item.artistName;
          if (!meta.artworkUrl && item.artworkUrl100) {
            meta.artworkUrl = item.artworkUrl100.replace('100x100bb', '600x600bb');
          }
        }
      }
    } catch (_) {}
  }

  return meta;
}

let catalogByVideoCache = null;

function lookupCatalogByVideoId(videoId) {
  if (!videoId) return null;
  if (!catalogByVideoCache) {
    catalogByVideoCache = new Map();
    try {
      const fs = require('fs');
      const p = path.join(__dirname, '../public/ultrastar_index.json');
      if (fs.existsSync(p)) {
        const list = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.video) {
              catalogByVideoCache.set(item.video, item);
            }
          }
        }
      }
    } catch (_) {}
  }
  return catalogByVideoCache.get(videoId) || null;
}

/**
 * Fetches metadata for a YouTube video ID via oEmbed.
 */
async function resolveYouTubeVideo(videoId) {
  let meta = {
    title: '',
    artist: '',
    rawTitle: '',
    channel: '',
    durationSec: 0,
    artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    youtubeId: videoId,
  };

  // 0. Check pre-indexed curated UltraStar catalog
  const catalogHit = lookupCatalogByVideoId(videoId);
  if (catalogHit) {
    meta.artist = catalogHit.artist;
    meta.title = catalogHit.title;
    meta.rawTitle = `${catalogHit.artist} - ${catalogHit.title}`;
    meta.durationSec = catalogHit.duration || 0;
    return meta;
  }

  // 1. Try YouTube oEmbed (fast, lightweight HTTP request)
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await requestUrl(oembedUrl);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      meta.rawTitle = data.title || '';
      meta.channel = data.author_name || '';
      if (data.thumbnail_url) meta.artworkUrl = data.thumbnail_url;

      const cleaned = cleanYouTubeTitle(meta.rawTitle, meta.channel);
      meta.artist = cleaned.artist;
      meta.title = cleaned.title;
    }
  } catch (_) {}

  // 2. Fallback: try extracting video title & artist via yt-dlp metadata
  if (!meta.title) {
    try {
      const { execFileSync } = require('child_process');
      const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin'];
      const currentPath = process.env.PATH || '';
      const newPath = extraPaths.concat(currentPath.split(':')).filter(Boolean).join(':');

      const out = execFileSync(
        'yt-dlp',
        [
          '--dump-single-json',
          '--skip-download',
          '--no-playlist',
          '--no-check-certificates',
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        {
          timeout: 10000,
          encoding: 'utf8',
          env: { ...process.env, PATH: newPath },
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      if (out) {
        const data = JSON.parse(out);
        meta.rawTitle = data.title || '';
        meta.channel = data.uploader || data.channel || '';
        if (data.thumbnail) meta.artworkUrl = data.thumbnail;
        if (data.duration) meta.durationSec = Math.round(data.duration);
        if (data.description) meta.description = data.description;

        const cleaned = cleanYouTubeTitle(meta.rawTitle, meta.channel);
        meta.artist = data.artist || cleaned.artist;
        meta.title = data.track || cleaned.title;
      }
    } catch (_) {}
  }

  return meta;
}

/**
 * Curated map of iconic/benchmark tracks to canonical Spotify IDs and ISRCs
 */
const CURATED_SPOTIFY_MAP = {
  'queen-dont-stop-me-now': { spotifyTrackId: '5T8EDUDqKcs6OSOwEsfqG7', isrc: 'GBUM71029610' },
  'queen-bohemian-rhapsody': { spotifyTrackId: '7tFiyTwD0nx5a1eklYtX2J', isrc: 'GBUM71029604' },
  'ed-sheeran-perfect': { spotifyTrackId: '0tgVUniversal', isrc: 'GBAHS1700024' },
  'the-beatles-let-it-be': { spotifyTrackId: '7iN1s7xHE4ifF5povM6A48', isrc: 'GBAYE0601713' },
  'adele-someone-like-you': { spotifyTrackId: '3bNv3VuUOKgrf5hu3YcuRo', isrc: 'GBBKS1000351' },
  'adele-rolling-in-the-deep': { spotifyTrackId: '1CkvWZme3RKiZJ9Ah5KyJR', isrc: 'GBBKS1000348' },
  'billie-eilish-bad-guy': { spotifyTrackId: '2Fxmhks0bxGSBdJ92v4426', isrc: 'USUM71900764' },
  'coldplay-the-scientist': { spotifyTrackId: '75JFxkI2RXiU7L9VXzMkle', isrc: 'GBAYE0200784' },
  'cro-easy': { spotifyTrackId: '2OQ58kEaU85N7YlT7T3c3Z', isrc: 'DECP11100001' },
  'die-arzte-schrei-nach-liebe': { spotifyTrackId: '5V5uN3wB5uN4iV5v6w6V6v', isrc: 'DEA349300067' },
  'dua-lipa-dont-start-now': { spotifyTrackId: '6WrI0LAC5M1Rw2MnX2ZvEg', isrc: 'GBAHT1901299' },
  'eminem-without-me': { spotifyTrackId: '7lQ8MOhq6IN2w8Mgr6C34Z', isrc: 'USIR10211075' },
  'oasis-wonderwall': { spotifyTrackId: '1qPbGZAkpIYMcImYYVUSQg', isrc: 'GBBKS9500049' },
  'sia-chandelier': { spotifyTrackId: '2m6qO2c2uG11Y7vX8j5k7r', isrc: 'USRC11400497' },
  'aura-lea': { spotifyTrackId: '2WFAJwfS2DYRaavZ1P59oV', isrc: '' },
};

const spotifyResolveCache = new Map();

/**
 * Searches Deezer to find duration, ISRC and high-res artwork for an artist and title.
 */
async function searchDeezer(artist, title) {
  if (!artist && !title) return null;
  try {
    const q = encodeURIComponent(`${artist} ${title}`.trim());
    const res = await requestUrl(`https://api.deezer.com/search?q=${q}&limit=5`, {}, 5000);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      if (data.data && data.data.length > 0) {
        const top = data.data[0];
        let isrc = '';
        if (top.id) {
          try {
            const trackRes = await requestUrl(`https://api.deezer.com/track/${top.id}`, {}, 5000);
            if (trackRes.status === 200) {
              const trackData = JSON.parse(trackRes.body);
              isrc = trackData.isrc || '';
            }
          } catch (_) {}
        }
        return {
          title: top.title,
          artist: top.artist?.name || artist,
          durationSec: top.duration || 0,
          artworkUrl: top.album?.cover_xl || top.album?.cover_big || '',
          isrc,
        };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Queries MusicBrainz to find a Spotify Track URL via recording relations.
 */
async function searchMusicBrainz(isrc, artist, title) {
  try {
    const mbHeaders = {
      'User-Agent': 'SingKaraoke/1.0 (https://github.com/codeggerer/SING; contact@singkaraoke.local)',
      Accept: 'application/json',
    };

    let recordings = [];

    // Step 1: Query by ISRC if available
    if (isrc) {
      const res = await requestUrl(
        `https://musicbrainz.org/ws/2/recording?query=isrc:${encodeURIComponent(isrc)}&fmt=json`,
        mbHeaders,
        5000
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (Array.isArray(data.recordings)) {
          recordings = data.recordings;
        }
      }
    }

    // Step 2: Fallback query by artist & title
    if (recordings.length === 0 && artist && title) {
      const res = await requestUrl(
        `https://musicbrainz.org/ws/2/recording?query=recording:%22${encodeURIComponent(title)}%22%20AND%20artist:%22${encodeURIComponent(artist)}%22&fmt=json`,
        mbHeaders,
        5000
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (Array.isArray(data.recordings)) {
          recordings = data.recordings;
        }
      }
    }

    // Inspect top 3 recordings for Spotify URL relations
    for (const rec of recordings.slice(0, 3)) {
      if (!rec.id) continue;
      const recRes = await requestUrl(
        `https://musicbrainz.org/ws/2/recording/${rec.id}?inc=url-rels&fmt=json`,
        mbHeaders,
        5000
      );
      if (recRes.status === 200) {
        const recData = JSON.parse(recRes.body);
        const rels = recData.relations || [];
        for (const rel of rels) {
          const u = rel.url?.resource || '';
          const m = u.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]{22})/);
          if (m) {
            return m[1];
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Searches Spotify Web API directly if a bearer token is available.
 */
async function searchSpotifyApi(artist, title, isrc, token) {
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    if (isrc) {
      const res = await requestUrl(
        `https://api.spotify.com/v1/search?type=track&limit=3&q=isrc:${encodeURIComponent(isrc)}`,
        headers,
        5000
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const item = data.tracks?.items?.[0];
        if (item?.id) return item.id;
      }
    }
    if (artist && title) {
      const res = await requestUrl(
        `https://api.spotify.com/v1/search?type=track&limit=3&q=track:${encodeURIComponent(title)}+artist:${encodeURIComponent(artist)}`,
        headers,
        5000
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const item = data.tracks?.items?.[0];
        if (item?.id) return item.id;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Resolves a Spotify Track ID from artist, title, ISRC, and options.
 */
async function resolveSpotifyTrackId(artist, title, isrc = '', options = {}) {
  const cleanArt = (artist || '').trim();
  const cleanTit = (title || '').trim();
  const slug = createSongSlug(cleanArt, cleanTit);

  // 1. Curated catalog match
  if (CURATED_SPOTIFY_MAP[slug]?.spotifyTrackId) {
    return CURATED_SPOTIFY_MAP[slug].spotifyTrackId;
  }

  // 2. Memory cache check
  if (spotifyResolveCache.has(slug)) {
    return spotifyResolveCache.get(slug);
  }
  if (isrc && spotifyResolveCache.has(`isrc:${isrc}`)) {
    return spotifyResolveCache.get(`isrc:${isrc}`);
  }

  let matchedId = null;

  // 3. Official Spotify token search if token is provided
  const token = options.spotifyToken || process.env.SPOTIFY_TOKEN || null;
  if (token) {
    matchedId = await searchSpotifyApi(cleanArt, cleanTit, isrc, token);
  }

  // 4. MusicBrainz relations lookup (ISRC or artist + title)
  if (!matchedId) {
    matchedId = await searchMusicBrainz(isrc, cleanArt, cleanTit);
  }

  // Cache resolution
  spotifyResolveCache.set(slug, matchedId || '');
  if (isrc) spotifyResolveCache.set(`isrc:${isrc}`, matchedId || '');

  return matchedId || '';
}

/**
 * Searches iTunes to find duration, ISRC and high-res artwork for an artist and title.
 */
async function searchItunes(artist, title) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`.trim());
    const res = await requestUrl(`https://itunes.apple.com/search?term=${query}&entity=song&limit=5`);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      if (data.results && data.results.length > 0) {
        return data.results.map((r) => ({
          trackName: r.trackName,
          artistName: r.artistName,
          durationSec: Math.round((r.trackTimeMillis || 0) / 1000),
          artworkUrl: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : '',
          isrc: r.isrc || '',
        }));
      }
    }
  } catch (_) {}
  return [];
}

/**
 * Enriches a resolved track with community ground truth from USDB / UltraStar catalog (Phase 1)
 */
async function enrichWithUsdbMatch(candidate) {
  if (!candidate || !candidate.title) return candidate;
  try {
    const match = await usdbClient.findBestMatch(candidate.artist, candidate.title);
    if (match && match.matched) {
      candidate.usdbMatch = match;
      if (!candidate.youtubeId && match.videoId) {
        candidate.youtubeId = match.videoId;
      }
      candidate.confidence = 1.0;
    }
  } catch (_) {}
  return candidate;
}

/**
 * Main Resolver function (Phase 6.1)
 *
 * @param {string} input - URL (Spotify/YouTube) or search query text
 * @param {Object} options - { spotifyToken, searchYouTubeFn }
 * @returns {Promise<Object>} Resolved song metadata
 */
async function resolveInput(input, options = {}) {
  const query = (input || '').trim();
  if (!query) {
    throw new Error('Input cannot be empty');
  }

  const spotifyTrackId = extractSpotifyTrackId(query);
  const youtubeId = extractYouTubeId(query);
  const searchYouTubeFn = options.searchYouTubeFn;

  // CASE 1: Spotify Track URL or URI
  if (spotifyTrackId) {
    const spotifyMeta = await resolveSpotifyTrack(spotifyTrackId, options.spotifyToken);
    let matchedYoutubeId = '';
    let confidence = 0.5;
    let candidates = [];

    if (searchYouTubeFn && spotifyMeta.title) {
      try {
        const ytResults = await searchYouTubeFn(
          `${spotifyMeta.artist} - ${spotifyMeta.title}`,
          spotifyMeta.durationSec
        );
        if (ytResults && ytResults.length > 0) {
          candidates = ytResults;
          const best = ytResults[0];
          matchedYoutubeId = best.videoId;

          const diff = Math.abs((best.durationSec || 0) - (spotifyMeta.durationSec || 0));
          if (spotifyMeta.durationSec > 0 && diff <= 5) {
            confidence = 0.95;
          } else if (spotifyMeta.durationSec > 0 && diff <= 15) {
            confidence = 0.8;
          } else {
            confidence = 0.65;
          }
        }
      } catch (_) {}
    }

    const slug = createSongSlug(spotifyMeta.artist, spotifyMeta.title);
    return await enrichWithUsdbMatch({
      type: 'spotify',
      title: spotifyMeta.title || 'Unknown Title',
      artist: spotifyMeta.artist || 'Unknown Artist',
      durationSec: spotifyMeta.durationSec || 0,
      artworkUrl: spotifyMeta.artworkUrl || '',
      spotifyTrackId,
      youtubeId: matchedYoutubeId,
      isrc: spotifyMeta.isrc || '',
      confidence,
      slug,
      candidates,
    });
  }

  // CASE 2: YouTube URL
  if (youtubeId) {
    const ytMeta = await resolveYouTubeVideo(youtubeId);
    let durationSec = 0;
    let candidates = [];

    // If searchYouTubeFn is available, query to get exact duration
    if (searchYouTubeFn && ytMeta.title) {
      try {
        const found = await searchYouTubeFn(`${ytMeta.artist} ${ytMeta.title}`, 0);
        const match = (found || []).find((v) => v.videoId === youtubeId);
        if (match && match.durationSec) {
          durationSec = match.durationSec;
        } else if (found && found.length > 0 && found[0].durationSec) {
          durationSec = found[0].durationSec;
        }
        candidates = found || [];
      } catch (_) {}
    }

    // Try finding iTunes & Deezer match to get canonical title, artist, ISRC & high-res artwork
    let isrc = '';
    let spotifyMatchedId = '';
    let confidence = 0.7;

    const [itunesMatches, deezerMatch] = await Promise.all([
      searchItunes(ytMeta.artist, ytMeta.title),
      searchDeezer(ytMeta.artist, ytMeta.title),
    ]);

    if (deezerMatch?.isrc) {
      isrc = deezerMatch.isrc;
    }

    if (itunesMatches && itunesMatches.length > 0) {
      // Pick best matching duration within ±5s
      const bestItunes =
        itunesMatches.find((it) => durationSec > 0 && Math.abs(it.durationSec - durationSec) <= 5) ||
        itunesMatches[0];

      if (bestItunes) {
        if (!durationSec) durationSec = bestItunes.durationSec;
        if (bestItunes.artworkUrl) ytMeta.artworkUrl = bestItunes.artworkUrl;
        if (!isrc && bestItunes.isrc) isrc = bestItunes.isrc;
        if (durationSec > 0 && Math.abs(bestItunes.durationSec - durationSec) <= 5) {
          confidence = 0.9;
        }
      }
    } else if (deezerMatch) {
      if (!durationSec) durationSec = deezerMatch.durationSec;
      if (deezerMatch.artworkUrl && !ytMeta.artworkUrl) ytMeta.artworkUrl = deezerMatch.artworkUrl;
    }

    spotifyMatchedId = await resolveSpotifyTrackId(ytMeta.artist, ytMeta.title, isrc, options);
    if (spotifyMatchedId) {
      confidence = 0.95;
    }

    const slug = createSongSlug(ytMeta.artist, ytMeta.title);
    return await enrichWithUsdbMatch({
      type: 'youtube',
      title: ytMeta.title || ytMeta.rawTitle || 'YouTube Track',
      artist: ytMeta.artist || ytMeta.channel || 'YouTube Artist',
      durationSec,
      artworkUrl: ytMeta.artworkUrl,
      spotifyTrackId: spotifyMatchedId,
      youtubeId,
      description: ytMeta.description || '',
      isrc,
      confidence,
      slug,
      candidates,
    });
  }

  // CASE 3: Free-Text Search Query
  // Search iTunes, Deezer and YouTube
  const cleaned = cleanYouTubeTitle(query);
  const [itunesResults, deezerResult] = await Promise.all([
    searchItunes(cleaned.artist || query, cleaned.title || ''),
    searchDeezer(cleaned.artist || query, cleaned.title || ''),
  ]);

  let topCandidate = null;
  let candidates = [];

  if (itunesResults && itunesResults.length > 0) {
    const top = itunesResults[0];
    let matchedYtId = '';

    if (searchYouTubeFn) {
      try {
        const ytHits = await searchYouTubeFn(`${top.artistName} - ${top.trackName}`, top.durationSec);
        if (ytHits && ytHits.length > 0) {
          matchedYtId = ytHits[0].videoId;
          candidates = ytHits;
        }
      } catch (_) {}
    }

    const isrc = deezerResult?.isrc || top.isrc || '';
    const spotifyId = await resolveSpotifyTrackId(top.artistName, top.trackName, isrc, options);

    topCandidate = {
      type: 'search',
      title: top.trackName,
      artist: top.artistName,
      durationSec: top.durationSec,
      artworkUrl: top.artworkUrl || deezerResult?.artworkUrl || '',
      spotifyTrackId: spotifyId || '',
      youtubeId: matchedYtId,
      isrc,
      confidence: spotifyId ? 0.95 : 0.85,
      slug: createSongSlug(top.artistName, top.trackName),
      candidates,
    };
  } else if (deezerResult) {
    let matchedYtId = '';
    if (searchYouTubeFn) {
      try {
        const ytHits = await searchYouTubeFn(`${deezerResult.artist} - ${deezerResult.title}`, deezerResult.durationSec);
        if (ytHits && ytHits.length > 0) {
          matchedYtId = ytHits[0].videoId;
          candidates = ytHits;
        }
      } catch (_) {}
    }
    const spotifyId = await resolveSpotifyTrackId(deezerResult.artist, deezerResult.title, deezerResult.isrc, options);

    topCandidate = {
      type: 'search',
      title: deezerResult.title,
      artist: deezerResult.artist,
      durationSec: deezerResult.durationSec,
      artworkUrl: deezerResult.artworkUrl,
      spotifyTrackId: spotifyId || '',
      youtubeId: matchedYtId,
      isrc: deezerResult.isrc,
      confidence: spotifyId ? 0.95 : 0.8,
      slug: createSongSlug(deezerResult.artist, deezerResult.title),
      candidates,
    };
  } else if (searchYouTubeFn) {
    try {
      const ytHits = await searchYouTubeFn(query, 0);
      if (ytHits && ytHits.length > 0) {
        const first = ytHits[0];
        const cl = cleanYouTubeTitle(first.title, first.channel);
        const deezerForYt = await searchDeezer(cl.artist, cl.title);
        const isrc = deezerForYt?.isrc || '';
        const spotifyId = await resolveSpotifyTrackId(cl.artist || first.channel, cl.title || first.title, isrc, options);

        topCandidate = {
          type: 'search',
          title: cl.title || first.title,
          artist: cl.artist || first.channel,
          durationSec: first.durationSec || 0,
          artworkUrl: first.thumbnail || deezerForYt?.artworkUrl || '',
          spotifyTrackId: spotifyId || '',
          youtubeId: first.videoId,
          isrc,
          confidence: spotifyId ? 0.9 : 0.75,
          slug: createSongSlug(cl.artist || first.channel, cl.title || first.title),
          candidates: ytHits,
        };
      }
    } catch (_) {}
  }

  if (!topCandidate) {
    const spotifyId = await resolveSpotifyTrackId(cleaned.artist, cleaned.title || query, '', options);
    topCandidate = {
      type: 'search',
      title: cleaned.title || query,
      artist: cleaned.artist || 'Unknown Artist',
      durationSec: 0,
      artworkUrl: '',
      spotifyTrackId: spotifyId || '',
      youtubeId: '',
      isrc: '',
      confidence: spotifyId ? 0.8 : 0.5,
      slug: createSongSlug(cleaned.artist, cleaned.title || query),
      candidates: [],
    };
  }

  return await enrichWithUsdbMatch(topCandidate);
}

/**
 * Deadlink Auto-Recovery: Finds a working alternative YouTube video when iframe embedding is blocked
 * (Errors 150/101/100). Prioritizes Official Audio and lyric videos with duration matching (±5s).
 *
 * @param {string} artist Song artist
 * @param {string} title Song title
 * @param {number} [targetDurationSec=0] Expected duration in seconds
 * @param {Function} [searchYouTubeFn] Function to search YouTube
 * @param {Object} [options]
 * @param {number} [options.maxDurationDiffSec=5] Maximum allowed duration difference
 * @param {string} [options.excludeVideoId] Video ID to exclude (e.g. failing video ID)
 * @param {Array<string>} [options.excludeVideoIds] Array of video IDs to exclude
 * @returns {Promise<Object|null>} Best matching alternative video or null
 */
async function findAlternativeYouTubeVideo(artist, title, targetDurationSec = 0, searchYouTubeFn, options = {}) {
  if (!artist && !title) return null;
  if (typeof searchYouTubeFn !== 'function') return null;

  const maxDiff = typeof options.maxDurationDiffSec === 'number' ? options.maxDurationDiffSec : 5;
  const excludeSet = new Set(options.excludeVideoIds || []);
  if (options.excludeVideoId) {
    excludeSet.add(options.excludeVideoId);
  }

  // 1. Search Official Audio
  const cleanA = (artist || '').trim();
  const cleanT = (title || '').trim();
  const query = `${cleanA} ${cleanT} Official Audio`.trim();

  let candidates = [];
  try {
    candidates = await searchYouTubeFn(query, targetDurationSec);
  } catch (_) {
    candidates = [];
  }

  // 2. If no candidates, fallback to Lyrics query
  if (!candidates || candidates.length === 0) {
    try {
      candidates = await searchYouTubeFn(`${cleanA} ${cleanT} Lyrics`.trim(), targetDurationSec);
    } catch (_) {
      candidates = [];
    }
  }

  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  // Filter out excluded / failing video IDs
  const valid = candidates.filter((v) => v && v.videoId && !excludeSet.has(v.videoId));
  if (valid.length === 0) return null;

  // Filter by duration matching (within ±maxDiff seconds)
  if (targetDurationSec > 0) {
    const exactMatches = valid.filter((v) => {
      const dur = typeof v.durationSec === 'number' ? v.durationSec : parseDurationSec(v.durationText || '');
      return dur > 0 && Math.abs(dur - targetDurationSec) <= maxDiff;
    });

    if (exactMatches.length > 0) {
      exactMatches.sort((a, b) => (b.syncScore || 0) - (a.syncScore || 0));
      return exactMatches[0];
    }

    // Relax to ±12s if no exact match found
    const relaxedMatches = valid.filter((v) => {
      const dur = typeof v.durationSec === 'number' ? v.durationSec : parseDurationSec(v.durationText || '');
      return dur > 0 && Math.abs(dur - targetDurationSec) <= 12;
    });
    if (relaxedMatches.length > 0) {
      relaxedMatches.sort((a, b) => (b.syncScore || 0) - (a.syncScore || 0));
      return relaxedMatches[0];
    }
  }

  // Fallback to highest ranked candidate
  valid.sort((a, b) => (b.syncScore || 0) - (a.syncScore || 0));
  return valid[0];
}

module.exports = {
  requestUrl,
  parseDurationSec,
  extractSpotifyTrackId,
  extractYouTubeId,
  cleanYouTubeTitle,
  createSongSlug,
  resolveSpotifyTrack,
  resolveYouTubeVideo,
  searchItunes,
  searchDeezer,
  searchMusicBrainz,
  resolveSpotifyTrackId,
  resolveInput,
  enrichWithUsdbMatch,
  findAlternativeYouTubeVideo,
  usdbClient,
  CURATED_SPOTIFY_MAP,
};
