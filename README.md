# Photo Atlas API

Backend for **Photo Atlas**, a free and open source app that aggregates and organizes images and
videos by **time** and **space** using their metadata.

The API indexes media files coming from local folders and from **Infomaniak kDrive**, stores the
index in **PostgreSQL + PostGIS** (compatible with a Supabase free plan), and serves the data used
by the Flutter client for the planet map, the timeline and the full gallery.

## Features

- Media index: name, path, size, MIME type, capture date, geographic location, dimensions
- Time aggregation: day / week / month buckets (2 months by day, 3 months by week, older by month)
- Space aggregation: zoom-aware clusters that merge when zooming out and split when zooming in
- Full gallery including items with **no metadata** or partial metadata
- Local folder indexing and kDrive indexing (recursive folder scan)
- kDrive token is encrypted at rest (AES-256-GCM), never exposed to clients
- Supabase-compatible SQL migrations: run locally first, push to the free cloud plan later

## Stack

| Piece | Choice |
|---|---|
| Runtime | Node.js 20+ (ESM) |
| HTTP | Fastify 5 |
| Database | PostgreSQL 17 + PostGIS 3.5 |
| Cloud | Supabase free plan (Postgres + PostgREST) |
| Cloud storage | Infomaniak kDrive REST API v2/v3 |

## Quick start (Debian / Linux)

```bash
npm install
cp .env.example .env          # then set KDRIVE_ENC_KEY (see below)
bash scripts/db-local.sh start  # Docker/Supabase first, apt PostgreSQL fallback
npm run migrate
npm run seed
npm run dev
curl http://localhost:8787/health
```

Generate the token encryption key:

```bash
openssl rand -hex 32
```

Full instructions: [`docs/SETUP_DEBIAN.md`](docs/SETUP_DEBIAN.md) and [`docs/RUN.md`](docs/RUN.md).

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, scan pipelines |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, indexes, cluster/timeline functions |
| [docs/API.md](docs/API.md) | HTTP endpoints with examples |
| [docs/KDRIVE.md](docs/KDRIVE.md) | kDrive API, scopes, rate limits, enrichment |
| [docs/SETUP_DEBIAN.md](docs/SETUP_DEBIAN.md) | Dependency installation on Debian/Linux |
| [docs/RUN.md](docs/RUN.md) | Run server and database locally |
| [docs/SUPABASE_CLOUD.md](docs/SUPABASE_CLOUD.md) | Move from local Postgres to Supabase cloud |

## Repository layout

```
src/
  server.js            Fastify bootstrap, CORS, graceful shutdown
  config.js            Environment configuration
  db.js                PostgreSQL pool
  lib/                 crypto, geo helpers
  services/            kDrive client, EXIF enrichment
  routes/              HTTP endpoints
supabase/
  config.toml          Supabase CLI project config (db-only for local dev)
  migrations/          SQL migrations, portable to Supabase
  seed.sql             Demo data
scripts/               migrate, seed, db-local, dev, kdrive-check
test/                  node:test unit and database smoke tests
docs/                  documentation
```

## License

GPL-3.0-only. See [LICENSE](LICENSE).
