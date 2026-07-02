import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { normalize, isTribute } from './matcher.js';
import { fetchAttended } from './setlistfm.js';
import { fetchEvents, parseEvent } from './tm.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TOP_ARTISTS_PATH = join(__dir, '..', 'data', 'top_artists.json');

let running = false;

export function isSyncing() { return running; }

const primaryGenre = a => (Array.isArray(a.genre) ? a.genre[0] : a.genre) ?? 'Other';

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
    log(`  ${shows.length} shows fetched`);

    // Build seenRanks and per-artist show counts from raw show data.
    // Splits "X with Y" names so both artists get credit.
    const seenRanks  = new Set();
    const seenCounts = new Map(); // rank → show count

    for (const show of shows) {
      const raw = show?.artist?.name;
      if (!raw) continue;

      // Skip tribute/cover acts. Check both the artist name and the MusicBrainz
      // disambiguation field (setlist.fm populates it with "tribute band" etc.).
      const disambiguation = show?.artist?.disambiguation ?? '';
      const tourName = show?.tour?.name ?? '';
      if (isTribute(raw) || isTribute(disambiguation) || isTribute(tourName)) continue;

      const ranksThisShow = new Set();

      const r = aliasToRank.get(normalize(raw));
      if (r) ranksThisShow.add(r);

      const parts = raw.split(/\s+with\s+/i);
      if (parts.length > 1) {
        for (const part of parts) {
          const pr = aliasToRank.get(normalize(part));
          if (pr) ranksThisShow.add(pr);
        }
      }

      for (const rank of ranksThisShow) {
        seenRanks.add(rank);
        seenCounts.set(rank, (seenCounts.get(rank) ?? 0) + 1);
      }
    }

    const uniqueArtists = new Set(shows.map(s => s?.artist?.name).filter(Boolean)).size;
    log(`  ${seenRanks.size} top-500 artists seen, ${uniqueArtists} unique artists total`);

    // 3. Filter to unseen active artists
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
      const upcoming  = rawEvents
        .filter(e => {
          if (isTribute(e.name ?? '')) return false;
          const attractions = e?._embedded?.attractions ?? [];
          if (attractions.some(a => isTribute(a.name ?? ''))) return false;
          return true;
        })
        .map(parseEvent)
        .filter(e => e.date >= today);

      eventsFound += upcoming.length;

      for (const ev of upcoming) {
        const result = insertEvent.run({ artist_rank: artist.rank, artist_name: artist.name, ...ev });
        if (result.changes) newEvents++;
      }

      db.prepare(`DELETE FROM events WHERE artist_rank = ? AND date < ?`).run(artist.rank, today);
      await new Promise(r => setTimeout(r, 200));
    }

    db.prepare(`DELETE FROM events WHERE date < ?`).run(today);

    // 5. Compute and cache coverage stats for the analyzer view
    const living   = topArtists.filter(a => !a.deceased);
    const deceased = topArtists.filter(a => a.deceased);
    const reachable = topArtists.filter(a => ['active', 'hiatus'].includes(a.touring_status));

    const genreMap = {}, eraMap = {};
    for (const a of topArtists) {
      const g = primaryGenre(a), e = a.era ?? 'Unknown';
      if (!genreMap[g]) genreMap[g] = { genre: g, total: 0, seen: 0 };
      if (!eraMap[e])   eraMap[e]   = { era:   e, total: 0, seen: 0 };
      genreMap[g].total++;
      eraMap[e].total++;
      if (seenRanks.has(a.rank)) { genreMap[g].seen++; eraMap[e].seen++; }
    }

    const artistsList = topArtists.map(a => ({
      rank:           a.rank,
      name:           a.name,
      genre:          primaryGenre(a),
      era:            a.era ?? '',
      sources:        (a.sources ?? []).join(', '),
      touring_status: a.touring_status ?? 'active',
      deceased:       a.deceased ?? false,
      seen:           seenRanks.has(a.rank),
      shows_count:    seenCounts.get(a.rank) ?? 0,
    }));

    const coverageData = {
      updated_at: new Date().toISOString(),
      stats: {
        total:           topArtists.length,
        seen_count:      seenRanks.size,
        total_shows:     shows.length,
        unique_artists:  uniqueArtists,
        living_count:    living.length,
        living_seen:     living.filter(a => seenRanks.has(a.rank)).length,
        deceased_count:  deceased.length,
        deceased_seen:   deceased.filter(a => seenRanks.has(a.rank)).length,
        active_count:    active.length,
        active_seen:     active.filter(a => seenRanks.has(a.rank)).length,
        hiatus_count:    topArtists.filter(a => a.touring_status === 'hiatus').length,
        disbanded_count: topArtists.filter(a => a.touring_status === 'disbanded').length,
        reachable_count: reachable.length,
        reachable_seen:  reachable.filter(a => seenRanks.has(a.rank)).length,
      },
      by_genre: Object.values(genreMap).sort((a, b) => b.total - a.total),
      by_era:   Object.values(eraMap).sort((a, b) => {
        if (a.era === 'Unknown') return 1;
        if (b.era === 'Unknown') return -1;
        return a.era.localeCompare(b.era);
      }),
      artists: artistsList,
      top10:   [...artistsList]
        .filter(a => a.seen)
        .sort((a, b) => b.shows_count - a.shows_count)
        .slice(0, 10),
    };

    db.prepare(
      `INSERT OR REPLACE INTO coverage_cache (key, value, updated_at) VALUES ('data', ?, datetime('now'))`
    ).run(JSON.stringify(coverageData));

    db.prepare(`
      UPDATE sync_log SET finished_at = datetime('now'),
        artists_checked = ?, events_found = ?, new_events = ?
      WHERE id = ?
    `).run(unseen.length, eventsFound, newEvents, syncId);

    log(`Sync complete — ${eventsFound} upcoming events (${newEvents} new), ${seenRanks.size}/${topArtists.length} top-500 seen`);
  } finally {
    running = false;
  }
}
