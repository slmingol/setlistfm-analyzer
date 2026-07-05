const BASE = 'https://www.songkick.com';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function scrapeTrackedPage(username, sessionCookie, page) {
  // sessionCookie can be either a raw cookie header string (preferred)
  // or just the _skweb_session value for backwards compat
  const cookie = sessionCookie.includes('=') ? sessionCookie : `_skweb_session=${sessionCookie}`;
  const url = `${BASE}/tracker/artists?page=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Songkick artists page returned ${res.status}`);
  const html = await res.text();

  // DEBUG: dump a slice around the first artist link to calibrate the regex
  if (page === 1) {
    const artistIdx = html.search(/\/artists\//);
    if (artistIdx >= 0) {
      console.log('DEBUG artist link context:', html.slice(Math.max(0, artistIdx - 100), artistIdx + 300));
    } else {
      console.log('DEBUG: no /artists/ links found. Page snippet:', html.slice(0, 1000));
    }
  }

  // Structure: <a href="/artists/ID-slug"><img ...>Artist Name\n</a>
  const artists = [];
  const re = /href="\/artists\/(\d+)-[^"]*"[^>]*>\s*<img[^>]*>\s*([^\n<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, id, name] = m;
    if (name.trim().length < 2) continue;
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
