import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { fetchEvents, parseEvent } from './tm.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TOP_ARTISTS_PATH = join(__dir, '..', 'data', 'top_artists.json');

let running = false;
export function isStatusSyncing() { return running; }

export async function runStatusSync({ tmKey, log = console.log } = {}) {
  if (running) { log('Status sync already in progress, skipping'); return; }
  running = true;

  try {
    const topArtists = JSON.parse(readFileSync(TOP_ARTISTS_PATH, 'utf8'));
    const checkable = topArtists.filter(a =>
      (a.touring_status === 'active' || a.touring_status === 'hiatus') && !a.deceased
    );

    log(`Status sync: checking ${checkable.length} artists via Ticketmaster…`);
    const today = new Date().toISOString().slice(0, 10);

    // Increment consecutive_hits when same suggestion persists; reset when signal flips
    const upsert = db.prepare(`
      INSERT INTO status_suggestions
        (artist_rank, artist_name, current_status, suggested_status, reason, consecutive_hits, detected_at, dismissed)
      VALUES
        (@rank, @name, @current, @suggested, @reason, 1, datetime('now'), 0)
      ON CONFLICT(artist_rank) DO UPDATE SET
        current_status   = excluded.current_status,
        suggested_status = excluded.suggested_status,
        reason           = excluded.reason,
        consecutive_hits = CASE
          WHEN suggested_status = excluded.suggested_status THEN consecutive_hits + 1
          ELSE 1
        END,
        detected_at = CASE
          WHEN suggested_status = excluded.suggested_status THEN detected_at
          ELSE datetime('now')
        END,
        dismissed = 0
    `);

    const clear = db.prepare(`DELETE FROM status_suggestions WHERE artist_rank = ?`);

    let suggestions = 0;

    for (let i = 0; i < checkable.length; i++) {
      const a = checkable[i];
      if ((i + 1) % 20 === 0) log(`  [${i + 1}/${checkable.length}]`);

      const rawEvents = await fetchEvents(a.name, tmKey);
      const upcoming = rawEvents.map(parseEvent).filter(e => e.date >= today);
      const count = upcoming.length;

      if (a.touring_status === 'active' && count === 0) {
        upsert.run({
          rank: a.rank, name: a.name, current: 'active', suggested: 'hiatus',
          reason: '0 upcoming Ticketmaster events',
        });
        suggestions++;
      } else if (a.touring_status === 'hiatus' && count > 0) {
        upsert.run({
          rank: a.rank, name: a.name, current: 'hiatus', suggested: 'active',
          reason: `${count} upcoming Ticketmaster event${count > 1 ? 's' : ''} found`,
        });
        suggestions++;
      } else {
        clear.run(a.rank);
      }

      await new Promise(r => setTimeout(r, 200));
    }

    log(`Status sync complete — ${suggestions} suggestions generated`);
  } finally {
    running = false;
  }
}

export function applyStatusChange(rank, newStatus) {
  const topArtists = JSON.parse(readFileSync(TOP_ARTISTS_PATH, 'utf8'));
  const artist = topArtists.find(a => a.rank === rank);
  if (!artist) throw new Error(`Artist with rank ${rank} not found`);
  const oldStatus = artist.touring_status;
  artist.touring_status = newStatus;
  writeFileSync(TOP_ARTISTS_PATH, JSON.stringify(topArtists, null, 2) + '\n', 'utf8');
  return { name: artist.name, oldStatus, newStatus };
}
