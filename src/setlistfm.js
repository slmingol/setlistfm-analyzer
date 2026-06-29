const BASE = 'https://api.setlist.fm/rest/1.0';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchAttended(username, apiKey) {
  const shows = [];
  let page = 1;
  const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };

  while (true) {
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`${BASE}/user/${username}/attended?p=${page}`, { headers });
      if (res.status === 429) { await sleep(2 ** attempt * 1000); continue; }
      break;
    }
    if (!res.ok) throw new Error(`setlist.fm ${res.status} on page ${page}`);
    const data = await res.json();
    const setlists = data.setlist ?? [];
    if (!setlists.length) break;
    shows.push(...setlists);
    if (shows.length >= Number(data.total ?? 0)) break;
    page++;
    await sleep(300);
  }
  return shows;
}
