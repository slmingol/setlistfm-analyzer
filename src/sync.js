import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { normalize, isTribute } from './matcher.js';
import { fetchAttended } from './setlistfm.js';
import { fetchEvents, parseEvent, isMusicEvent, resolveAttractionId } from './tm.js';

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
    const version = process.env.APP_VERSION ?? 'dev';
    const bar = '━'.repeat(52);
    log(bar);
    log(`  setlist.fm Analyzer  v${version}`);
    log(`  User: ${setlistUser}  ·  ${new Date().toISOString()}`);
    log(bar);

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

    // 3. Query Ticketmaster for all active artists (seen + unseen)
    log(`  ${active.length} active artists to check (${seenRanks.size} already seen)`);

    const today = new Date().toISOString().slice(0, 10);
    // Upsert: update mutable fields on conflict but preserve first_seen.
    const insertEvent = db.prepare(`
      INSERT INTO events
        (artist_rank, artist_name, tm_id, event_name, date, venue, city, state, country, url)
      VALUES
        (@artist_rank, @artist_name, @tm_id, @event_name, @date, @venue, @city, @state, @country, @url)
      ON CONFLICT(tm_id) DO UPDATE SET
        event_name = excluded.event_name,
        date       = excluded.date,
        venue      = excluded.venue,
        city       = excluded.city,
        state      = excluded.state,
        country    = excluded.country,
        url        = excluded.url
    `);

    let eventsFound = 0, newEvents = 0;

    const getTmId  = db.prepare(`SELECT tm_id FROM tm_attraction_ids WHERE artist_rank = ?`);
    const saveTmId = db.prepare(
      `INSERT OR REPLACE INTO tm_attraction_ids (artist_rank, tm_id, resolved_at) VALUES (?, ?, datetime('now'))`
    );

    const CONCURRENCY = 5;
    let cursor = 0, done = 0;

    const worker = async () => {
      while (cursor < active.length) {
        const idx    = cursor++;
        const artist = active[idx];

        // Resolve TM attraction ID on first encounter; cached for subsequent syncs.
        // Using attractionId instead of keyword prevents false-positive matches
        // (e.g. "No Cure" or a small tribute act named "The Cure" matching the real band).
        const cached = getTmId.get(artist.rank);
        let tmId = cached?.tm_id ?? null;
        if (!tmId) {
          tmId = await resolveAttractionId(artist.name, tmKey);
          if (tmId) saveTmId.run(artist.rank, tmId);
          await new Promise(r => setTimeout(r, 100));
        }

        const rawEvents = await fetchEvents(artist.name, tmKey, { attractionId: tmId });
        const upcoming  = rawEvents
          .filter(e => {
            if (!isMusicEvent(e)) return false;
            if (isTribute(e.name ?? '')) return false;
            const attractions = e?._embedded?.attractions ?? [];
            if (attractions.some(a => isTribute(a.name ?? ''))) return false;
            // If TM provided attractions, at least one must resolve to this artist.
            // Guards against keyword false-positives (e.g. "No Cure" matching "The Cure").
            if (attractions.length > 0) {
              const hit = attractions.some(a => aliasToRank.get(normalize(a.name ?? '')) === artist.rank);
              if (!hit) return false;
            }
            return true;
          })
          .map(parseEvent)
          .filter(e => e.date >= today);

        eventsFound += upcoming.length;
        for (const ev of upcoming) {
          const result = insertEvent.run({ artist_rank: artist.rank, artist_name: artist.name, ...ev });
          if (result.changes) newEvents++;
        }

        // Remove stale future events: anything TM no longer returns for this artist.
        // This purges false-positives stored by previous syncs (e.g. a namesake act).
        const tmIds = upcoming.map(e => e.tm_id).filter(Boolean);
        if (tmIds.length > 0) {
          const ph = tmIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM events WHERE artist_rank = ? AND date >= ? AND tm_id NOT IN (${ph})`)
            .run(artist.rank, today, ...tmIds);
        } else {
          db.prepare(`DELETE FROM events WHERE artist_rank = ? AND date >= ?`).run(artist.rank, today);
        }
        db.prepare(`DELETE FROM events WHERE artist_rank = ? AND date < ?`).run(artist.rank, today);

        done++;
        if (done % 10 === 0) log(`  [${done}/${active.length}]`);
        await new Promise(r => setTimeout(r, 100));
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Purge any tribute events across the whole table (one pass, not per-artist).
    db.prepare(`DELETE FROM events WHERE
      event_name LIKE '%tribute%' OR event_name LIKE '%celebrating%' OR
      event_name LIKE '%the music of%' OR event_name LIKE '%cover band%' OR
      event_name LIKE '%salute to%' OR event_name LIKE '% story' OR
      event_name LIKE '% story %' OR event_name LIKE '% experience' OR
      event_name LIKE '% experience %' OR event_name LIKE '%story songs%' OR
      event_name LIKE '%songs of the%' OR event_name LIKE '%symphon%' OR
      event_name LIKE '%philharmon%' OR event_name LIKE '%book tour%'
    `).run();

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
    `).run(active.length, eventsFound, newEvents, syncId);

    log(`Sync complete — ${eventsFound} upcoming events (${newEvents} new), ${seenRanks.size}/${topArtists.length} top-500 seen`);
  } finally {
    running = false;
  }
}
