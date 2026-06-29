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

// Parse RRHOF performer inductees from Wikipedia wikitext.
// The Performers table uses {{sortname|First|Last}} for most entries and [[Name]] for a few.
// The Name cell immediately follows the Image cell (or a no-image comment) in each row.
// Scanning line-by-line and tracking prevWasImageOrComment is the only reliable way to
// isolate the Name cell from inducted-members and presenter cells that also contain [[links]].
function parseRRHOF(wikitext) {
  const start = wikitext.indexOf('=== Performers ===');
  if (start === -1) return [];
  const nextSection = wikitext.indexOf('\n===', start + 20);
  const section = nextSection !== -1 ? wikitext.slice(start, nextSection) : wikitext.slice(start);

  const results = [];
  const seen = new Set();
  let currentYear = null;
  let prevWasImageOrComment = false;

  for (const raw of section.split('\n')) {
    const line = raw.replace(/^\|+\s*/, '').trimStart();

    // Year cell: bare year or rowspan="N" | year
    const yearMatch = line.match(/^(?:rowspan="\d+"\s*\|\s*)?(19[5-9]\d|20\d{2})\s*(?:<|$)/);
    if (yearMatch) {
      currentYear = Number(yearMatch[1]);
      prevWasImageOrComment = false;
      continue;
    }

    // Image cell or no-image placeholder comment
    if (/^\[\[File:/i.test(line) || /^<!--/.test(line)) {
      prevWasImageOrComment = true;
      continue;
    }

    if (prevWasImageOrComment) {
      let name = null;
      const sn = line.match(/^\{\{sortname\|([^|}\n]+)\|([^|}\n]+)/);
      if (sn) {
        name = `${sn[1].trim()} ${sn[2].trim()}`;
      } else {
        const lk = line.match(/^\[\[(?!File:)([^\]|#]+)(?:\|([^\]]+))?\]\]/);
        if (lk) name = (lk[2] || lk[1]).trim();
      }
      if (name && !seen.has(name)) {
        seen.add(name);
        results.push({ name, year: currentYear });
      }
    }

    prevWasImageOrComment = false;
  }

  return results.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
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
