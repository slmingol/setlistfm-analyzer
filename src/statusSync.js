import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TOP_ARTISTS_PATH = join(__dir, '..', 'top_artists.json');

let running = false;
export function isStatusSyncing() { return running; }

/**
 * Derive touring-status suggestions from the events table — no TM API calls.
 * The main sync already generates suggestions inline as it fetches events;
 * this function is a fast DB-only re-derive for the manual API endpoint.
 */
export async function runStatusSync({ log = console.log } = {}) {
  if (running) { log('Status sync already in progress, skipping'); return; }
  running = true;

  try {
    const topArtists = JSON.parse(readFileSync(TOP_ARTISTS_PATH, 'utf8'));
    const checkable = topArtists.filter(a =>
      (a.touring_status === 'active' || a.touring_status === 'hiatus') && !a.deceased
    );

    log(`Status sync: deriving suggestions from events table (no TM calls)…`);
    const today = new Date().toISOString().slice(0, 10);

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
    const countEvents = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE artist_rank = ? AND date >= ?`);

    let suggestions = 0;
    for (const a of checkable) {
      const { c } = countEvents.get(a.rank, today);
      if (a.touring_status === 'active' && c === 0) {
        upsert.run({ rank: a.rank, name: a.name, current: 'active', suggested: 'hiatus', reason: '0 upcoming events in DB' });
        suggestions++;
      } else if (a.touring_status === 'hiatus' && c > 0) {
        upsert.run({ rank: a.rank, name: a.name, current: 'hiatus', suggested: 'active', reason: `${c} upcoming event(s) in DB` });
        suggestions++;
      } else {
        clear.run(a.rank);
      }
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
