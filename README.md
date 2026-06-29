# setlist.fm Analyzer

Compares your setlist.fm concert history against a curated list of the top 500 musical acts of all time and generates a self-contained HTML report showing your coverage.

## Features

- Coverage dials broken down by All 500 / Living / Touring+Off-Tour / Touring Only
- Sortable, filterable table of all 500 artists with seen/unseen status
- Filter by seen status, artist status (touring, off-tour, disbanded, deceased), and genre
- Genre and era breakdown charts
- Artists You've Seen table with show counts
- Keyboard arrow-key pagination
- All output is a single self-contained `report.html` -- no server needed

## Requirements

- Python 3.8+
- A [setlist.fm API key](https://www.setlist.fm/settings/api) (free)

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```
SETLISTFM_API_KEY=your_api_key_here
SETLISTFM_USERNAME=your_setlistfm_username
```

## Usage

```bash
python3 analyze.py
```

Opens / generates `report.html` in the current directory.

On first run the script fetches your full show history from the setlist.fm API and caches it to `cache_attended.json`. Subsequent runs read from the cache.

```bash
python3 analyze.py --refresh   # re-fetch from API, ignoring cache
```

Use `--refresh` after adding new shows to setlist.fm or if your history looks stale.

## Data files

| File | Description |
|------|-------------|
| `top_artists.json` | The 501-artist reference list with genre, era, deceased status, touring status, and name aliases |
| `cache_attended.json` | Cached API response of your attended shows |
| `report.html` | Generated report (overwritten on each run) |

## Artist matching

The script normalizes artist names and attempts a three-pass match against your show history:

1. Exact normalized name match
2. Strip common band suffixes (`and the X`, `with the X`, etc.)
3. Split `X with Y` / `X feat Y` and try each part independently

Aliases in `top_artists.json` cover common variations (e.g. `Elvis Costello & The Imposters` resolves to `Elvis Costello`, `Jefferson Starship` resolves to `Jefferson Airplane`).

## Tour Planner app

`tour-app/` is a self-hosted Node.js web app that checks [Ticketmaster](https://developer.ticketmaster.com/) weekly for upcoming shows from top-500 artists you haven't seen yet.

```bash
cd tour-app
cp .env.example .env   # fill in all three API keys
docker compose up -d
# open http://localhost:3000
```

Requires a free [Ticketmaster Discovery API key](https://developer.ticketmaster.com/) in addition to the setlist.fm credentials.

- Syncs automatically every Monday at noon UTC (configurable via `CRON_SCHEDULE`)
- "Refresh Now" button in the UI triggers an immediate sync
- Newly found dates are badged **NEW** for 72 hours
- SQLite database persists between restarts via a Docker volume

## Touring status values

| Status | Meaning |
|--------|---------|
| `active` | Currently touring |
| `hiatus` | Living but not actively touring (health, retirement, hiatus) |
| `disbanded` | Group officially dissolved |
| `deceased` | Essential member(s) died and the act is no longer performing |
