const BASE = 'https://api.data.jambase.com/v3';

export async function resolveArtistId(artistName, apiKey) {
  const params = new URLSearchParams({ name: artistName });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${BASE}/artists?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const artists = data?.artists ?? [];
    const norm = s => s.toLowerCase().trim();
    const match = artists.find(a => norm(a.name ?? '') === norm(artistName));
    return match?.identifier ?? null; // e.g. "jambase:228924"
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') console.warn(`JamBase artist timeout for "${artistName}"`);
    return null;
  }
}

export async function fetchEvents(artistName, apiKey, { tmAttractionId = null, jambaseId = null } = {}) {
  // JamBase accepts cross-source IDs — reuse cached TM attraction IDs directly.
  const artistId = tmAttractionId ? `ticketmaster:${tmAttractionId}` : jambaseId;
  if (!artistId) return null;

  const params = new URLSearchParams({
    artistId,
    eventDatePreset: 'future',
    perPage: '100',
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${BASE}/events?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`JamBase API ${res.status} for "${artistName}": ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const events = data?.events ?? [];
    return events.filter(e => e.eventStatus !== 'cancelled' && e.eventStatus !== 'postponed');
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') console.warn(`JamBase timeout for "${artistName}"`);
    return null;
  }
}

export function parseEvent(raw) {
  const loc = raw.location ?? {};
  const addr = loc.address ?? {};
  const offers = raw.offers ?? [];
  const ticketUrl = offers.find(o => o.url)?.url ?? raw.url ?? '';
  return {
    tm_id:      raw.identifier ?? '',   // "jambase:16013248" — stored in tm_id column
    event_name: raw.name ?? '',
    date:       (raw.startDate ?? '').slice(0, 10),
    venue:      loc.name ?? '',
    city:       addr.addressLocality ?? '',
    state:      addr.addressRegion ?? '',
    country:    addr.addressCountry ?? '',
    url:        ticketUrl,
  };
}
