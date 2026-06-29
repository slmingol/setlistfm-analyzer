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
`);

export default db;
