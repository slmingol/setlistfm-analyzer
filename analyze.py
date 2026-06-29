#!/usr/bin/env python3
"""setlist.fm Top 500 Musical Acts Analyzer

Usage:
    python analyze.py [--refresh]

    --refresh   Ignore cached data and re-fetch from setlist.fm API

Config via .env file or environment variables:
    SETLISTFM_API_KEY=<your api key>
    SETLISTFM_USERNAME=<your setlist.fm username>
"""

import json
import os
import re
import sys
import time
import unicodedata
import argparse
from pathlib import Path
from datetime import datetime
from collections import defaultdict

try:
    import requests
except ImportError:
    sys.exit("ERROR: requests not installed. Run: pip install -r requirements.txt")


# ── Config ─────────────────────────────────────────────────────────────────────

def load_env():
    env_path = Path(".env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def get_config():
    load_env()
    api_key = os.environ.get("SETLISTFM_API_KEY")
    username = os.environ.get("SETLISTFM_USERNAME")
    if not api_key:
        api_key = input("setlist.fm API key: ").strip()
    if not username:
        username = input("setlist.fm username: ").strip()
    return api_key, username


# ── API ────────────────────────────────────────────────────────────────────────

BASE_URL = "https://api.setlist.fm/rest/1.0"
CACHE_FILE = "cache_attended.json"


def fetch_page(headers: dict, username: str, page: int, retries: int = 5) -> dict:
    """Fetch one page, retrying on 429 with exponential backoff."""
    delay = 2.0
    for attempt in range(retries):
        resp = requests.get(
            f"{BASE_URL}/user/{username}/attended",
            headers=headers,
            params={"p": page},
            timeout=15,
        )
        if resp.status_code == 404:
            sys.exit(f"ERROR: User '{username}' not found on setlist.fm")
        if resp.status_code == 401:
            sys.exit("ERROR: Invalid API key")
        if resp.status_code == 429:
            wait = delay * (2 ** attempt)
            print(f"\n  Rate limited — waiting {wait:.0f}s before retry...")
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()
    sys.exit("ERROR: Still rate limited after multiple retries. Wait a minute and try again.")


def fetch_attended(api_key: str, username: str, refresh: bool = False) -> list:
    cache_path = Path(CACHE_FILE)
    if cache_path.exists() and not refresh:
        print(f"Loading from cache ({CACHE_FILE}) — use --refresh to re-fetch")
        return json.loads(cache_path.read_text())

    headers = {"x-api-key": api_key, "Accept": "application/json"}
    setlists = []
    page = 1

    print(f"Fetching attended shows for @{username}...")
    while True:
        data = fetch_page(headers, username, page)
        page_items = data.get("setlist", [])
        setlists.extend(page_items)

        total = int(data.get("total", 0))
        per_page = int(data.get("itemsPerPage", 20))
        print(f"  {len(setlists)}/{total} shows fetched...", end="\r")

        if page * per_page >= total:
            break
        page += 1
        time.sleep(1.0)  # 1s between pages to stay within rate limits

    print(f"  {len(setlists)} shows fetched.        ")
    cache_path.write_text(json.dumps(setlists))
    print(f"Cached to {CACHE_FILE}")
    return setlists


# ── Matching ───────────────────────────────────────────────────────────────────

def normalize(name: str) -> str:
    if not name:
        return ""
    name = name.lower().strip()
    # Strip accents
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.combining(c))
    # Normalize ampersand
    name = name.replace(" & ", " and ").replace("&", " and ")
    # Remove "feat.", "featuring", "with"
    name = re.sub(r"\bfeat(?:uring)?\.?\b.*$", "", name)
    name = re.sub(r"\bwith\b.*$", "", name)
    # Drop leading article
    for prefix in ("the ", "a ", "an "):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    # Strip non-alphanumeric (keep spaces)
    name = re.sub(r"[^\w\s]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def build_lookup(top_artists: list) -> dict:
    lookup = {}
    for artist in top_artists:
        for candidate in [artist["name"]] + artist.get("aliases", []):
            key = normalize(candidate)
            if key and key not in lookup:
                lookup[key] = artist
    return lookup


def extract_artist_shows(setlists: list) -> dict:
    shows = defaultdict(list)
    for sl in setlists:
        name = sl.get("artist", {}).get("name", "")
        if not name:
            continue
        venue = sl.get("venue", {})
        city = venue.get("city", {})
        shows[name].append({
            "date": sl.get("eventDate", ""),
            "venue": venue.get("name", ""),
            "city": city.get("name", ""),
            "country": city.get("country", {}).get("name", ""),
            "url": sl.get("url", ""),
        })
    return dict(shows)


def strip_band_suffix(key: str) -> list[str]:
    """
    Return candidate shorter keys by stripping backing-band suffixes.
    Handles patterns like:
      "elvis costello and the imposters"  -> "elvis costello"
      "neil young and crazy horse"        -> "neil young"
      "hank williams and his drifting cowboys" -> "hank williams"
      "bob seger and the silver bullet band"   -> "bob seger"
    Avoids stripping "and" that's part of a two-word artist name
    (e.g. "simon and garfunkel" stays intact).
    """
    candidates = []
    # "and the ...", "& the ...", "and his ...", "and her ..."
    for marker in (" and the ", " and his ", " and her ", " with the "):
        if marker in key:
            candidates.append(key[:key.index(marker)].strip())
    # Plain "and ..." only when the prefix is already ≥2 words
    if " and " in key:
        prefix = key[:key.index(" and ")].strip()
        if len(prefix.split()) >= 2:
            candidates.append(prefix)
    return candidates


def match(artist_shows: dict, lookup: dict) -> dict:
    """Return {canonical_top_name: [show_dicts, ...]} for every matched artist."""
    matched = {}
    for seen_name, shows in artist_shows.items():
        key = normalize(seen_name)

        # 1. Exact normalized match (includes all explicit aliases)
        hit = lookup.get(key)

        # 2. Try stripping backing-band suffixes
        if hit is None:
            for candidate in strip_band_suffix(key):
                hit = lookup.get(candidate)
                if hit:
                    break

        # 3. "X with Y" / "X feat Y" — try each part independently so that
        #    e.g. "Indigo Girls with Joan Baez" can match Joan Baez
        if hit is None:
            parts = re.split(r"\bwith\b|\bfeat(?:uring)?\.?\b", seen_name, flags=re.IGNORECASE)
            if len(parts) > 1:
                for part in parts:
                    part_key = normalize(part)
                    hit = lookup.get(part_key)
                    if hit is None:
                        for candidate in strip_band_suffix(part_key):
                            hit = lookup.get(candidate)
                            if hit:
                                break
                    if hit:
                        break

        if hit:
            canonical = hit["name"]
            if canonical not in matched:
                matched[canonical] = []
            matched[canonical].extend(shows)

    return matched


# ── HTML Generation ────────────────────────────────────────────────────────────

GENRE_COLORS = {
    "Rock": "#E91E63",
    "Classic Rock": "#BA68C8",
    "Blues Rock": "#7E57C2",
    "Blues": "#3F51B5",
    "Jazz": "#29B6F6",
    "R&B/Soul": "#FF9800",
    "Funk": "#AB47BC",
    "Hip-Hop": "#FF5722",
    "Country": "#8D6E63",
    "Pop": "#00BCD4",
    "Punk": "#F44336",
    "Heavy Metal": "#546E7A",
    "Alternative": "#66BB6A",
    "Indie": "#26A69A",
    "Electronic": "#00E5FF",
    "Folk": "#A1887F",
    "Reggae": "#4CAF50",
    "Gospel": "#FFA726",
    "Glam Rock": "#EC407A",
    "Shoegaze": "#80DEEA",
    "Ska": "#FFEE58",
    "Riot Grrrl": "#EF5350",
    "Jam": "#9CCC65",
    "Other": "#9E9E9E",
}


def primary_genre(artist: dict) -> str:
    return (artist.get("genre") or ["Other"])[0]


def genre_color(g: str) -> str:
    return GENRE_COLORS.get(g, "#9E9E9E")


def js(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def pct(num, den):
    return round(num / den * 100, 1) if den else 0


def build_report(top_artists, artist_shows, matched, username):
    total = len(top_artists)
    seen_count = len(matched)
    total_shows = sum(len(v) for v in artist_shows.values())

    # Living / deceased breakdowns
    living   = [a for a in top_artists if not a.get("deceased")]
    deceased = [a for a in top_artists if a.get("deceased")]
    living_count   = len(living)
    deceased_count = len(deceased)

    living_seen   = sum(1 for a in living   if a["name"] in matched)
    deceased_seen = sum(1 for a in deceased if a["name"] in matched)
    living_unseen   = living_count   - living_seen
    deceased_unseen = deceased_count - deceased_seen

    # Touring status counts + seen breakdowns
    active_count    = sum(1 for a in top_artists if a.get("touring_status") == "active")
    hiatus_count    = sum(1 for a in top_artists if a.get("touring_status") == "hiatus")
    disbanded_count = sum(1 for a in top_artists if a.get("touring_status") == "disbanded")

    active_seen     = sum(1 for a in top_artists if a.get("touring_status") == "active"  and a["name"] in matched)
    reachable       = [a for a in top_artists if a.get("touring_status") in ("active", "hiatus")]
    reachable_count = len(reachable)
    reachable_seen  = sum(1 for a in reachable if a["name"] in matched)

    # Genre breakdown
    genre_total = defaultdict(int)
    genre_seen = defaultdict(int)
    for a in top_artists:
        g = primary_genre(a)
        genre_total[g] += 1
        if a["name"] in matched:
            genre_seen[g] += 1

    # Era breakdown
    era_total = defaultdict(int)
    era_seen = defaultdict(int)
    for a in top_artists:
        e = a.get("era", "Unknown")
        era_total[e] += 1
        if a["name"] in matched:
            era_seen[e] += 1
    eras = sorted(era_total, key=lambda x: x if x != "Unknown" else "9999")

    # Chart data
    genres = sorted(genre_total, key=lambda g: -genre_total[g])
    g_labels = genres
    g_seen = [genre_seen[g] for g in genres]
    g_unseen = [genre_total[g] - genre_seen[g] for g in genres]
    g_colors = [genre_color(g) for g in genres]

    e_labels = eras
    e_seen = [era_seen[e] for e in eras]
    e_unseen = [era_total[e] - era_seen[e] for e in eras]

    # Most-seen from top 500 (sorted by show count)
    seen_sorted_by_rank = sorted(
        [a for a in top_artists if a["name"] in matched],
        key=lambda a: a["rank"],
    )
    seen_sorted_by_count = sorted(
        [(a, len(matched[a["name"]])) for a in top_artists if a["name"] in matched],
        key=lambda x: -x[1],
    )

    deceased_count = sum(1 for a in top_artists if a.get("deceased"))

    # Build table rows
    rows = []
    for a in top_artists:
        name = a["name"]
        seen = name in matched
        deceased = a.get("deceased", False)
        show_count = len(matched.get(name, []))
        g = primary_genre(a)
        gc = genre_color(g)
        era = a.get("era", "")
        srcs = ", ".join(a.get("sources", []))

        badge = (
            f'<span class="badge badge-seen">Seen ({show_count}x)</span>'
            if seen
            else '<span class="badge badge-unseen">Not Seen</span>'
        )
        deceased_marker = ' <span class="deceased-tag" title="Deceased">†</span>' if deceased else ""
        row_class = "row-seen" if seen else "row-unseen"
        seen_flag = "1" if seen else "0"
        deceased_flag = "1" if deceased else "0"
        status_sort = f"1_{9999 - show_count:04d}" if seen else "0"
        touring = a.get("touring_status", "active")

        rows.append(
            f'<tr class="{row_class}">'
            f'<td class="rank-col">{a["rank"]}</td>'
            f'<td class="name-col"><strong>{name}</strong>{deceased_marker}</td>'
            f'<td><span class="genre-dot" style="background:{gc}"></span>{g}</td>'
            f'<td>{era}</td>'
            f'<td class="src-col">{srcs}</td>'
            f'<td data-sort="{status_sort}">{badge}</td>'
            f'<td>{seen_flag}</td>'
            f'<td>{deceased_flag}</td>'
            f'<td>{g}</td>'
            f'<td>{touring}</td>'
            f'</tr>'
        )

    table_html = "\n".join(rows)

    # Genre toggle buttons (sorted by total count descending)
    genre_toggles = []
    for g in genres:  # already sorted by -count
        gc = genre_color(g)
        cnt = genre_total[g]
        genre_toggles.append(
            f'<button class="genre-toggle" style="--gcol:{gc}" '
            f'data-genre="{g}" '
            f"onclick=\"toggleGenre(this,'{g}')\">"
            f'<span class="genre-dot" style="background:{gc}"></span>'
            f'{g} <span class="gtog-count">({cnt})</span>'
            f'</button>'
        )
    genre_toggles_html = "\n".join(genre_toggles)

    # Highest-ranked seen table rows
    seen_table_rows = []
    for a in seen_sorted_by_rank:
        name = a["name"]
        count = len(matched.get(name, []))
        g = primary_genre(a)
        gc = genre_color(g)
        deceased_marker = ' <span class="deceased-tag" title="Deceased">†</span>' if a.get("deceased") else ""
        seen_table_rows.append(
            f'<tr>'
            f'<td class="rank-col">#{a["rank"]}</td>'
            f'<td><strong>{name}</strong>{deceased_marker}</td>'
            f'<td><span class="genre-dot" style="background:{gc}"></span>{g}</td>'
            f'<td>{a.get("era","")}</td>'
            f'<td>{count}</td>'
            f'</tr>'
        )
    seen_table_html = "\n".join(seen_table_rows)

    # Top 10 most-seen
    top10_rows = "".join(
        f'<tr><td>#{a["rank"]}</td><td>{a["name"]}</td><td>{c}</td></tr>'
        for a, c in seen_sorted_by_count[:10]
    )

    now = datetime.now().strftime("%B %d, %Y")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>setlist.fm Analyzer — {username}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.datatables.net/1.13.7/css/dataTables.bootstrap5.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>
<script src="https://cdn.datatables.net/1.13.7/js/dataTables.bootstrap5.min.js"></script>
<style>
:root{{
  --bg:#0d0d1a;
  --surface:#14142b;
  --surface2:#1c1c38;
  --border:#2a2a50;
  --text:#e2e2f0;
  --muted:#7070a0;
  --accent:#7c4dff;
  --accent2:#00e5ff;
  --seen:#00c853;
  --unseen:#455a64;
}}
*{{box-sizing:border-box}}
body{{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;margin:0}}
a{{color:var(--accent2);text-decoration:none}}
a:hover{{text-decoration:underline}}

/* Hero */
.hero{{
  background:linear-gradient(135deg,#1a0040 0%,#0a0a1f 60%,#001830 100%);
  padding:1.1rem 0 1rem;
  border-bottom:1px solid var(--border);
}}
.hero h1{{font-size:1.4rem;font-weight:800;margin:0 0 .1rem}}
.hero .sub{{color:var(--muted);font-size:.82rem}}

/* Stat bar */
.stat-bar{{
  display:flex;flex-wrap:wrap;gap:.5rem;
}}
.stat-card{{
  flex:1 1 0;min-width:100px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:10px;
  padding:.6rem .85rem;
  text-align:center;
}}
.stat-value{{
  font-size:1.7rem;font-weight:800;line-height:1.1;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}}
.stat-denom{{font-size:.85rem;font-weight:400;opacity:.5}}
.stat-label{{color:var(--muted);font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;margin-top:.2rem}}
.stat-divider{{width:1px;background:var(--border);margin:.25rem 0;align-self:stretch}}
.stat-card-living{{border-color:rgba(0,200,83,.25)}}
.stat-card-deceased{{border-color:rgba(229,115,115,.25)}}

/* Cards */
.card-dark{{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:14px;
  padding:1.5rem;
}}
.card-dark h5{{
  color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;margin-bottom:1rem
}}


/* Genre dot */
.genre-dot{{
  display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0
}}

/* Badges */
.badge-seen{{background:var(--seen);color:#000;font-weight:700;font-size:.72rem;padding:.2em .5em;border-radius:4px}}
.badge-unseen{{background:var(--unseen);color:#ccc;font-size:.72rem;padding:.2em .5em;border-radius:4px}}

/* Table overrides */
table.dataTable{{color:var(--text)!important}}
table.dataTable thead th{{
  background:#0d0d22!important;color:var(--muted)!important;
  font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;
  border-bottom:1px solid var(--border)!important;
}}
table.dataTable tbody tr{{border-bottom:1px solid #1c1c30}}
table.dataTable tbody tr:hover td{{background:rgba(124,77,255,.07)!important}}
.row-seen td{{background:rgba(0,200,83,.03)!important}}
.dataTables_wrapper .dataTables_filter input,
.dataTables_wrapper .dataTables_length select{{
  background:var(--surface2);border:1px solid var(--border);
  color:var(--text);border-radius:6px;padding:.25rem .5rem
}}
.dataTables_wrapper .dataTables_info,
.dataTables_wrapper .dataTables_paginate{{color:var(--muted)}}
.page-link{{background:var(--surface2)!important;border-color:var(--border)!important;color:var(--text)!important}}
.page-item.active .page-link{{background:var(--accent)!important;border-color:var(--accent)!important}}
.rank-col{{width:60px;color:var(--muted);font-size:.85rem}}
.src-col{{font-size:.75rem;color:var(--muted)}}

/* Filter buttons */
.filter-bar{{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem}}
.fbtn{{
  padding:.28rem .8rem;border-radius:20px;font-size:.78rem;
  border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;
  transition:all .15s;
}}
.fbtn.active,.fbtn:hover{{background:var(--accent);border-color:var(--accent);color:#fff}}
.fbtn-active.active,.fbtn-active:hover{{background:#1b5e20;border-color:#1b5e20;color:#fff}}
.fbtn-hiatus.active,.fbtn-hiatus:hover{{background:#4a3800;border-color:#f9a825;color:#f9a825}}
.fbtn-disbanded.active,.fbtn-disbanded:hover{{background:#1a237e;border-color:#5c6bc0;color:#aab;}}
.fbtn-deceased{{border-color:#5a4040}}
.fbtn-deceased.active,.fbtn-deceased:hover{{background:#7a2020;border-color:#7a2020}}
.fbtn-divider{{width:1px;background:var(--border);margin:0 .25rem;align-self:stretch}}
.deceased-tag{{color:#e57373;font-size:.85em;margin-left:.2rem;cursor:default}}

/* Genre toggle bar */
.genre-filter-bar{{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;
  padding:.55rem .7rem;margin-bottom:.75rem;
  background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;}}
.genre-filter-label{{font-size:.72rem;font-weight:600;letter-spacing:.05em;
  text-transform:uppercase;color:var(--muted);margin-right:.25rem;white-space:nowrap}}
.genre-toggle{{
  display:inline-flex;align-items:center;gap:.3rem;
  padding:.28rem .8rem;border-radius:20px;font-size:.78rem;cursor:pointer;
  border:1px solid color-mix(in srgb,var(--gcol) 55%,transparent);
  background:color-mix(in srgb,var(--gcol) 18%,transparent);
  color:var(--gcol);
  transition:all .15s;
}}
.genre-toggle:hover{{background:color-mix(in srgb,var(--gcol) 30%,transparent);}}
.genre-toggle.excluded{{
  opacity:.3;text-decoration:line-through;
  background:transparent;
  border-color:var(--border);
  color:var(--muted);
}}
.gtog-count{{font-size:.72em;opacity:.7}}
.genre-reset{{margin-left:.35rem;border-style:dashed}}

/* Dial row */
.dial-row{{display:flex;justify-content:space-around;align-items:flex-start;flex-wrap:wrap;gap:1.5rem;padding:1rem 0}}
.dial-wrap{{text-align:center}}
.dial-label{{font-size:.72rem;color:var(--muted);margin-top:.4rem;line-height:1.3}}
.dial-label-lg{{font-size:.82rem;margin-top:.6rem}}
.dial-sub{{font-size:.68rem;opacity:.7}}
.dial-center{{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  font-size:.78rem;font-weight:600;color:var(--text);pointer-events:none;white-space:nowrap;
}}
.dial-center-lg{{font-size:1.05rem}}

/* Top-10 mini table */
.mini-table td,
.mini-table th{{padding:.4rem .6rem;font-size:.82rem;border-color:var(--border)!important;color:var(--text)}}
.mini-table tr:hover td{{background:rgba(124,77,255,.07)}}

section{{padding:2rem 0}}
section>h2{{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-bottom:1rem}}

footer{{padding:1.5rem 0;color:var(--muted);font-size:.78rem;border-top:1px solid var(--border)}}
</style>
</head>
<body>

<div class="hero">
  <div class="container">
    <h1>setlist.fm Analyzer</h1>
    <p class="sub">Top 500 Musical Acts &nbsp;·&nbsp; <strong>@{username}</strong> &nbsp;·&nbsp; {now}</p>
  </div>
</div>

<div class="container py-3">

  <!-- Stats -->
  <section>
    <div class="stat-bar">
      <div class="stat-card">
        <div class="stat-value">{seen_count}</div>
        <div class="stat-label">Top 500 Seen</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{pct(seen_count, total)}%</div>
        <div class="stat-label">Coverage</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{len(artist_shows)}</div>
        <div class="stat-label">Unique Artists</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{total_shows}</div>
        <div class="stat-label">Shows Attended</div>
      </div>
      <div class="stat-divider"></div>
      <div class="stat-card stat-card-living">
        <div class="stat-value">{living_seen}<span class="stat-denom">/{living_count}</span></div>
        <div class="stat-label">Living Seen · {pct(living_seen, living_count)}%</div>
      </div>
      <div class="stat-card stat-card-living">
        <div class="stat-value">{living_unseen}<span class="stat-denom">/{living_count}</span></div>
        <div class="stat-label">Living Not Seen · {pct(living_unseen, living_count)}%</div>
      </div>
      <div class="stat-card stat-card-deceased">
        <div class="stat-value">{deceased_seen}<span class="stat-denom">/{deceased_count}</span></div>
        <div class="stat-label">Deceased Seen · {pct(deceased_seen, deceased_count)}%</div>
      </div>
      <div class="stat-card stat-card-deceased">
        <div class="stat-value">{deceased_unseen}<span class="stat-denom">/{deceased_count}</span></div>
        <div class="stat-label">Deceased Not Seen · {pct(deceased_unseen, deceased_count)}%</div>
      </div>
    </div>
  </section>

  <!-- Coverage dials -->
  <section>
    <h2>Coverage by Status</h2>
    <div class="card-dark">
      <div class="dial-row">
        <div class="dial-wrap">
          <div style="position:relative;width:140px;height:140px;margin:auto">
            <canvas id="dialAll"></canvas>
            <div class="dial-center dial-center-lg">{pct(seen_count,total)}%</div>
          </div>
          <div class="dial-label dial-label-lg">All 500<br><span class="dial-sub">{seen_count} of {total}</span></div>
        </div>
        <div class="dial-wrap">
          <div style="position:relative;width:140px;height:140px;margin:auto">
            <canvas id="dialLiving"></canvas>
            <div class="dial-center dial-center-lg">{pct(living_seen,living_count)}%</div>
          </div>
          <div class="dial-label dial-label-lg">Living<br><span class="dial-sub">{living_seen} of {living_count}</span></div>
        </div>
        <div class="dial-wrap">
          <div style="position:relative;width:140px;height:140px;margin:auto">
            <canvas id="dialReachable"></canvas>
            <div class="dial-center dial-center-lg">{pct(reachable_seen,reachable_count)}%</div>
          </div>
          <div class="dial-label dial-label-lg">Touring + Off-Tour<br><span class="dial-sub">{reachable_seen} of {reachable_count}</span></div>
        </div>
        <div class="dial-wrap">
          <div style="position:relative;width:140px;height:140px;margin:auto">
            <canvas id="dialActive"></canvas>
            <div class="dial-center dial-center-lg">{pct(active_seen,active_count)}%</div>
          </div>
          <div class="dial-label dial-label-lg">Touring Only<br><span class="dial-sub">{active_seen} of {active_count}</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- Genre / Era charts -->
  <section>
    <h2>Breakdown</h2>
    <div class="row g-3">
      <div class="col-md-5">
        <div class="card-dark h-100">
          <h5>By Genre</h5>
          <canvas id="genreChart" style="max-height:420px"></canvas>
        </div>
      </div>
      <div class="col-md-7">
        <div class="card-dark h-100">
          <h5>By Era</h5>
          <canvas id="eraChart" style="max-height:420px"></canvas>
        </div>
      </div>
    </div>
  </section>

  <!-- Seen artists -->
  <section>
    <h2>Artists You've Seen</h2>
    <div class="row g-3">
      <div class="col-md-3">
        <div class="card-dark h-100">
          <h5>Most Seen (from Top 500)</h5>
          <table class="table table-dark table-sm table-hover mini-table mb-0">
            <thead><tr><th>Rank</th><th>Artist</th><th>Shows</th></tr></thead>
            <tbody>{top10_rows}</tbody>
          </table>
        </div>
      </div>
      <div class="col-md-9">
        <div class="card-dark">
          <table id="seenTable" class="table table-dark table-sm table-hover mini-table mb-0" style="width:100%">
            <thead><tr><th>Rank</th><th>Artist</th><th>Genre</th><th>Era</th><th>Shows</th></tr></thead>
            <tbody>{seen_table_html}</tbody>
          </table>
        </div>
      </div>
    </div>
  </section>

  <!-- Full table -->
  <section>
    <h2>All 500 Artists</h2>
    <div class="filter-bar">
      <button class="fbtn active" data-group="seen" data-filter="all" onclick="applySeenFilter(this,'all')">All ({total})</button>
      <button class="fbtn" data-group="seen" data-filter="seen" onclick="applySeenFilter(this,'seen')">Seen ({seen_count})</button>
      <button class="fbtn" data-group="seen" data-filter="unseen" onclick="applySeenFilter(this,'unseen')">Not Seen ({total - seen_count})</button>
      <span class="fbtn-divider"></span>
      <button class="fbtn" data-group="status" data-filter="all" onclick="applyStatusFilter(this,'all')">Any Status</button>
      <button class="fbtn" data-group="status" data-filter="living" onclick="applyStatusFilter(this,'living')">Living ({total - deceased_count})</button>
      <button class="fbtn fbtn-active" data-group="status" data-filter="active" onclick="applyStatusFilter(this,'active')">Touring ({active_count})</button>
      <button class="fbtn fbtn-hiatus" data-group="status" data-filter="hiatus" onclick="applyStatusFilter(this,'hiatus')">Off-Tour ({hiatus_count})</button>
      <button class="fbtn fbtn-disbanded" data-group="status" data-filter="disbanded" onclick="applyStatusFilter(this,'disbanded')">Disbanded ({disbanded_count})</button>
      <button class="fbtn fbtn-deceased" data-group="status" data-filter="deceased" onclick="applyStatusFilter(this,'deceased')">Deceased ({deceased_count})</button>
    </div>
    <div class="genre-filter-bar">
      <span class="genre-filter-label">Genres</span>
      {genre_toggles_html}
      <button class="fbtn genre-reset" onclick="clearGenres()">Clear All</button>
      <button class="fbtn genre-reset" onclick="resetGenres()">Reset All</button>
    </div>
    <div class="card-dark">
      <table id="artistTable" class="table table-dark table-sm" style="width:100%">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Artist</th>
            <th>Genre</th>
            <th>Era</th>
            <th>Sources</th>
            <th>Status</th>
            <th>_seen</th>
            <th>_deceased</th>
            <th>_genre</th>
            <th>_touring</th>
          </tr>
        </thead>
        <tbody>
          {table_html}
        </tbody>
      </table>
    </div>
  </section>

</div>

<footer>
  <div class="container">
    Data from <a href="https://www.setlist.fm/">setlist.fm</a> &nbsp;·&nbsp;
    Rankings aggregated from Rolling Stone, Rock &amp; Roll Hall of Fame, VH1, Grammy Lifetime Achievement Award, and Billboard historical charts.
  </div>
</footer>

<script>
Chart.defaults.color = '#7070a0';
Chart.defaults.borderColor = '#2a2a50';

// Coverage dials
function makeDial(id, seen, total, color) {{
  new Chart(document.getElementById(id), {{
    type: 'doughnut',
    data: {{
      labels: ['Seen', 'Not Seen'],
      datasets: [{{ data: [seen, total - seen], backgroundColor: [color, '#2a2a50'], borderWidth: 0 }}]
    }},
    options: {{
      cutout: '72%',
      plugins: {{
        legend: {{ display: false }},
        tooltip: {{
          callbacks: {{
            label: ctx => `${{ctx.label}}: ${{ctx.raw}} (${{(ctx.raw/total*100).toFixed(1)}}%)`
          }}
        }}
      }}
    }}
  }});
}}
makeDial('dialAll',       {seen_count},      {total},            '#00c853');
makeDial('dialLiving',    {living_seen},     {living_count},     '#42a5f5');
makeDial('dialReachable', {reachable_seen},  {reachable_count},  '#ff9800');
makeDial('dialActive',    {active_seen},     {active_count},     '#ab47bc');

// Genre bar
new Chart(document.getElementById('genreChart'), {{
  type: 'bar',
  data: {{
    labels: {js(g_labels)},
    datasets: [
      {{ label: 'Seen',     data: {js(g_seen)},   backgroundColor: {js(g_colors)}.map(c => c + 'cc'), borderRadius: 3 }},
      {{ label: 'Not Seen', data: {js(g_unseen)}, backgroundColor: '#2a2a50', borderRadius: 3 }}
    ]
  }},
  options: {{
    indexAxis: 'y',
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ stacked: true, grid: {{ color: '#1c1c30' }} }},
      y: {{ stacked: true, grid: {{ display: false }}, ticks: {{ font: {{ size: 10 }} }} }}
    }}
  }}
}});

// Era bar
new Chart(document.getElementById('eraChart'), {{
  type: 'bar',
  data: {{
    labels: {js(e_labels)},
    datasets: [
      {{ label: 'Seen',     data: {js(e_seen)},   backgroundColor: '#7c4dffcc', borderRadius: 3 }},
      {{ label: 'Not Seen', data: {js(e_unseen)}, backgroundColor: '#2a2a50',   borderRadius: 3 }}
    ]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ stacked: true, grid: {{ display: false }} }},
      y: {{ stacked: true, grid: {{ color: '#1c1c30' }} }}
    }}
  }}
}});

// Columns: 0=Rank 1=Artist 2=Genre 3=Era 4=Sources 5=Status 6=_seen 7=_deceased 8=_genre 9=_touring
let _seenFilter   = 'all';
let _statusFilter = 'all';
const excludedGenres = new Set();

$.fn.dataTable.ext.search.push(function(settings, data) {{
  if (_seenFilter === 'seen'        && data[6] !== '1') return false;
  if (_seenFilter === 'unseen'      && data[6] !== '0') return false;
  if (_statusFilter === 'living'    && data[7] !== '0') return false;
  if (_statusFilter === 'deceased'  && data[7] !== '1') return false;
  if (_statusFilter === 'active'    && data[9] !== 'active')    return false;
  if (_statusFilter === 'hiatus'    && data[9] !== 'hiatus')    return false;
  if (_statusFilter === 'disbanded' && data[9] !== 'disbanded') return false;
  if (excludedGenres.size && excludedGenres.has(data[8])) return false;
  return true;
}});

const dt = $('#artistTable').DataTable({{
  pageLength: 25,
  lengthMenu: [10, 25, 50, 100, 200],
  order: [[0, 'asc']],
  language: {{ search: '', searchPlaceholder: 'Search artists...' }},
  columnDefs: [{{ visible: false, targets: [6, 7, 8, 9] }}],
}});

$('#seenTable').DataTable({{
  pageLength: 25,
  lengthMenu: [10, 25, 50, 100, 200],
  order: [[0, 'asc']],
  language: {{ search: '', searchPlaceholder: 'Search...' }},
  columnDefs: [{{ targets: [0], render: function(d) {{ return parseInt(d.replace('#','')) }} }}],
}});

function applySeenFilter(btn, filter) {{
  _seenFilter = filter;
  document.querySelectorAll('.fbtn[data-group="seen"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  dt.draw();
}}

function applyStatusFilter(btn, filter) {{
  _statusFilter = filter;
  document.querySelectorAll('.fbtn[data-group="status"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  dt.draw();
}}

function toggleGenre(btn, genre) {{
  if (excludedGenres.has(genre)) {{
    excludedGenres.delete(genre);
    btn.classList.remove('excluded');
  }} else {{
    excludedGenres.add(genre);
    btn.classList.add('excluded');
  }}
  dt.draw();
}}

function clearGenres() {{
  document.querySelectorAll('.genre-toggle').forEach(b => {{
    excludedGenres.add(b.dataset.genre);
    b.classList.add('excluded');
  }});
  dt.draw();
}}

function resetGenres() {{
  excludedGenres.clear();
  document.querySelectorAll('.genre-toggle').forEach(b => b.classList.remove('excluded'));
  dt.draw();
}}

document.addEventListener('keydown', function(e) {{
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowRight') {{ dt.page('next').draw('page'); }}
  if (e.key === 'ArrowLeft')  {{ dt.page('previous').draw('page'); }}
}});
</script>
</body>
</html>"""


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="setlist.fm Top 500 Analyzer")
    parser.add_argument("--refresh", action="store_true", help="Re-fetch from API (ignore cache)")
    args = parser.parse_args()

    api_key, username = get_config()

    artists_path = Path(__file__).parent / "top_artists.json"
    if not artists_path.exists():
        sys.exit(f"ERROR: {artists_path} not found")

    top_artists = json.loads(artists_path.read_text())
    print(f"Loaded {len(top_artists)} top artists")

    setlists = fetch_attended(api_key, username, refresh=args.refresh)
    artist_shows = extract_artist_shows(setlists)
    print(f"Seen {len(artist_shows)} unique artists across {sum(len(v) for v in artist_shows.values())} shows")

    lookup = build_lookup(top_artists)
    matched = match(artist_shows, lookup)
    print(f"Matched {len(matched)} of {len(top_artists)} top artists")

    html = build_report(top_artists, artist_shows, matched, username)

    out = Path("report.html")
    out.write_text(html, encoding="utf-8")
    print(f"\nReport saved: {out.absolute()}")
    print("Open with:   open report.html")


if __name__ == "__main__":
    main()
