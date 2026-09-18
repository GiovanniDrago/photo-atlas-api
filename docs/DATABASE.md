# Database

PostgreSQL 17 with PostGIS 3.5, hosted on Supabase cloud in production (Session Pooler) and
optionally on a local PostgreSQL for development/CI. The schema is written as portable SQL
migrations in `supabase/migrations`, applied by `scripts/migrate.js`.

## Tables

### Identity

Credentials live in **Supabase Auth** (`auth.users`, `auth.sessions`, `auth.mfa_factors`); the API
never stores passwords or TOTP secrets. Supabase Auth is queried through its admin API with the
server-side secret key.

| Table | Columns | Notes |
|---|---|---|
| `profiles` | `id` (PK, FK `auth.users`), `email`, `display_name`, `mfa_enabled`, `created_at`, `updated_at` | mirror for joins, filters and the app; refreshed from the token and the Auth admin API |
| `password_recovery_codes` | `id`, `user_id` (FK `auth.users`), `code_hash` (scrypt), `created_at`, `used_at` | 8 single-use codes per generation |
| `mfa_recovery_codes` | same shape | single-use codes that remove TOTP factors through the Auth admin API |
| `auth_events` | `id`, `user_id`, `kind`, `ip`, `user_agent`, `created_at` | app-side security audit trail |

Every data table is tied to a user through `sources.owner_id` (FK to `auth.users`, cascade delete):
sources, media items, scan runs and kDrive accounts are only visible to their owner.
`kdrive_accounts` has a unique index on `owner_id` (one connection per user).

On plain PostgreSQL (local development, CI) migration `0008_auth.sql` creates a minimal `auth.users`
stub, left untouched on Supabase where the real table exists.

Row Level Security is enabled with **no policies** on every app table
(`0012_rls_hardening.sql`), and the `anon`/`authenticated` grants are revoked: the Supabase Data API
cannot read anything while the API (table owner) works normally.

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
| `owner_id` | uuid | FK to `auth.users`, cascade delete |
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
npm run migrate            # applies supabase/migrations in order, tracked in schema_migrations
npm run seed -- <email>    # optional demo sources/media assigned to an existing account
```

To reset a local development database:

```bash
bash scripts/db-local.sh start && npm run migrate
```

On Supabase the migrations run against the Session Pooler URL with `npm run migrate`; the CLI
(`supabase db push`) tracks migrations in its own table and is not used by this project.

## Supabase compatibility

- Only standard extensions are used: `postgis`, `pg_trgm`, built-in `gen_random_uuid()`.
- `SET LOCAL search_path TO public, extensions, auth` is applied by the migration runner, because
  the PostGIS extension lives in the `extensions` schema on Supabase.
- RLS is enabled with no policies and `anon`/`authenticated` grants are revoked
  (`0012_rls_hardening.sql`); see [SUPABASE_CLOUD.md](SUPABASE_CLOUD.md).
