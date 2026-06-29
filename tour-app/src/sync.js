import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { normalize, buildSeenSet } from './matcher.js';
import { fetchAttended } from './setlistfm.js';
import { fetchEvents, parseEvent } from './tm.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TOP_ARTISTS_PATH = join(__dir, '..', 'data', 'top_artists.json');

let running = false;

export function isSyncing() { return running; }

export async function runSync({ setlistKey, setlistUser, tmKey, log = console.log } = {}) {
  if (running) { log('Sync already in progress, skipping'); return; }
  running = true;

  const syncRow = db.prepare(
    `INSERT INTO sync_log (started_at) VALUES (datetime('now'))`
  ).run();
  const syncId = syncRow.lastInsertRowid;

  try {
    // 1. Load top artists + build alias lookup (normalized alias → rank)
    const topArtists = JSON.parse(readFileSync(TOP_ARTISTS_PATH, 'utf8'));
    const active = topArtists.filter(a => a.touring_status === 'active' && !a.deceased);

    const aliasToRank = new Map();
    for (const a of topArtists) {
      aliasToRank.set(normalize(a.name), a.rank);
      for (const alias of (a.aliases ?? [])) aliasToRank.set(normalize(alias), a.rank);
    }

    // 2. Fetch setlist.fm history
    log('Fetching setlist.fm history…');
    const shows = await fetchAttended(setlistUser, setlistKey);
    const seen  = buildSeenSet(shows);
    log(`  ${shows.length} shows, ${seen.size} unique artists seen`);

    // Resolve seen artist names → ranks via alias lookup.
    // Also split "X with Y" names so both artists get credit.
    const seenRanks = new Set();
    const rawNames = shows.map(s => s?.artist?.name).filter(Boolean);
    for (const raw of rawNames) {
      const parts = raw.split(/\s+with\s+/i);
      for (const part of parts) {
        const rank = aliasToRank.get(normalize(part));
        if (rank) seenRanks.add(rank);
      }
    }
    for (const normName of seen) {
      const rank = aliasToRank.get(normName);
      if (rank) seenRanks.add(rank);
    }

    // 3. Filter to unseen active artists (by rank, so aliases match)
    const unseen = active.filter(a => !seenRanks.has(a.rank));
    log(`  ${unseen.length} unseen active artists to check`);

    // 4. Query Ticketmaster for each
    const today = new Date().toISOString().slice(0, 10);
    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events
        (artist_rank, artist_name, tm_id, event_name, date, venue, city, state, country, url)
      VALUES
        (@artist_rank, @artist_name, @tm_id, @event_name, @date, @venue, @city, @state, @country, @url)
    `);

    let eventsFound = 0, newEvents = 0;

    for (let i = 0; i < unseen.length; i++) {
      const artist = unseen[i];
      if ((i + 1) % 20 === 0) log(`  [${i + 1}/${unseen.length}]`);

      const rawEvents = await fetchEvents(artist.name, tmKey);
      if (i <= 3) log(`  debug [${artist.name}]: ${rawEvents.length} raw events from TM`);
      const upcoming  = rawEvents
        .map(parseEvent)
        .filter(e => e.date >= today);

      eventsFound += upcoming.length;

      for (const ev of upcoming) {
        const result = insertEvent.run({ artist_rank: artist.rank, artist_name: artist.name, ...ev });
        if (result.changes) newEvents++;
      }

      // Prune stale events (past dates) for this artist
      db.prepare(`DELETE FROM events WHERE artist_rank = ? AND date < ?`)
        .run(artist.rank, today);

      await new Promise(r => setTimeout(r, 200));
    }

    // Also prune any globally stale events
    db.prepare(`DELETE FROM events WHERE date < ?`).run(today);

    db.prepare(`
      UPDATE sync_log SET finished_at = datetime('now'),
        artists_checked = ?, events_found = ?, new_events = ?
      WHERE id = ?
    `).run(unseen.length, eventsFound, newEvents, syncId);

    log(`Sync complete — ${eventsFound} upcoming events, ${newEvents} new`);
  } finally {
    running = false;
  }
}
