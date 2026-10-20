/**
 * scripts/fetch_corpus_lyrics.js - Fetches lyrics for corpus songs and saves lyrics.json
 * (PLAN.md Phase 2 Task 7 & Evaluation)
 */

const fs = require('fs');
const path = require('path');
const { fetchLyrics } = require('../lib/lyrics');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(PROJECT_ROOT, 'eval', 'corpus');

function parseUltraStarHeader(truthPath) {
  const content = fs.readFileSync(truthPath, 'utf8');
  let title = '';
  let artist = '';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#TITLE:')) title = trimmed.slice(7).trim();
    if (trimmed.startsWith('#ARTIST:')) artist = trimmed.slice(8).trim();
  }
  return { title, artist };
}

async function main() {
  const songDirs = fs
    .readdirSync(CORPUS_DIR)
    .filter((d) => fs.existsSync(path.join(CORPUS_DIR, d, 'truth.txt')));

  console.log(`====================================================`);
  console.log(`🎤 Fetching lyrics for ${songDirs.length} corpus songs`);
  console.log(`====================================================\n`);

  let fetchedCount = 0;

  for (const slug of songDirs) {
    const truthPath = path.join(CORPUS_DIR, slug, 'truth.txt');
    const outPath = path.join(CORPUS_DIR, slug, 'lyrics.json');
    const { title, artist } = parseUltraStarHeader(truthPath);

    process.stdout.write(`▶ ${slug} ("${artist}" - "${title}")... `);

    try {
      const doc = await fetchLyrics({ title, artist, durationSec: 0 });
      if (doc) {
        fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
        console.log(`✓ Got [${doc.source}] (${doc.syncType}, ${doc.lines.length} lines)`);
        fetchedCount++;
      } else {
        console.log(`✗ No lyrics found`);
      }
    } catch (err) {
      console.log(`✗ Error: ${err.message}`);
    }

    // Short pause between queries to respect provider rate limits
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n====================================================`);
  console.log(`Done! Successfully fetched lyrics for ${fetchedCount}/${songDirs.length} songs.`);
  console.log(`====================================================`);
}

main().catch(console.error);
