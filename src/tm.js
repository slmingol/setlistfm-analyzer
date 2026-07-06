import { normalize } from './matcher.js';

const BASE = 'https://app.ticketmaster.com/discovery/v2';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Resolve the canonical TM attraction ID for an artist name.
 * Searches /attractions.json and picks the exact-name match with the most
 * upcoming events — this reliably selects the real artist over a small
 * namesake act (e.g. The Cure the band vs "The Cure" the club DJ).
 */
// Sentinel returned when the TM API key has hit its daily quota.
export const TM_QUOTA_EXCEEDED = Symbol('TM_QUOTA_EXCEEDED');

export async function resolveAttractionId(artistName, apiKey) {
  const params = new URLSearchParams({
    apikey: apiKey,
    keyword: artistName,
    classificationName: 'music',
    size: '5',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${BASE}/attractions.json?${params}`, { signal: ac.signal });
    clearTimeout(timer);
    if (res.status === 429) return TM_QUOTA_EXCEEDED;
    if (!res.ok) return null;
    const data = await res.json();
    const attractions = data?._embedded?.attractions ?? [];
    // Use full-name match WITHOUT stripping "The" — normalize() drops "The" which
    // causes "The Cure" to match any entity named "Cure" (including venues).
    const looseLower = s => s.toLowerCase().normalize('NFD')
      .replace(/\p{Mn}/gu, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const norm = looseLower(artistName);
    const matches = attractions.filter(a => looseLower(a.name ?? '') === norm);
    if (!matches.length) return null;
    // Prefer attractions that have canonical metadata (Wikipedia or MusicBrainz).
    // A real artist almost always has these; a small namesake act typically does not.
    const withLinks = matches.filter(a =>
      a.externalLinks?.wikipedia?.length || a.externalLinks?.musicbrainz?.length
    );
    const candidates = withLinks.length ? withLinks : matches;
    candidates.sort((a, b) => (b.upcomingEvents?._total ?? 0) - (a.upcomingEvents?._total ?? 0));
    return candidates[0].id;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') console.warn(`TM attraction timeout for "${artistName}"`);
    return null;
  }
}

export async function fetchEvents(artistName, apiKey, { pageSize = 20, attractionId = null } = {}) {
  const startDateTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    apikey: apiKey,
    classificationName: 'music',
    sort: 'date,asc',
    size: String(pageSize),
    startDateTime,
  });
  if (attractionId) {
    params.set('attractionId', attractionId);
  } else {
    params.set('keyword', artistName);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetch(`${BASE}/events.json?${params}`, { signal: ac.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        if (attempt === 0) {
          // First 429 might be a short burst limit — back off and retry once.
          await sleep(2000);
          continue;
        }
        return TM_QUOTA_EXCEEDED;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`TM API ${res.status} for "${artistName}": ${body.slice(0, 200)}`);
        return null;  // null = error, [] = definitive empty
      }
      const data = await res.json();
      return data?._embedded?.events ?? [];
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        console.warn(`TM timeout for "${artistName}"`);
        return null;
      }
      console.error(`TM fetch error for "${artistName}": ${err.message}`);
      await sleep(2 ** attempt * 1000);
    }
  }
  return null;
}

export function isMusicEvent(raw) {
  const classifications = raw?.classifications ?? [];
  if (!classifications.length) return true;
  return classifications.some(c => c?.segment?.name?.toLowerCase() === 'music');
}

export function parseEvent(raw) {
  const start  = raw?.dates?.start ?? {};
  const venue  = raw?._embedded?.venues?.[0] ?? {};
  const city   = venue?.city?.name ?? '';
  const state  = venue?.state?.stateCode ?? '';
  const country = venue?.country?.countryCode ?? '';
  return {
    tm_id:      raw.id,
    event_name: raw.name ?? '',
    date:       start.localDate ?? '',
    venue:      venue.name ?? '',
    city,
    state,
    country,
    url:        raw.url ?? '',
  };
}
