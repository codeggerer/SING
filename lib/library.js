/**
 * lib/library.js - Song Library & Streaming Server (PLAN.md Phase 6.4)
 *
 * Manages songs/<slug>/ catalog:
 * - Listing generated songs with metadata, quality badges, and playback info
 * - Path-safe static file delivery
 * - HTTP 206 Partial Content Range support for smooth audio streaming (instrumental.wav)
 *
 * Zero external dependencies: native Node.js only.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SONGS_DIR = path.join(PROJECT_ROOT, 'songs');

if (!fs.existsSync(SONGS_DIR)) {
  try {
    fs.mkdirSync(SONGS_DIR, { recursive: true });
  } catch (_) {}
}

const MIME_MAP = {
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Lists all generated songs available in the songs/ folder.
 */
function listLibrarySongs() {
  if (!fs.existsSync(SONGS_DIR)) return [];

  const entries = fs.readdirSync(SONGS_DIR, { withFileTypes: true });
  const songs = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const songDir = path.join(SONGS_DIR, slug);
    const txtPath = path.join(songDir, 'song.txt');

    if (!fs.existsSync(txtPath)) continue;

    const metaPath = path.join(songDir, 'meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {}
    }

    const hasInstrumental = fs.existsSync(path.join(songDir, 'instrumental.wav'));
    const hasVocals = fs.existsSync(path.join(songDir, 'vocals.wav'));
    const hasCover = fs.existsSync(path.join(songDir, 'cover.jpg'));

    // Quality classification & badge label
    // syncType: 'syllable' -> Syllable-synced, 'line' -> Line-synced, else AI-aligned
    let badgeType = 'AI-aligned';
    let badgeLabel = 'KI-Ausgerichtet';
    const syncType = (meta.syncType || '').toLowerCase();
    if (syncType === 'syllable') {
      badgeType = 'Syllable-synced';
      badgeLabel = 'Silben-Sync';
    } else if (syncType === 'line' || syncType === 'word') {
      badgeType = 'Line-synced';
      badgeLabel = 'Zeilen-Sync';
    }

    const stats = fs.statSync(txtPath);
    const createdAt = meta.createdAt || stats.birthtime?.toISOString() || stats.mtime.toISOString();

    songs.push({
      slug,
      title: meta.title || slug,
      artist: meta.artist || 'Unknown Artist',
      durationSec: meta.durationSec || 0,
      provider: meta.provider || 'whisper',
      syncType: meta.syncType || 'whisper',
      badgeType,
      badgeLabel,
      qualityScore: typeof meta.qualityScore === 'number' ? meta.qualityScore : 0.8,
      hasInstrumental,
      hasVocals,
      coverUrl: hasCover ? `/songs/${encodeURIComponent(slug)}/cover.jpg` : (meta.artworkUrl || null),
      instrumentalUrl: hasInstrumental ? `/songs/${encodeURIComponent(slug)}/instrumental.wav` : null,
      vocalsUrl: hasVocals ? `/songs/${encodeURIComponent(slug)}/vocals.wav` : null,
      chartUrl: `/songs/${encodeURIComponent(slug)}/song.txt`,
      youtubeId: meta.youtubeId || '',
      spotifyTrackId: meta.spotifyTrackId || '',
      pitchEngine: meta.pitchEngine || 'fcpe',
      edited: !!meta.edited,
      lastEditedAt: meta.lastEditedAt || null,
      createdAt,
    });
  }

  // Sort by createdAt desc (newest first)
  songs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return songs;
}

/**
 * Static file server for songs/<slug>/<file> with path traversal security
 * and HTTP 206 Partial Content Range support for audio streaming.
 */
function serveSongFile(req, res, targetPathname) {
  // targetPathname is like '/songs/queen-bohemian-rhapsody/instrumental.wav'
  const subPath = targetPathname.replace(/^\/songs\/?/, '');
  const decodedSubPath = decodeURIComponent(subPath);

  // Path traversal prevention: must resolve strictly inside SONGS_DIR
  const resolvedPath = path.resolve(SONGS_DIR, decodedSubPath);
  if (!resolvedPath.startsWith(SONGS_DIR) || resolvedPath === SONGS_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  if (!fs.existsSync(resolvedPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('File Not Found');
  }

  let stats;
  try {
    stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Internal Server Error');
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const totalSize = stats.size;

  // Handle HTTP Range header (crucial for seekable HTML5 audio/wav streaming)
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    if (isNaN(start)) {
      start = totalSize - end;
      end = totalSize - 1;
    }
    if (isNaN(end) || end >= totalSize) {
      end = totalSize - 1;
    }

    if (start > end || start >= totalSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Content-Type': contentType,
      });
      return res.end();
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    });

    const stream = fs.createReadStream(resolvedPath, { start, end });
    stream.on('error', () => {
      try {
        res.destroy();
      } catch (_) {}
    });
    return stream.pipe(res);
  }

  // Full file delivery (Status 200)
  res.writeHead(200, {
    'Content-Length': totalSize,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  });

  const stream = fs.createReadStream(resolvedPath);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (_) {}
  });
  stream.pipe(res);
}

/**
 * Updates a song's UltraStar chart file and records edited=true in meta.json (PLAN.md Phase 7.1).
 * @param {string} slug - Safe song slug identifier
 * @param {string} chartText - Complete UltraStar .txt file content
 * @returns {object} Status object
 */
function updateSongChart(slug, chartText) {
  if (!slug || typeof slug !== 'string' || !/^[a-z0-9_-]+$/i.test(slug)) {
    throw new Error('Invalid song slug format');
  }
  if (!chartText || typeof chartText !== 'string' || !chartText.trim()) {
    throw new Error('Chart text cannot be empty');
  }

  const songDir = path.resolve(SONGS_DIR, slug);
  if (!songDir.startsWith(SONGS_DIR) || !fs.existsSync(songDir)) {
    throw new Error(`Song directory not found: ${slug}`);
  }

  const chartPath = path.join(songDir, 'song.txt');
  fs.writeFileSync(chartPath, chartText.trim() + '\n', 'utf8');

  // Update meta.json with edited flag and timestamp
  const metaPath = path.join(songDir, 'meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }

  meta.edited = true;
  meta.lastEditedAt = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  return {
    success: true,
    slug,
    chartUrl: `/songs/${encodeURIComponent(slug)}/song.txt`,
    edited: true,
    lastEditedAt: meta.lastEditedAt,
  };
}

module.exports = {
  SONGS_DIR,
  listLibrarySongs,
  serveSongFile,
  updateSongChart,
};
