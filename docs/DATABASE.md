# Database

PostgreSQL 17 with PostGIS 3.5. The schema is written as portable SQL migrations in
`supabase/migrations`, applied locally by `scripts/migrate.js` and later pushable to a Supabase
free plan with `supabase db push`.

## Tables

### `users` and `sessions`

Local authentication for this development phase (no email, no verification).

| Table | Columns |
|---|---|
| `users` | `id`, `username` (unique case-insensitive), `password_hash` (scrypt salt:hash), `created_at` |
| `sessions` | `id`, `user_id`, `token_hash` (SHA-256 of the bearer token), `created_at`, `expires_at` (30 days), `last_used_at` |

Every other data table is tied to a user through `sources.owner_id`: sources, media items, scan runs
and kDrive accounts are only readable by their owner. `kdrive_accounts` has a unique index on
`owner_id` (one connection per user). When moving to Supabase cloud, `users` can be replaced by
Supabase Auth and `owner_id` pointed at `auth.users(id)`; the RLS example in
[SUPABASE_CLOUD.md](SUPABASE_CLOUD.md) already assumes that shape.

### `sources`

Where media comes from.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `kind` | text | `local` or `kdrive` |
| `label` | text | human readable name |
| `root_path` | text | local folder path (local only) |
| `kdrive_drive_id` | bigint | kDrive drive id (kdrive only) |
| `kdrive_folder_id` | bigint | kDrive folder id (kdrive only) |
| `created_at` / `last_scan_at` | timestamptz | bookkeeping |
| `owner_id` | uuid | FK to `users`, cascade delete |
| `include_subfolders` | boolean | kDrive sources: scan the whole subtree or only direct files |

Unique on `(owner_id, kdrive_drive_id, kdrive_folder_id)` for kdrive sources.

### `media_items`

One row per indexed image or video.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `source_id` | uuid | FK to `sources`, cascade delete |
| `external_key` | text | local path or kDrive file id; unique per source |
| `path` | text | absolute local path when applicable |
| `name`, `mime`, `media_type` | text | `media_type` is `image` or `video` |
| `size_bytes` | bigint | file size |
| `taken_at` | timestamptz | capture date from EXIF when available |
| `file_created_at`, `modified_at` | timestamptz | filesystem/kDrive timestamps |
| `lat`, `lon` | double precision | GPS when available |
| `geog` | geography(Point,4326) | generated from `lat`/`lon`, GiST indexed |
| `metadata_status` | text | `none`, `partial`, `full` |
| `width`, `height`, `duration_s` | int/numeric | dimensions and video duration |
| `thumb_path` | text | optional local thumbnail |
| `indexed_at`, `updated_at` | timestamptz | bookkeeping |

Indexes: GiST on `geog`, btree on `taken_at DESC NULLS LAST`, on `metadata_status`, `media_type`,
`source_id`, and a trigram GIN index on `name` for search.

### `scan_runs`

Progress records for client-driven and kDrive scans: status, file counters and a JSONB error list.

### `kdrive_accounts`

Single-row connection store: drive id plus the AES-256-GCM encrypted token (`token_cipher`,
`token_iv`, `token_tag`).

## Aggregation functions

### `media_cell_size(zoom)`

Returns `360 / 2^zoom` degrees, clamped between zoom 0 and 18.

```sql
SELECT media_cell_size(0);   -- 360
SELECT media_cell_size(8);   -- 1.40625
```

### `media_clusters(west, south, east, north, zoom)`

```sql
SELECT cluster_key, lat, lon, item_count, representative_id
FROM media_clusters(6, 44, 10, 46, 8);
```

Returns one row per grid cell containing media with GPS, with the average position, count, bounds and
a representative media id. Ordering is by `item_count DESC`.

### `media_timeline(from, to)`

```sql
SELECT bucket_start, bucket_end, granularity, item_count
FROM media_timeline(now() - interval '5 years', now());
```

Granularity rules are described in [ARCHITECTURE.md](ARCHITECTURE.md#time-media_timelinefrom-to).

## Migrations

```bash
npm run migrate   # applies supabase/migrations in order, tracked in schema_migrations
npm run seed      # demo data: 3 sources worth of items across cities, missing-metadata items, videos
```

To reset locally with Docker:

```bash
docker rm -f photo-atlas-db && bash scripts/db-local.sh start && npm run migrate && npm run seed
```

With the Supabase CLI the same files are applied by `supabase start` or `supabase db push`.

## Supabase compatibility

- Only standard extensions are used: `postgis`, `pg_trgm`, `pgcrypto`/built-in `gen_random_uuid()`.
- No `SECURITY DEFINER`, no RLS policies are required for the local single-user setup.
- When moving to Supabase cloud, enable RLS and add owner-based policies; see
  [SUPABASE_CLOUD.md](SUPABASE_CLOUD.md).
