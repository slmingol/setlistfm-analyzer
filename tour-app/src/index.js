import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import db from './db.js';
import { runSync, isSyncing } from './sync.js';

const __dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dir, '..', 'data'), { recursive: true });

const {
  SETLISTFM_API_KEY:  SETLIST_KEY  = '',
  SETLISTFM_USERNAME: SETLIST_USER = '',
  TICKETMASTER_API_KEY: TM_KEY     = '',
  PORT = '3000',
  SYNC_ON_START = 'true',
  CRON_SCHEDULE = '0 12 * * 1',  // Monday noon UTC
} = process.env;

if (!SETLIST_KEY || !SETLIST_USER || !TM_KEY) {
  console.error('Missing required env vars: SETLISTFM_API_KEY, SETLISTFM_USERNAME, TICKETMASTER_API_KEY');
  process.exit(1);
}

const app = express();
app.use(express.static(join(__dir, '..', 'public')));

// --- API routes ---

app.get('/api/status', (_req, res) => {
  const last = db.prepare(
    `SELECT * FROM sync_log WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get();
  const eventCount = db.prepare(`SELECT COUNT(*) as n FROM events`).get().n;
  const artistCount = db.prepare(`SELECT COUNT(DISTINCT artist_rank) as n FROM events`).get().n;
  res.json({ last_sync: last ?? null, event_count: eventCount, artist_count: artistCount, syncing: isSyncing() });
});

app.get('/api/artists', (_req, res) => {
  const blacklisted = new Set(
    db.prepare(`SELECT artist_rank FROM blacklist`).all().map(r => r.artist_rank)
  );

  const rows = db.prepare(`
    SELECT artist_rank AS rank, artist_name AS name,
           date, venue, city, state, country, url, first_seen
    FROM events
    WHERE date >= date('now')
    ORDER BY artist_rank ASC, date ASC
  `).all();

  const byArtist = {};
  for (const row of rows) {
    if (blacklisted.has(row.rank)) continue;
    if (!byArtist[row.rank]) byArtist[row.rank] = { rank: row.rank, name: row.name, events: [] };
    byArtist[row.rank].events.push({
      date: row.date, venue: row.venue, city: row.city,
      state: row.state, country: row.country, url: row.url, first_seen: row.first_seen,
    });
  }

  res.json(Object.values(byArtist).sort((a, b) => a.rank - b.rank));
});

// Blacklist
app.get('/api/blacklist', (_req, res) => {
  res.json(db.prepare(`SELECT artist_rank AS rank, artist_name AS name, added_at FROM blacklist ORDER BY artist_name`).all());
});

app.post('/api/blacklist', express.json(), (req, res) => {
  const { rank, name } = req.body ?? {};
  if (!rank || !name) return res.status(400).json({ error: 'rank and name required' });
  db.prepare(`INSERT OR IGNORE INTO blacklist (artist_rank, artist_name) VALUES (?, ?)`).run(rank, name);
  res.json({ ok: true });
});

app.delete('/api/blacklist/:rank', (req, res) => {
  db.prepare(`DELETE FROM blacklist WHERE artist_rank = ?`).run(Number(req.params.rank));
  res.json({ ok: true });
});

// Preferences
app.get('/api/preferences', (_req, res) => {
  const rows = db.prepare(`SELECT key, value FROM preferences`).all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put('/api/preferences', express.json(), (req, res) => {
  const prefs = req.body ?? {};
  const upsert = db.prepare(`INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(prefs)) upsert.run(key, String(value));
  res.json({ ok: true });
});

app.post('/api/sync', async (_req, res) => {
  if (isSyncing()) return res.status(409).json({ error: 'Sync already running' });
  res.json({ started: true });
  runSync({ setlistKey: SETLIST_KEY, setlistUser: SETLIST_USER, tmKey: TM_KEY });
});

// --- Scheduler ---

cron.schedule(CRON_SCHEDULE, () => {
  console.log('Cron: starting weekly sync');
  runSync({ setlistKey: SETLIST_KEY, setlistUser: SETLIST_USER, tmKey: TM_KEY });
});

app.listen(Number(PORT), () => {
  console.log(`Tour app running on http://localhost:${PORT}`);
  if (SYNC_ON_START === 'true') {
    console.log('Running initial sync…');
    runSync({ setlistKey: SETLIST_KEY, setlistUser: SETLIST_USER, tmKey: TM_KEY });
  }
});
