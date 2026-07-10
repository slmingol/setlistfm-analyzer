# setlist.fm Analyzer

A self-hosted web app that tracks your concert coverage against a curated list of the top 670+ musical acts of all time, and surfaces upcoming shows from artists you haven't seen yet.

## Features

**Tour Planner tab**
- Queries Ticketmaster weekly for upcoming shows from all active and hiatus artists
- Toggle between unseen-only and all active artists (including ones you've seen)
- Tribute and cover acts automatically filtered from results
- Location filter (enter state/country codes to show only nearby shows)
- Expand "+N more" to see full tour schedules per artist
- Hide artists you have no interest in seeing (persisted in DB)
- Newly found dates badged **NEW** for 72 hours
- Filter, sort, and location state persists across page loads

**Coverage tab**
- Coverage dials: All / Living / Touring+Off-Tour / Touring Only — click any dial to filter the artist table
- Genre and era breakdown charts
- Filterable table of all artists with seen/unseen status, genre, era, and source
- Filter by seen status, touring status, and genre
- Refresh Data button triggers a full sync from the Coverage tab
- All filter selections persist across page loads

**Touring status suggestions**
- Every sync the app checks all active and hiatus artists against Ticketmaster and flags conflicts: an "active" artist with no upcoming shows, or a "hiatus" artist who suddenly has dates
- Suggestions appear in the Settings drawer with an accept/dismiss button
- Accepting a suggestion updates `top_artists.json` directly on disk — no manual editing required

**Songkick integration**
- Weekly scrape of your Songkick followed-artists list via session cookie auth
- New artists not already in the reference list are added automatically to the tracking DB
- Trigger manually via `POST /api/songkick-sync`

**Missing inductee suggestions**
- On the 1st of each month the app fetches the RRHOF performer inductee list from Wikipedia and flags anyone not in `top_artists.json`
- Surfaces in the Settings drawer so you can review and add them manually or dismiss

## Requirements

- Docker (or Docker Compose)
- A free [setlist.fm API key](https://www.setlist.fm/settings/api)
- A free [Ticketmaster Discovery API key](https://developer.ticketmaster.com/) (Consumer Key; free tier is 5,000 calls/day)

## Setup

### Local dev (builds image from source)

```bash
cp .env.example .env   # fill in your API keys
docker compose up -d
# open http://localhost:3234
```

### Production (pull pre-built image from GHCR)

Copy these files to the server:

```
docker-compose.prod.yml
.env
```

```bash
docker compose -f docker-compose.prod.yml up -d
# open http://localhost:3234
```

The `top_artists.json` reference list is baked into the image — no separate file copy needed. On first start the app syncs immediately (fetches your setlist.fm history and queries Ticketmaster). Subsequent syncs run every Monday at noon UTC.

## Data

| File | Description |
|------|-------------|
| `top_artists.json` | 670+ artist reference list with genre, era, deceased/touring status, and name aliases (baked into the Docker image) |
| `data/tours.db` | SQLite database (created at runtime, persisted via Docker volume) |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SETLISTFM_API_KEY` | required | setlist.fm API key |
| `SETLISTFM_USERNAME` | required | setlist.fm username |
| `TICKETMASTER_API_KEY` | required | Ticketmaster Discovery API Consumer Key |
| `PORT` | `3000` | Internal container port |
| `SYNC_ON_START` | `false` | Run a sync on startup (skipped automatically if last sync finished < 12h ago) |
| `CRON_SCHEDULE` | `0 12 * * 1` | When to run the weekly TM sync (default: Monday noon UTC) |
| `LIST_SYNC_SCHEDULE` | `0 10 1 * *` | When to check RRHOF inductee gaps (1st of each month) |
| `SONGKICK_USERNAME` | `slmingol` | Songkick username to scrape followed artists from |
| `SONGKICK_COOKIE` | _(unset)_ | Raw cookie header string from a logged-in Songkick session (`_skweb_session=...; auth_http_s=...`). Songkick sync is disabled when unset. |
| `SONGKICK_SYNC_SCHEDULE` | `0 8 * * 0` | When to scrape Songkick (default: Sunday 8am UTC) |

### Ticketmaster quota

The free Ticketmaster API tier allows 5,000 calls/day. The app protects against exhaustion in three ways:

- **Staleness cache** — artists whose events were fetched within the last 72 hours are skipped on subsequent syncs, making post-deploy restarts and manual triggers nearly free
- **Early abort** — on a 429 quota response the sync stops immediately instead of burning remaining calls
- **Startup skip** — if a sync completed within the last 12 hours the startup sync is skipped entirely

With ~370 active artists and a warm attraction-ID cache, a full weekly sync uses roughly 370 API calls.

## Artist matching

Show history is matched against `top_artists.json` via a three-pass algorithm:

1. Exact normalized name match (including all aliases)
2. Strip common band suffixes (`and the X`, `with the X`, etc.)
3. Split `X with Y` co-bills and credit each artist independently

Aliases cover common variations (e.g. `Pat Benatar & Neil Giraldo` → `Pat Benatar`, `Jefferson Starship` → `Jefferson Airplane`).

Tribute and cover acts are excluded from matching. Shows are skipped if the artist name, MusicBrainz disambiguation field, or tour name contains tribute markers (`tribute`, `cover band`, `celebrating`, `the music of`, `salute to`). The same filter applies to Ticketmaster results.

## Touring status values

`top_artists.json` tags each artist with one of four statuses. This determines whether they show up in the Tour Planner and how the Coverage dials are counted. Both `active` and `hiatus` artists are queried against Ticketmaster each sync — `hiatus` artists are included so the app can detect when they start touring again.

| Status | Meaning |
|--------|---------|
| `active` | Currently touring |
| `hiatus` | Living but not actively touring (health, retirement, or indefinite hiatus) |
| `disbanded` | Group officially dissolved |
| `deceased` | Essential member(s) died and the act no longer performs |

These values were set manually when the list was built and need occasional updates as things change. The app handles this automatically — see "Touring status suggestions" above.
