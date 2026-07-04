const BASE = 'https://app.ticketmaster.com/discovery/v2';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchEvents(artistName, apiKey, pageSize = 20) {
  const startDateTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    apikey: apiKey,
    keyword: artistName,
    classificationName: 'music',
    sort: 'date,asc',
    size: String(pageSize),
    startDateTime,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetch(`${BASE}/events.json?${params}`, { signal: ac.signal });
      clearTimeout(timer);
      if (res.status === 429) { await sleep(2 ** attempt * 1000); continue; }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`TM API ${res.status} for "${artistName}": ${body.slice(0, 200)}`);
        return [];
      }
      const data = await res.json();
      return data?._embedded?.events ?? [];
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        console.warn(`TM timeout for "${artistName}"`);
        return [];
      }
      console.error(`TM fetch error for "${artistName}": ${err.message}`);
      await sleep(2 ** attempt * 1000);
    }
  }
  return [];
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
