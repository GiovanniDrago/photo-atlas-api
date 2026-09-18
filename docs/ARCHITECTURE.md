# Architecture

Photo Atlas API is a small Node.js service in front of Supabase (PostgreSQL + PostGIS + Auth) and
Infomaniak kDrive. It indexes media metadata coming from local folders and kDrive and exposes it in
three shapes: individual media, space clusters, and time buckets.

```
                    +---------------------------+
                    |        Flutter app        |
                    | Android | Linux | Web     |
                    +------+-------------+------+
                           |             |
              Supabase Auth (GoTrue)     | HTTP/JSON (Bearer JWT)
              signup/login/MFA/refresh   |
                           v             v
                    +---------------------------+
                    |     Photo Atlas API       |
                    |  Fastify 5 + pg (Node 20) |
                    +--+----------+----------+--+
                       |          |          |
             +---------+   +------+---+  +---+----------------+
             |             |          |  |                    |
             v             v          v  v                    v
      +------------+  +---------+  +-------------------+  +----------------+
      | Supabase   |  |  kDrive  |  |  local filesystem |  | EXIF enrichment|
      |  Postgres  |  | REST API |  |  (thumbnails)     |  | (exifr, lazy)  |
      |  + PostGIS |  |         |  |                   |  |                |
      +------------+  +---------+  +-------------------+  +----------------+
```

## Components

| Component | Responsibility |
|---|---|
| `src/server.js` | HTTP bootstrap, CORS, error mapping, graceful shutdown |
| `src/routes/*` | One file per resource: health, auth, sources, media, clusters, timeline, scan-runs, kdrive |
| `src/lib/supabase-auth.js` | JWT verification with `jose` + JWKS, profile mirror, MFA (AAL2) enforcement |
| `src/lib/gotrue.js` | Supabase Auth admin client (users, password reset, TOTP factors) |
| `src/services/kdrive.js` | kDrive REST client with 60 req/min throttling, pagination, prefix downloads |
| `src/services/enrich.js` | EXIF/GPS extraction with `exifr` from partial file prefixes |
| `src/services/media-index.js` | Batch upsert of media rows, scan-run bookkeeping |
| `src/lib/crypto.js` | AES-256-GCM encryption of the kDrive token at rest |
| `supabase/migrations` | Portable SQL schema and aggregation functions |
| `netlify/email-confirm` | Static page returned by Supabase Auth after email confirmation |
| `scripts/*` | Local database bootstrap, migrations, seed, Netlify page zip, dev runner |

## Scan pipelines

### Local folder (Flutter-driven)

1. The app enumerates the chosen folder and extracts EXIF locally (capture date, GPS, dimensions).
2. The app sends batches to `POST /api/media/batch` with a `source_id` and optional `scan_run_id`.
3. The API normalizes each item, derives `metadata_status`, and upserts on `(source_id, external_key)`.
4. The scan run counters and status are updated by the app via `PATCH /api/scan-runs/:id`.

Server-side enrichment is available for local files through the thumbnail path only; GPS and dates
are expected from the client for local scans because the server may not see the same filesystem.

### kDrive folder (server-driven)

1. `POST /api/kdrive/scan` with a `folder_id` returns `202` and a `scan_run_id` immediately.
2. A background worker walks the folder recursively (`walkFiles`), respecting the API rate limit.
3. Files are mapped to media rows (name, size, MIME, kDrive timestamps) and upserted in batches.
4. `metadata_status` starts as `none` because the kDrive listing has no capture date or GPS.
5. `POST /api/kdrive/enrich` downloads only the first ~256 KB of each image, parses EXIF with
   `exifr`, and updates `taken_at`, `lat`, `lon`, dimensions and `metadata_status`.
6. The client polls `GET /api/scan-runs/:id` and `GET /api/kdrive/enrich` for progress.

## Aggregations

### Space: `media_clusters(west, south, east, north, zoom)`

Points are snapped to a grid whose cell size is `360 / 2^zoom` degrees. At zoom 0 the whole world is
one cell, so all photos merge into a single cluster near the average position. Zooming in shrinks
cells until nearby groups fall into different cells and split. This reproduces the desired behaviour:
two cities in the same country appear as one section when zoomed out and as two sections when zoomed
in. Cluster size is proportional to `item_count`; the client scales the highlight radius by
`sqrt(count)`.

`media_cell_size(zoom)` is exposed as an immutable SQL function so both the API and tests can reason
about the same math.

### Time: `media_timeline(from, to)`

Buckets are chosen by age:

| Age | Granularity | Example |
|---|---|---|
| 0-2 months | day | `2026-09-12` |
| 2-5 months | week | week starting `2026-07-06` |
| older | month | `2026-01` |

Every bucket returns `bucket_start`, `bucket_end`, `granularity`, `item_count` and a representative
media id for previews. Items without a usable date are excluded from the timeline but always remain
visible in `GET /api/media` with `metadata_status` `none` or `partial`.

## Metadata status

| Status | Meaning |
|---|---|
| `full` | capture date **and** GPS present |
| `partial` | exactly one of capture date / GPS present |
| `none` | neither present: the item still appears in the gallery and search |

## Security notes

- kDrive tokens are encrypted with AES-256-GCM; the key never leaves the server environment.
- `LOCAL_MEDIA_ROOTS` optionally restricts which local paths the thumbnail endpoint can read.
- CORS defaults to `*` for local development; set `CORS_ORIGIN` to your web app origin in production.
