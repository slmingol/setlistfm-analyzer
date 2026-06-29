const BASE = 'https://app.ticketmaster.com/discovery/v2';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchEvents(artistName, apiKey, pageSize = 10) {
  const params = new URLSearchParams({
    apikey: apiKey,
    keyword: artistName,
    classificationName: 'music',
    sort: 'date,asc',
    size: String(pageSize),
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/events.json?${params}`);
      if (res.status === 429) { await sleep(2 ** attempt * 1000); continue; }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`TM API ${res.status} for "${artistName}": ${body.slice(0, 200)}`);
        return [];
      }
      const data = await res.json();
      return data?._embedded?.events ?? [];
    } catch (err) {
      console.error(`TM fetch error for "${artistName}": ${err.message}`);
      await sleep(2 ** attempt * 1000);
    }
  }
  return [];
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
