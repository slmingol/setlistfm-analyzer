# setlist.fm Analyzer

A self-hosted web app that tracks your concert coverage against a curated list of the top 500 musical acts of all time, and surfaces upcoming shows from artists you haven't seen yet.

## Features

**Coverage tab**
- Coverage dials: All 500 / Living / Touring+Off-Tour / Touring Only
- Genre and era breakdown charts
- Filterable table of all 500 artists with seen/unseen status, genre, era, and source
- Filter by seen status, touring status, and genre
- Artists You've Seen table with show counts
- All filter selections persist across page loads

**Tour Planner tab**
- Queries Ticketmaster weekly for upcoming shows from unseen top-500 active artists
- Location filter (enter state/country codes to show only nearby shows)
- Hide artists you have no interest in seeing (persisted in DB)
- Newly found dates badged **NEW** for 72 hours
- Filter and sort state persists across page loads

## Requirements

- Docker (or Docker Compose)
- A free [setlist.fm API key](https://www.setlist.fm/settings/api)
- A free [Ticketmaster Discovery API key](https://developer.ticketmaster.com/) (Consumer Key)

## Setup

```bash
cd tour-app
cp .env.example .env
```

Edit `.env`:

```
SETLISTFM_API_KEY=your_setlistfm_api_key
SETLISTFM_USERNAME=your_setlistfm_username
TICKETMASTER_API_KEY=your_ticketmaster_consumer_key
```

Then start the app:

```bash
docker compose up -d
# open http://localhost:3234
```

On first start, the app syncs immediately (fetches your setlist.fm history and queries Ticketmaster). Subsequent syncs run every Monday at noon UTC.

## Data

| File | Description |
|------|-------------|
| `top_artists.json` | 501-artist reference list with genre, era, deceased/touring status, and name aliases |
| `tour-app/data/tours.db` | SQLite database (created at runtime, persisted via Docker volume) |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SETLISTFM_API_KEY` | required | setlist.fm API key |
| `SETLISTFM_USERNAME` | required | setlist.fm username |
| `TICKETMASTER_API_KEY` | required | Ticketmaster Discovery API Consumer Key |
| `PORT` | `3000` | Internal container port |
| `SYNC_ON_START` | `true` | Run a sync immediately on startup |
| `CRON_SCHEDULE` | `0 12 * * 1` | When to sync (Monday noon UTC) |

## Artist matching

Show history is matched against `top_artists.json` via a three-pass algorithm:

1. Exact normalized name match (including all aliases)
2. Strip common band suffixes (`and the X`, `with the X`, etc.)
3. Split `X with Y` co-bills and credit each artist independently

Aliases cover common variations (e.g. `Pat Benatar & Neil Giraldo` → `Pat Benatar`, `Jefferson Starship` → `Jefferson Airplane`).

## Touring status values

| Status | Meaning |
|--------|---------|
| `active` | Currently touring |
| `hiatus` | Living but not actively touring (health, retirement, or indefinite hiatus) |
| `disbanded` | Group officially dissolved |
| `deceased` | Essential member(s) died and the act no longer performs |
