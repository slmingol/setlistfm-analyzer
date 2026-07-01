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

**Touring status suggestions**
- Every Monday the app checks all active/hiatus artists against Ticketmaster and flags conflicts: an "active" artist with no upcoming shows, or a "hiatus" artist who suddenly has dates
- Suggestions appear in the Settings drawer with an accept/dismiss button
- Accepting a suggestion updates `top_artists.json` directly on disk -- no manual editing required

**Missing inductee suggestions**
- On the 1st of each month the app fetches the RRHOF performer inductee list from Wikipedia and flags anyone not in `top_artists.json`
- Surfaces in the Settings drawer so you can review and add them manually or dismiss

## Requirements

- Docker (or Docker Compose)
- A free [setlist.fm API key](https://www.setlist.fm/settings/api)
- A free [Ticketmaster Discovery API key](https://developer.ticketmaster.com/) (Consumer Key)

## Setup

### Local dev (builds image from source)

```bash
cp .env.example .env   # fill in your API keys
docker compose up -d
# open http://localhost:3234
```

### Production (pull pre-built image from GHCR)

Copy these files to the server and create the `data/` directory:

```
docker-compose.prod.yml
data/top_artists.json
.env
```

```bash
mkdir -p data
cp top_artists.json data/
docker compose -f docker-compose.prod.yml up -d
# open http://localhost:3234
```

On first start the app syncs immediately (fetches your setlist.fm history and queries Ticketmaster). Subsequent syncs run every Monday at noon UTC.

## Data

| File | Description |
|------|-------------|
| `top_artists.json` | 501-artist reference list with genre, era, deceased/touring status, and name aliases |
| `data/tours.db` | SQLite database (created at runtime, persisted via Docker volume) |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SETLISTFM_API_KEY` | required | setlist.fm API key |
| `SETLISTFM_USERNAME` | required | setlist.fm username |
| `TICKETMASTER_API_KEY` | required | Ticketmaster Discovery API Consumer Key |
| `PORT` | `3000` | Internal container port |
| `SYNC_ON_START` | `true` | Run a sync immediately on startup |
| `CRON_SCHEDULE` | `0 12 * * 1` | When to sync (Monday noon UTC) |
| `STATUS_SYNC_SCHEDULE` | `0 14 * * 1` | When to run the touring status check (Monday 2pm UTC) |
| `LIST_SYNC_SCHEDULE` | `0 10 1 * *` | When to check RRHOF inductee gaps (1st of each month) |

## Artist matching

Show history is matched against `top_artists.json` via a three-pass algorithm:

1. Exact normalized name match (including all aliases)
2. Strip common band suffixes (`and the X`, `with the X`, etc.)
3. Split `X with Y` co-bills and credit each artist independently

Aliases cover common variations (e.g. `Pat Benatar & Neil Giraldo` → `Pat Benatar`, `Jefferson Starship` → `Jefferson Airplane`).

## Touring status values

`top_artists.json` tags each artist with one of four statuses. This determines whether they show up in the Tour Planner (only `active` artists are queried against Ticketmaster) and how the Coverage dials are counted.

| Status | Meaning |
|--------|---------|
| `active` | Currently touring |
| `hiatus` | Living but not actively touring (health, retirement, or indefinite hiatus) |
| `disbanded` | Group officially dissolved |
| `deceased` | Essential member(s) died and the act no longer performs |

These values were set manually when the list was built and need occasional updates as things change. The app handles this automatically -- see "Touring status suggestions" above.
