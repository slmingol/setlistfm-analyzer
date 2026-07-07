import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dir, '..', 'data', 'tours.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_rank INTEGER NOT NULL,
    artist_name TEXT NOT NULL,
    tm_id       TEXT UNIQUE,
    event_name  TEXT,
    date        TEXT,
    venue       TEXT,
    city        TEXT,
    state       TEXT,
    country     TEXT,
    url         TEXT,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at     TEXT,
    artists_checked INTEGER,
    events_found    INTEGER,
    new_events      INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_events_artist ON events(artist_rank);
  CREATE INDEX IF NOT EXISTS idx_events_date   ON events(date);

  CREATE TABLE IF NOT EXISTS blacklist (
    artist_rank INTEGER PRIMARY KEY,
    artist_name TEXT NOT NULL,
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS preferences (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coverage_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS status_suggestions (
    artist_rank      INTEGER PRIMARY KEY,
    artist_name      TEXT NOT NULL,
    current_status   TEXT NOT NULL,
    suggested_status TEXT NOT NULL,
    reason           TEXT NOT NULL,
    consecutive_hits INTEGER NOT NULL DEFAULT 1,
    detected_at      TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS list_suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    name        TEXT NOT NULL,
    year        INTEGER,
    category    TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source, name)
  );

  CREATE TABLE IF NOT EXISTS tm_attraction_ids (
    artist_rank   INTEGER PRIMARY KEY,
    tm_id         TEXT NOT NULL,
    resolved_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS songkick_artists (
    rank        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    songkick_id TEXT,
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events_sync_cache (
    artist_rank INTEGER PRIMARY KEY,
    synced_at   TEXT NOT NULL
  );
`);

export default db;
