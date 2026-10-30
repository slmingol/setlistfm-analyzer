import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { normalize } from './matcher.js';
import { fetchTrackedArtists } from './songkick.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TOP_ARTISTS_PATH = join(__dir, '..', 'top_artists.json');

const SONGKICK_BASE_RANK = 10000;

// Non-music acts or duplicates to skip
const SKIP_NORMS = new Set([
  'jerry seinfeld', 'john oliver', 'ricky gervais', 'seth meyers',
  'mico', 'day6', 'eaj', 'indigo girl',
].map(s => normalize(s)));

let running = false;
export function isSongkickSyncing() { return running; }

function buildExistingNameSet() {
  const topArtists = JSON.parse(readFileSync(TOP_ARTISTS_PATH, 'utf8'));
  const norms = new Set();
  for (const a of topArtists) {
    norms.add(normalize(a.name));
    for (const alias of (a.aliases ?? [])) norms.add(normalize(alias));
  }
  // Also include already-stored Songkick artists
  for (const row of db.prepare(`SELECT name FROM songkick_artists`).all()) {
    norms.add(normalize(row.name));
  }
  return norms;
}

export async function runSongkickSync({
  username,
  sessionCookie,
  log = console.log,
} = {}) {
  if (running) { log('Songkick sync already in progress, skipping'); return; }
  running = true;

  try {
    const tracked = await fetchTrackedArtists(username, sessionCookie, { log });
    log(`Songkick: ${tracked.length} tracked artists fetched`);

    const existing = buildExistingNameSet();

    // Filter out existing/skipped, then deduplicate within the scraped batch by normalized name
    const seenNorms = new Set();
    const newArtists = tracked.filter(a => {
      const n = normalize(a.name);
      if (existing.has(n) || SKIP_NORMS.has(n) || seenNorms.has(n)) return false;
      seenNorms.add(n);
      return true;
    });
    log(`Songkick: ${newArtists.length} new artists not yet in tracked list`);

    if (!newArtists.length) { log('Songkick: nothing to add'); return; }

    const maxRankRow = db.prepare(`SELECT MAX(rank) AS r FROM songkick_artists`).get();
    let nextRank = Math.max(maxRankRow?.r ?? SONGKICK_BASE_RANK - 1, SONGKICK_BASE_RANK - 1) + 1;

    const insert = db.prepare(
      `INSERT OR IGNORE INTO songkick_artists (rank, name, songkick_id) VALUES (?, ?, ?)`
    );
    for (const a of newArtists) {
      insert.run(nextRank++, a.name, a.songkickId);
      log(`  + ${a.name}`);
    }

    log(`Songkick sync complete — ${newArtists.length} artists added`);
  } finally {
    running = false;
  }
}
