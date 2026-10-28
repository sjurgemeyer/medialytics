# MediaData

Cast & crew analytics for Plex movie and TV libraries: who appears most across your collection, how your library spreads across decades, genres and countries, how critics and audiences rate it, and a filter tool for finding titles by actor, director, writer, genre, studio, year, rating, length and watched state.

MediaData began as a fork of [Medialytics](https://github.com/Drewpeifer/medialytics) by Drew Peifer and remains under the same GPL-3.0 license.

## Running with Docker

1. Copy `.env.example` to `.env` and set:
   - `PLEX_URL`: your Plex server, e.g. `http://192.168.1.10:32400`
   - `PLEX_TOKEN`: your Plex token ([how to find it](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)). Treat it like a password.
2. Build and start:
   ```bash
   docker compose up -d --build
   ```
3. Open http://localhost:8088

`SERVER_IP` and `SERVER_TOKEN` (the Medialytics variable names) are accepted in place of `PLEX_URL` and `PLEX_TOKEN`.

The container keeps its SQLite database in `/data`; the compose file mounts `./data` there.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PLEX_URL` | (required) | Plex server URL |
| `PLEX_TOKEN` | (required) | Plex token |
| `SYNC_INTERVAL_MINUTES` | `15` | Minutes between background syncs with Plex |
| `PORT` | `3000` | Port the server listens on inside the container |
| `DATA_DIR` | `/data` | Where the database is stored |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## How data flows

The server syncs your Plex libraries into SQLite when it starts and then every `SYNC_INTERVAL_MINUTES`. Each sync reads every library's listing from Plex (one request per library) to pick up new titles, watched state and edits, then fetches full cast and crew only for titles that are new or changed, 50 at a time. Titles removed from Plex are removed from the database. `POST /api/sync?full=1` re-fetches everything.

### API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/libraries` | Libraries with item counts, plus sync status |
| GET | `/api/libraries/:id/items` | Every item in a library; people are listed once in `people` and referenced by id |
| GET | `/api/items/:id` | One item with external ids and its full credits, including character names |
| GET | `/api/people/:id` | One person and every title they're credited on |
| POST | `/api/sync` | Starts a sync in the background (`?full=1` re-fetches all credits) |
| GET | `/api/sync/status` | Progress of the current or last sync |
| GET | `/api/health` | Health check |

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run fake-plex          # a fake Plex server on :32499 with generated data (token: test-token)
PLEX_URL=http://localhost:32499 PLEX_TOKEN=test-token npm run dev
npm test                   # unit and API tests
npm run typecheck
```

- `src/server`: Fastify server, SQLite database and migrations
- `public`: the browser app (Vue 2 and Plotly from CDNs, no build step)
- `test`: Vitest tests and the fake Plex server used by them
- `docs`: design notes

## Security

MediaData has no login of its own. Run it on a trusted network, or behind a reverse proxy that adds authentication.
