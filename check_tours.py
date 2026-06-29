#!/usr/bin/env python3
"""
Weekly tour checker: finds upcoming Ticketmaster events for top-500 artists
not yet seen by the setlist.fm user. Outputs planning_list.md.

Requires:
  TICKETMASTER_API_KEY  - free key from https://developer.ticketmaster.com/
  SETLISTFM_API_KEY     - your setlist.fm API key
  SETLISTFM_USERNAME    - your setlist.fm username
"""

import json
import os
import re
import time
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

TM_KEY = os.environ["TICKETMASTER_API_KEY"]
SETLIST_KEY = os.environ["SETLISTFM_API_KEY"]
SETLIST_USER = os.environ["SETLISTFM_USERNAME"]
TM_BASE = "https://app.ticketmaster.com/discovery/v2"
SETLIST_BASE = "https://api.setlist.fm/rest/1.0"

SCRIPT_DIR = Path(__file__).parent
TOP_ARTISTS = SCRIPT_DIR / "top_artists.json"
CACHE_FILE = SCRIPT_DIR / "cache_attended.json"
OUTPUT_MD = SCRIPT_DIR / "planning_list.md"
OUTPUT_JSON = SCRIPT_DIR / "planning_list.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize(name: str) -> str:
    name = name.lower()
    name = unicodedata.normalize("NFD", name)
    name = "".join(c for c in name if unicodedata.category(c) != "Mn")
    name = name.replace("&", "and")
    name = re.sub(r"\s+(feat|ft|with|versus|vs)\.?\s+.*", "", name)
    name = re.sub(r"^(the|a|an)\s+", "", name)
    name = re.sub(r"[^\w\s]", "", name)
    return re.sub(r"\s+", " ", name).strip()


def fetch_attended() -> list[dict]:
    """Fetch full setlist.fm show history, page by page."""
    shows, page, per_page = [], 1, 20
    headers = {"x-api-key": SETLIST_KEY, "Accept": "application/json"}
    while True:
        for attempt in range(5):
            r = requests.get(
                f"{SETLIST_BASE}/user/{SETLIST_USER}/attended",
                params={"p": page},
                headers=headers,
                timeout=15,
            )
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            break
        data = r.json()
        setlists = data.get("setlist", [])
        if not setlists:
            break
        shows.extend(setlists)
        total = int(data.get("total", 0))
        if len(shows) >= total:
            break
        page += 1
        time.sleep(0.3)
    return shows


def load_seen_set(shows: list[dict]) -> set[str]:
    seen = set()
    for show in shows:
        artist = show.get("artist", {}).get("name", "")
        if artist:
            seen.add(normalize(artist))
    return seen


def tm_events(artist_name: str, page_size: int = 5) -> list[dict]:
    """Return upcoming Ticketmaster music events for an artist."""
    params = {
        "apikey": TM_KEY,
        "keyword": artist_name,
        "classificationName": "music",
        "sort": "date,asc",
        "size": page_size,
    }
    for attempt in range(4):
        try:
            r = requests.get(f"{TM_BASE}/events.json", params=params, timeout=10)
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            if r.status_code != 200:
                return []
            embedded = r.json().get("_embedded", {})
            return embedded.get("events", [])
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return []


def parse_event(event: dict) -> dict:
    dates = event.get("dates", {}).get("start", {})
    date_str = dates.get("localDate", "")
    venue = event.get("_embedded", {}).get("venues", [{}])[0]
    city = venue.get("city", {}).get("name", "")
    state = venue.get("state", {}).get("stateCode", "")
    venue_name = venue.get("name", "")
    location = f"{city}, {state}" if state else city
    return {
        "date": date_str,
        "venue": venue_name,
        "location": location,
        "name": event.get("name", ""),
        "url": event.get("url", ""),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("Loading top_artists.json …")
    artists = json.loads(TOP_ARTISTS.read_text())
    active = [a for a in artists if a.get("touring_status") == "active" and not a.get("deceased")]

    print("Fetching setlist.fm history …")
    if CACHE_FILE.exists():
        shows = json.loads(CACHE_FILE.read_text())
        print(f"  Loaded {len(shows)} shows from cache")
    else:
        shows = fetch_attended()
        CACHE_FILE.write_text(json.dumps(shows, indent=2))
        print(f"  Fetched {len(shows)} shows; cached")

    seen = load_seen_set(shows)
    unseen_active = [a for a in active if normalize(a["name"]) not in seen]
    unseen_active.sort(key=lambda x: x["rank"])
    print(f"Checking {len(unseen_active)} unseen active artists on Ticketmaster …")

    results = []
    for i, artist in enumerate(unseen_active, 1):
        name = artist["name"]
        print(f"  [{i:3d}/{len(unseen_active)}] {name}", end=" … ", flush=True)
        events = tm_events(name)
        parsed = [parse_event(e) for e in events]
        # Filter to future dates
        today = datetime.now(timezone.utc).date().isoformat()
        parsed = [e for e in parsed if e["date"] >= today]
        if parsed:
            print(f"{len(parsed)} upcoming")
        else:
            print("none")
        results.append({
            "rank": artist["rank"],
            "name": name,
            "genre": artist.get("genre", ["?"])[0],
            "era": artist.get("era", "?"),
            "events": parsed,
        })
        time.sleep(0.2)  # polite rate limiting

    touring = [r for r in results if r["events"]]
    no_dates = [r for r in results if not r["events"]]

    # Write JSON
    OUTPUT_JSON.write_text(json.dumps({"generated": datetime.now(timezone.utc).isoformat(),
                                       "touring": touring, "no_dates": no_dates}, indent=2))

    # Write Markdown
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Concert Planning List",
        f"",
        f"Generated: {now_str}  ",
        f"{len(touring)} of {len(unseen_active)} unseen top-500 active artists have upcoming dates.",
        f"",
        f"## Artists With Upcoming Shows",
        f"",
        f"| Rank | Artist | Genre | Next Date | Locations |",
        f"|------|--------|-------|-----------|-----------|",
    ]
    for r in touring:
        first = r["events"][0]
        locations = ", ".join(dict.fromkeys(e["location"] for e in r["events"] if e["location"]))
        lines.append(
            f"| #{r['rank']} | {r['name']} | {r['genre']} | {first['date']} | {locations} |"
        )

    lines += [
        f"",
        f"## No Upcoming Dates Found",
        f"",
        f"| Rank | Artist | Genre |",
        f"|------|--------|-------|",
    ]
    for r in no_dates:
        lines.append(f"| #{r['rank']} | {r['name']} | {r['genre']} |")

    OUTPUT_MD.write_text("\n".join(lines) + "\n")
    print(f"\nDone. {len(touring)} artists with dates → planning_list.md")


if __name__ == "__main__":
    main()
