const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const {
  fetchLyrics,
  getLyricsStatus,
  setLocalConfig,
  setPkceToken,
} = require('./lib/lyrics');
const { harvestPlainLyricsFull } = require('./lib/lyrics_harvester');
const { resolveInput } = require('./lib/resolver');
const {
  checkSystemHealth,
  createOrGetJob,
  getJob,
  cancelJob,
  registerJobSse,
  JOBS_DIR,
} = require('./lib/jobs');
const { listLibrarySongs, serveSongFile, updateSongChart, updateSongVideoId, deleteSong, SONGS_DIR } = require('./lib/library');

const PORT = process.env.PORT || 3333;
const PUBLIC_DIR = path.join(__dirname, 'public');

function fetchUrl(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'SOCS=CAESEwgDEgk2MTQ1NzU1MDQaAmRlIAEaBgiA_LyaBg; CONSENT=YES+cb.20210328-17-p0.en+FX+100;',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return resolve(fetchUrl(redirectUrl, headers));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

function postUrl(targetUrl, bodyString, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyString),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(14000, () => req.destroy(new Error('Request timeout')));
    req.write(bodyString);
    req.end();
  });
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        resolve({});
      }
    });
  });
}

// USDB Session & Caching
const USDB_CONFIG_FILE = path.join(__dirname, 'usdb_config.json');
const USDB_CACHE_DIR = path.join(__dirname, 'usdb_cache');
const usdbClient = require('./lib/usdb_client');
const audioSync = require('./lib/audio_sync');
if (!fs.existsSync(USDB_CACHE_DIR)) {
  try {
    fs.mkdirSync(USDB_CACHE_DIR, { recursive: true });
  } catch (_) {}
}

let usdbSession = {
  username: '',
  cookie: '',
};

if (fs.existsSync(USDB_CONFIG_FILE)) {
  try {
    usdbSession = JSON.parse(fs.readFileSync(USDB_CONFIG_FILE, 'utf8'));
    console.log(`🔑 USDB Gespeicherte Session geladen für: ${usdbSession.username}`);
  } catch (_) {}
}

async function loginUsdb(user, pass) {
  return await usdbClient.loginUsdb(user, pass);
}

async function searchUsdb(query) {
  return await usdbClient.searchUsdb(query);
}

async function getUsdbSong(id) {
  return await usdbClient.getUsdbSong(id);
}

function parseDurationString(str) {
  if (!str) return null;
  const parts = str.split(':').map((n) => parseInt(n, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

async function searchYouTube(query, targetDurationSec = 0) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;
  const { body } = await fetchUrl(searchUrl);

  const match = body.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!match) {
    return [];
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    return [];
  }

  const contents =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

  const videos = [];

  for (const section of contents) {
    const items = section?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const v = item.videoRenderer;
      if (!v || !v.videoId) continue;

      const title = v.title?.runs?.map((r) => r.text).join('') || '';
      const channel = v.ownerText?.runs?.map((r) => r.text).join('') || '';
      const durationText = v.lengthText?.simpleText || '';
      const durationSec = parseDurationString(durationText);
      const thumbnail =
        v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1]?.url ||
        `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

      if (!durationSec) continue; // skip live streams/shorts without length

      // Score how well this video fits synchronized studio lyrics
      let syncScore = 100;
      const lowerTitle = title.toLowerCase();
      const lowerChannel = channel.toLowerCase();

      if (targetDurationSec > 0) {
        const diff = Math.abs(durationSec - targetDurationSec);
        syncScore -= diff * 3.5; // strongly prefer matching duration
      }

      const expectedTitle = (query.includes(' - ') ? query.split(' - ').slice(1).join(' - ') : query)
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim();
      const normTitle = lowerTitle.replace(/[^\w\s]/g, '');
      if (expectedTitle && expectedTitle.length >= 3 && normTitle.includes(expectedTitle)) {
        syncScore += 60; // Strong bonus: video title explicitly contains target song title
      } else if (expectedTitle && expectedTitle.length >= 4) {
        syncScore -= 45; // Strong penalty: video is likely a different song by the same artist
      }

      if (lowerTitle.includes('official audio') || lowerTitle.includes('(audio)')) syncScore += 25;
      if (lowerTitle.includes('official video') || lowerTitle.includes('official visualizer') || lowerTitle.includes('music video')) syncScore += 35;
      if (lowerChannel.includes('official')) syncScore += 30;
      if (lowerChannel.includes('- topic')) syncScore += 30;
      if (query && lowerChannel.includes(query.toLowerCase().split(' - ')[0].trim())) syncScore += 25;
      if (lowerTitle.includes('lyrics') || lowerTitle.includes('lyric video')) syncScore += 18;
      if (lowerTitle.includes('karaoke') || lowerTitle.includes('instrumental')) syncScore += 10;
      if (lowerTitle.includes('live') || lowerTitle.includes('concert')) syncScore -= 30;
      if (lowerTitle.includes('extended') || lowerTitle.includes('1 hour')) syncScore -= 80;

      const durationDiffSec = targetDurationSec > 0 ? durationSec - targetDurationSec : 0;

      videos.push({
        videoId: v.videoId,
        title,
        channel,
        durationText,
        durationSec,
        durationDiffSec,
        thumbnail,
        syncScore: Math.round(syncScore),
      });
    }
  }

  videos.sort((a, b) => b.syncScore - a.syncScore);
  return videos.slice(0, 8);
}

async function handleSongSearch(query) {
  const [lrcRes, itunesRes] = await Promise.allSettled([
    fetchUrl(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`),
    fetchUrl(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=15`),
  ]);

  let lrcTracks = [];
  if (lrcRes.status === 'fulfilled' && lrcRes.value.status === 200) {
    try {
      const parsed = JSON.parse(lrcRes.value.body);
      if (Array.isArray(parsed)) {
        lrcTracks = parsed.filter((t) => t.syncedLyrics && t.syncedLyrics.trim().length > 0);
      }
    } catch (_) {}
  }

  let itunesTracks = [];
  if (itunesRes.status === 'fulfilled' && itunesRes.value.status === 200) {
    try {
      const parsed = JSON.parse(itunesRes.value.body);
      if (Array.isArray(parsed.results)) {
        itunesTracks = parsed.results;
      }
    } catch (_) {}
  }

  if (lrcTracks.length === 0 && itunesTracks.length > 0) {
    return itunesTracks.slice(0, 15).map((it) => ({
      id: it.trackId,
      trackName: it.trackName,
      artistName: it.artistName,
      albumName: it.collectionName || '',
      duration: Math.round((it.trackTimeMillis || 0) / 1000),
      syncedLyrics: null,
      plainLyrics: '',
      artworkUrl: it.artworkUrl100 ? it.artworkUrl100.replace('100x100bb', '400x400bb') : null,
      previewUrl: it.previewUrl || null,
    }));
  }

  // Enrich LRCLIB tracks with iTunes cover art & preview audio URL
  const results = lrcTracks.slice(0, 15).map((track) => {
    const artistLower = (track.artistName || '').toLowerCase();
    const titleLower = (track.trackName || '').toLowerCase();

    const matchedItunes =
      itunesTracks.find(
        (it) =>
          (it.artistName || '').toLowerCase().includes(artistLower.slice(0, 6)) &&
          (it.trackName || '').toLowerCase().includes(titleLower.slice(0, 6))
      ) || itunesTracks[0];

    const artwork = matchedItunes?.artworkUrl100
      ? matchedItunes.artworkUrl100.replace('100x100bb', '400x400bb')
      : null;

    return {
      id: track.id,
      trackName: track.trackName,
      artistName: track.artistName,
      albumName: track.albumName || matchedItunes?.collectionName || '',
      duration: Math.round(track.duration || (matchedItunes?.trackTimeMillis || 0) / 1000),
      syncedLyrics: track.syncedLyrics,
      plainLyrics: track.plainLyrics || '',
      artworkUrl: artwork,
      previewUrl: matchedItunes?.previewUrl || null,
    };
  });

  return results;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept-Ranges');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // Lyrics Provider API Endpoints (Phase 2)
    if (pathname === '/api/lyrics/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(getLyricsStatus()));
    }

    if (pathname === '/api/settings/spicy-key' && req.method === 'POST') {
      const data = await readRequestBody(req);
      if (typeof data.key === 'string') {
        setLocalConfig({ spicyLyricsKey: data.key.trim() });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing key field' }));
    }

    if (pathname === '/api/settings/sp-dc' && req.method === 'POST') {
      const data = await readRequestBody(req);
      if (typeof data.spDc === 'string') {
        setLocalConfig({ spotifySpDc: data.spDc.trim() });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing spDc field' }));
    }

    if (pathname === '/api/spotify/token' && req.method === 'POST') {
      const data = await readRequestBody(req);
      if (typeof data.token === 'string') {
        setPkceToken(data.token);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing token field' }));
    }

    if (pathname === '/api/lyrics') {
      let title = '';
      let artist = '';
      let durationSec = 0;
      let spotifyTrackId = '';

      if (req.method === 'POST') {
        const data = await readRequestBody(req);
        title = data.title || '';
        artist = data.artist || '';
        durationSec = data.durationSec ? parseFloat(data.durationSec) : 0;
        spotifyTrackId = data.spotifyTrackId || '';
      } else {
        title = parsedUrl.searchParams.get('title') || '';
        artist = parsedUrl.searchParams.get('artist') || '';
        durationSec = parseFloat(parsedUrl.searchParams.get('duration') || '0') || 0;
        spotifyTrackId = parsedUrl.searchParams.get('spotifyTrackId') || '';
      }

      const doc = await fetchLyrics({ title, artist, durationSec, spotifyTrackId });
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'No lyrics found for track' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(doc));
    }

    // Plain Lyrics Harvest Endpoint (UNSYNCED_LYRICS_OVERHAUL_PLAN Phase 1)
    if (pathname === '/api/lyrics/harvest' || pathname === '/api/lyrics/plain') {
      let title = '';
      let artist = '';
      let durationSec = 0;
      let youtubeId = '';

      try {
        if (req.method === 'POST') {
          const body = await readRequestBody(req);
          title = body.title || '';
          artist = body.artist || '';
          durationSec = parseFloat(body.duration || body.durationSec || '0') || 0;
          youtubeId = body.youtubeId || body.videoId || '';
          const candidates = Array.isArray(body.candidates) ? body.candidates : [];
          const description = body.description || '';
          const result = await harvestPlainLyricsFull({
            artist,
            title,
            youtubeId,
            candidates,
            description,
            durationSec,
          });
          if (!result || !result.lyrics) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: 'No plain lyrics harvested' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result));
        } else {
          title = parsedUrl.searchParams.get('title') || '';
          artist = parsedUrl.searchParams.get('artist') || '';
          durationSec = parseFloat(parsedUrl.searchParams.get('duration') || '0') || 0;
          youtubeId = parsedUrl.searchParams.get('youtubeId') || parsedUrl.searchParams.get('v') || '';
          const result = await harvestPlainLyricsFull({
            artist,
            title,
            youtubeId,
            durationSec,
          });
          if (!result || !result.lyrics) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: 'No plain lyrics harvested' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Health & Tool Status Endpoint (Phase 6.2)
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(checkSystemHealth()));
    }

    // Resolver Endpoint (Phase 6.1)
    if (pathname === '/api/resolve' || pathname === '/api/resolve/') {
      let input = '';
      if (req.method === 'POST') {
        const data = await readRequestBody(req);
        input = data.input || data.query || '';
      } else {
        input = parsedUrl.searchParams.get('input') || parsedUrl.searchParams.get('q') || '';
      }
      if (!input.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Missing input query or URL' }));
      }
      try {
        const resolved = await resolveInput(input, {
          searchYouTubeFn: (q, d) => searchYouTube(q, d),
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(resolved));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: err.message || 'Resolution failed' }));
      }
    }

    // Song Library Catalog (Phase 6.4)
    if (pathname === '/api/library') {
      const songs = listLibrarySongs();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ songs }));
    }

    // Delete Song from Library (supports DELETE /api/library/:slug and POST /api/library/:slug/delete)
    const libraryDeleteMatch = pathname.match(/^\/api\/library\/([a-zA-Z0-9_-]+)(?:\/delete)?$/);
    if (libraryDeleteMatch && (req.method === 'DELETE' || req.method === 'POST')) {
      const slug = libraryDeleteMatch[1];
      try {
        const result = deleteSong(slug);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Chart Editor API: Save & Read Chart (Phase 7.1)
    const libraryChartMatch = pathname.match(/^\/api\/library\/([a-zA-Z0-9_-]+)\/chart$/);
    if (libraryChartMatch) {
      const slug = libraryChartMatch[1];
      if (req.method === 'POST') {
        const body = await readRequestBody(req);
        const chartText = typeof body === 'string' ? body : (body.chartText || body.chart || '');
        if (!chartText.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'Chart text cannot be empty' }));
        }
        try {
          const result = updateSongChart(slug, chartText);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      } else if (req.method === 'GET') {
        const songTxtPath = path.join(SONGS_DIR, slug, 'song.txt');
        if (!fs.existsSync(songTxtPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'Chart file not found' }));
        }
        const content = fs.readFileSync(songTxtPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(content);
      }
    }

    // Update Song Video ID / Deadlink Recovery (Phase 1.2)
    const libraryVideoMatch = pathname.match(/^\/api\/library\/([a-zA-Z0-9_-]+)\/video$/);
    if (libraryVideoMatch && req.method === 'POST') {
      const slug = libraryVideoMatch[1];
      try {
        const body = await readRequestBody(req);
        const videoId = typeof body === 'object' && body ? body.videoId : '';
        if (!videoId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'Missing videoId in request body' }));
        }
        const result = updateSongVideoId(slug, videoId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Static & Range Streaming for /songs/<slug>/<file>
    if (pathname.startsWith('/songs/')) {
      return serveSongFile(req, res, pathname);
    }

    // Audio Upload Endpoint (Phase 6.2)
    if (pathname === '/api/upload' && req.method === 'POST') {
      const uploadDir = path.join(JOBS_DIR, 'uploads');
      if (!fs.existsSync(uploadDir)) {
        try {
          fs.mkdirSync(uploadDir, { recursive: true });
        } catch (_) {}
      }
      const rawFilename = req.headers['x-filename'] || 'upload.wav';
      const safeFilename = path.basename(rawFilename).replace(/[^\w.-]/g, '_');
      const tempPath = path.join(uploadDir, `${Date.now()}_${safeFilename}`);

      const writeStream = fs.createWriteStream(tempPath);
      let totalBytes = 0;
      const MAX_BYTES = 80 * 1024 * 1024; // 80 MB cap

      req.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          req.destroy(new Error('File exceeds maximum size limit of 80 MB'));
        }
      });

      req.pipe(writeStream);

      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        req.on('error', reject);
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({ success: true, uploadedAudioPath: tempPath, filename: safeFilename })
      );
    }

    // Job Management Endpoints (Phase 6.3)
    if ((pathname === '/api/jobs' || pathname === '/api/jobs/') && req.method === 'POST') {
      const data = await readRequestBody(req);
      if (!data.resolved || (!data.resolved.title && !data.resolved.slug)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Missing track metadata in resolved payload' }));
      }
      const job = createOrGetJob(data.resolved, data.options || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          jobId: job.id,
          status: job.status,
          slug: job.slug,
          progress: job.progress,
          message: job.message,
          result: job.result,
        })
      );
    }

    if ((pathname === '/api/jobs' || pathname === '/api/jobs/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'ok', active: true }));
    }

    const jobEventsMatch = pathname.match(/^\/api\/jobs\/([^\/]+)\/events$/);
    if (jobEventsMatch) {
      const jobId = jobEventsMatch[1];
      return registerJobSse(jobId, req, res);
    }

    const jobCancelMatch = pathname.match(/^\/api\/jobs\/([^\/]+)\/cancel$/);
    if (jobCancelMatch && req.method === 'POST') {
      const jobId = jobCancelMatch[1];
      const success = cancelJob(jobId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success }));
    }

    const jobGetMatch = pathname.match(/^\/api\/jobs\/([^\/]+)$/);
    if (jobGetMatch && req.method === 'GET') {
      const jobId = jobGetMatch[1];
      const job = getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Job not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(job));
    }

    // USDB API Endpoints
    if (pathname === '/api/usdb/status') {
      const session = usdbClient.getUsdbSession();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          loggedIn: !!session.cookie,
          username: session.username || '',
        })
      );
    }

    if (pathname === '/api/usdb/login' && req.method === 'POST') {
      const data = await readRequestBody(req);
      if (!data.username || !data.password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Benutzername und Passwort erforderlich' }));
      }
      try {
        const session = await usdbClient.loginUsdb(data.username, data.password);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, username: session.username }));
      } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message || 'Login fehlgeschlagen' }));
      }
    }

    if (pathname === '/api/usdb/logout' && req.method === 'POST') {
      usdbClient.logoutUsdb();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: true }));
    }

    if (pathname === '/api/usdb/search') {
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing query parameter q' }));
      }
      const session = usdbClient.getUsdbSession();
      if (!session.cookie) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ results: [], error: 'Not logged in to USDB' }));
      }
      try {
        const results = await usdbClient.searchUsdb(q);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ results }));
      } catch (err) {
        console.error('USDB search error:', err);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ results: [], error: err.message }));
      }
    }

    if (pathname === '/api/usdb/song') {
      const id = parseInt(parsedUrl.searchParams.get('id') || '', 10);
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing parameter id' }));
      }
      const session = usdbClient.getUsdbSession();
      if (!session.cookie && !usdbClient.getCachedChart(id)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not logged in to USDB' }));
      }
      try {
        const songData = await usdbClient.getUsdbSong(id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(songData));
      } catch (err) {
        console.error('USDB get song error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // USDB Fuzzy Ground-Truth Matcher (MASTER_OVERHAUL_PLAN Phase 1)
    if (pathname === '/api/usdb/match') {
      const artist = (parsedUrl.searchParams.get('artist') || '').trim();
      const title = (parsedUrl.searchParams.get('title') || '').trim();
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      let queryArtist = artist;
      let queryTitle = title;
      if (!queryTitle && q) {
        if (q.includes(' - ')) {
          const parts = q.split(' - ');
          queryArtist = parts[0].trim();
          queryTitle = parts.slice(1).join(' - ').trim();
        } else {
          queryTitle = q;
        }
      }
      try {
        const resolvedMatch = await usdbClient.resolveUsdbSong(
          { artist: queryArtist, title: queryTitle },
          { searchYouTubeFn: (sq, sd) => searchYouTube(sq, sd) }
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(resolvedMatch));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
    if (pathname === '/api/search') {
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing query parameter q' }));
      }
      const results = await handleSongSearch(q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ results }));
    }

    if (pathname === '/api/youtube') {
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      const duration = parseFloat(parsedUrl.searchParams.get('duration') || '0') || 0;
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing query parameter q' }));
      }

      // Search official audio, lyric videos and karaoke in parallel
      const [lyricVideos, audioVideos, karaokeVideos] = await Promise.all([
        searchYouTube(`${q} Lyrics`, duration).catch(() => []),
        searchYouTube(`${q} Official Audio`, duration).catch(() => []),
        searchYouTube(`${q} Karaoke Instrumental`, duration).catch(() => []),
      ]);

      // Deduplicate keeping high-ranking lyric and audio versions
      const seen = new Set();
      const combined = [];
      for (const v of [...lyricVideos, ...audioVideos, ...karaokeVideos.slice(0, 3)]) {
        if (!seen.has(v.videoId)) {
          seen.add(v.videoId);
          combined.push(v);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ videos: combined }));
    }

    // FFT Acoustic Cross-Correlation Alignment Endpoint (Phase 2)
    if (pathname === '/api/sync/align-gap' && req.method === 'POST') {
      try {
        const data = await readRequestBody(req);
        const { slug, ytAudioPath, refAudioPath, chartPath, updateChart, chartGapMs, method, maxDurationSec } = data;

        let targetChartPath = chartPath;
        let targetRefPath = refAudioPath;
        let targetYtPath = ytAudioPath;

        if (slug) {
          const songDir = path.join(SONGS_DIR, slug);
          if (!targetChartPath) {
            const potentialTxt = path.join(songDir, 'song.txt');
            if (fs.existsSync(potentialTxt)) targetChartPath = potentialTxt;
          }
          if (!targetRefPath) {
            const potentialInst = path.join(songDir, 'instrumental.wav');
            if (fs.existsSync(potentialInst)) targetRefPath = potentialInst;
          }
        }

        const result = await audioSync.alignAudioGap({
          ytAudioPath: targetYtPath,
          refAudioPath: targetRefPath,
          chartPath: targetChartPath,
          chartGapMs: typeof chartGapMs === 'number' ? chartGapMs : undefined,
          updateChart: !!updateChart,
          method: method || 'hybrid',
          maxDurationSec: typeof maxDurationSec === 'number' ? maxDurationSec : 120.0,
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Return JSON 404 for any unmatched /api routes
    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: `API route not found: ${pathname}` }));
    }

    // Serve static files
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    });
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    const health = checkSystemHealth();
    console.log(`🎤 Sing Karaoke Studio running at http://localhost:${PORT}`);
    console.log(`   * yt-dlp: ${health.ytDlpAvailable ? '✓ ' + health.ytDlpPath : '✗ not found'}`);
    console.log(`   * ffmpeg: ${health.ffmpegAvailable ? '✓ ' + health.ffmpegPath : '✗ not found'}`);
    console.log(`   * Python venv: ${health.pythonVenvAvailable ? '✓ ready' : '✗ venv not found'}`);
  });
}

module.exports = {
  server,
  searchYouTube,
};
