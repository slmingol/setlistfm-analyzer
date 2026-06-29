import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TOP_ARTISTS_PATH = join(__dir, '..', 'data', 'top_artists.json');

// Wikipedia wikitext API for RRHOF inductees page
const WIKI_API = 'https://en.wikipedia.org/w/api.php?action=parse&page=List_of_Rock_and_Roll_Hall_of_Fame_inductees&prop=wikitext&format=json&formatversion=2';
const WIKI_UA  = 'setlist-fm-analyzer/1.0 (personal; github.com/setlist-fm-analyzer)';

function norm(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Extract performer inductees from RRHOF wikitext.
// Rows look like:  | [[Name]] || ... || Performer || year  (order varies by section)
// or:              | [[Name|Display]] || Performer
function parseRRHOF(wikitext) {
  const results = [];
  // Split into table rows
  const rows = wikitext.split(/\n\|-/);
  for (const row of rows) {
    // Must contain a wikilink
    const linkMatch = row.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!linkMatch) continue;
    // Must be a Performer or Musical Excellence inductee
    if (!/Performer|Musical Excellence/i.test(row)) continue;
    // Prefer display name (after |), fall back to article name
    const name = (linkMatch[2] || linkMatch[1]).trim();
    // Extract year — look for a 4-digit year in the row
    const yearMatch = row.match(/\b(19[5-9]\d|20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    results.push({ name, year });
  }
  return results;
}

let running = false;
export function isListSyncing() { return running; }

export async function runListSync({ log = console.log } = {}) {
  if (running) { log('List sync already in progress, skipping'); return; }
  running = true;

  try {
    log('List sync: fetching RRHOF inductees from Wikipedia…');

    let wikitext;
    try {
      const res = await fetch(WIKI_API, { headers: { 'User-Agent': WIKI_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      wikitext = data?.parse?.wikitext;
      if (!wikitext) throw new Error('empty response');
    } catch (e) {
      log(`List sync: Wikipedia fetch failed — ${e.message}`);
      return;
    }

    const inductees = parseRRHOF(wikitext);
    log(`  Parsed ${inductees.length} RRHOF performer inductees`);

    // Build normalized lookup from top_artists (names + aliases)
    const topArtists = JSON.parse(readFileSync(TOP_ARTISTS_PATH, 'utf8'));
    const known = new Set();
    for (const a of topArtists) {
      known.add(norm(a.name));
      for (const alias of (a.aliases ?? [])) known.add(norm(alias));
    }

    const upsert = db.prepare(`
      INSERT OR IGNORE INTO list_suggestions (source, name, year, category, dismissed)
      VALUES ('RRHOF', ?, ?, 'Performer', 0)
    `);

    // Clear gaps that have since been added to top_artists.json
    const existing = db.prepare(`SELECT name FROM list_suggestions WHERE source = 'RRHOF'`).all();
    const del = db.prepare(`DELETE FROM list_suggestions WHERE source = 'RRHOF' AND name = ?`);
    for (const { name } of existing) {
      if (known.has(norm(name))) del.run(name);
    }

    let newGaps = 0;
    for (const { name, year } of inductees) {
      if (!known.has(norm(name))) {
        const r = upsert.run(name, year);
        if (r.changes) newGaps++;
      }
    }

    log(`List sync complete — ${newGaps} new gaps, ${inductees.length - known.size < 0 ? 0 : ''} total pending`);
  } finally {
    running = false;
  }
}
