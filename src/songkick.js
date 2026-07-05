const BASE = 'https://www.songkick.com';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function parseCookieHeader(raw) {
  if (!raw) return '';
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts.map(c => c.split(';')[0]).join('; ');
}

async function getLoginForm() {
  const res = await fetch(`${BASE}/login`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    redirect: 'follow',
  });
  const html = await res.text();
  const csrf = html.match(/name="authenticity_token"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('Could not find Songkick CSRF token on login page');
  const rawCookies = res.headers.getSetCookie?.() ?? [];
  return { csrf, cookies: parseCookieHeader(rawCookies) };
}

async function login(email, password) {
  const { csrf, cookies } = await getLoginForm();

  const body = new URLSearchParams({
    'authenticity_token': csrf,
    'username[email]':    email,
    'username[password]': password,
    'commit':             'Log in',
  });

  const res = await fetch(`${BASE}/session`, {
    method:   'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   UA,
      'Referer':      `${BASE}/login`,
      'Cookie':       cookies,
    },
    body: body.toString(),
  });

  // Successful login redirects (3xx); a 200 means login page re-rendered (bad credentials)
  if (res.status === 200) throw new Error('Songkick login failed — check SONGKICK_EMAIL / SONGKICK_PASSWORD');

  const rawCookies = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = parseCookieHeader(rawCookies);
  if (!sessionCookie) throw new Error('Songkick login: no session cookie returned');
  return sessionCookie;
}

async function scrapeTrackedPage(username, cookie, page) {
  const url = `${BASE}/users/${username}/artists/tracked?page=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Songkick artists page returned ${res.status}`);
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
 * Log in and return all tracked artists for the given Songkick username.
 * Returns an array of { name, songkickId }.
 */
export async function fetchTrackedArtists(username, email, password, { log = console.log } = {}) {
  log(`Songkick: logging in as ${email}`);
  const cookie = await login(email, password);
  log('Songkick: login successful, scraping tracked artists…');

  const all = new Map(); // songkickId → { name, songkickId }
  let page = 1;

  while (true) {
    const { artists, hasMore } = await scrapeTrackedPage(username, cookie, page);
    for (const a of artists) all.set(a.songkickId, a);
    log(`  page ${page}: ${artists.length} artists (${all.size} total)`);
    if (!hasMore) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }

  return [...all.values()];
}
