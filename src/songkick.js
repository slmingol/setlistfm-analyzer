const BASE = 'https://www.songkick.com';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function scrapeTrackedPage(username, sessionCookie, page) {
  const cookie = `_skweb_session=${sessionCookie}`;
  // Try candidate URL patterns — Songkick has changed their URL structure
  const candidates = [
    `${BASE}/users/${username}/artists/tracked?page=${page}`,
    `${BASE}/users/${username}/tracking?page=${page}`,
    `${BASE}/users/${username}/gigography?page=${page}`,
  ];
  let res, url;
  for (const u of candidates) {
    res = await fetch(u, {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/html' },
      redirect: 'follow',
    });
    console.log(`  ${u} → ${res.status}`);
    if (res.ok) { url = u; break; }
  }
  if (!res.ok) throw new Error(`Songkick artists page returned ${res.status} on all candidate URLs`);
  const html = await res.text();

  // Extract artist entries: href="/artists/12345-artist-name">Artist Name</a>
  const artists = [];
  const re = /href="\/artists\/(\d+)-[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, id, name] = m;
    // Skip pagination / nav links (very short or numeric-only names)
    if (name.length < 2 || /^\d+$/.test(name)) continue;
    artists.push({ name: name.trim(), songkickId: id });
  }

  // Detect "no more pages": either no artists found, or a "no results" indicator
  const hasMore = artists.length > 0 && !html.includes('class="empty-list-message"');
  return { artists, hasMore };
}

/**
 * Scrape all tracked artists for a Songkick username using a session cookie.
 *
 * The session cookie value comes from the _songkick_session cookie in your
 * browser after logging into songkick.com. Set SONGKICK_COOKIE in env vars.
 *
 * Returns an array of { name, songkickId }.
 */
export async function fetchTrackedArtists(username, sessionCookie, { log = console.log } = {}) {
  if (!sessionCookie) throw new Error('SONGKICK_COOKIE is required — see docs for how to obtain it');
  log(`Songkick: scraping tracked artists for ${username}…`);

  const all = new Map(); // songkickId → { name, songkickId }
  let page = 1;

  while (true) {
    const { artists, hasMore } = await scrapeTrackedPage(username, sessionCookie, page);
    for (const a of artists) all.set(a.songkickId, a);
    log(`  page ${page}: ${artists.length} artists (${all.size} total)`);
    if (!hasMore) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }

  return [...all.values()];
}
