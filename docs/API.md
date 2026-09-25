# HTTP API

Base URL: `http://localhost:8787`. All responses are JSON. Errors use `{ "error": "..." }` with an
appropriate status code. Numeric columns (`bigint`, `numeric`) are serialized as JSON numbers, not
strings.

## Asset URLs (thumbnail and original download)

Media payloads include two pre-signed absolute URLs:

| Field | Endpoint | Purpose |
|---|---|---|
| `thumbnail_url` | `GET /api/media/:id/thumbnail?m=…&s=…` | small preview (kDrive previews and phone-uploaded previews are cached on disk) |
| `download_url` | `GET /api/media/:id/download?m=…&s=…` | original file at full quality |

The signature is a stable HMAC of the media id (no expiry in this dev phase), so the URLs are safe
for `<img>` tags and browser caching. Requests without a valid signature get `401`.

`download_url` is `null` for `local` items whose file is not readable on the API host (for example
media scanned from a phone album: the file lives on the device, not on the server). kDrive items and
readable local files always carry a `download_url`.

## Authentication

Accounts and credentials live in **Supabase Auth**; the API only verifies the access token. Get one
by signing in from the app (or any Supabase client with the publishable key) and send it as:

```
Authorization: Bearer <supabase access token>
```

The API verifies the JWT signature locally against `SUPABASE_JWKS_URL` (`jose`, cached JWKS),
checks issuer + audience (`authenticated`) and uses the `sub` claim as `owner_id` for every row.
Tokens are short-lived; the client refreshes them automatically. The public routes are
`GET /api/config`, `POST /api/auth/password/reset-with-code` and `POST /api/auth/mfa/recovery`.

### Client configuration

```bash
curl http://localhost:8787/api/config
# { "supabase_url": "https://<ref>.supabase.co",
#   "supabase_publishable_key": "sb_publishable_…",
#   "email_confirm_redirect_url": "https://<netlify>/?app=PhotoAtlas" }
```

The app uses these public values to initialize `supabase_flutter`.

### Two-factor authentication

TOTP factors are Supabase Auth factors: enroll, challenge and verify with the Supabase client
(`auth.mfa.*`). The API enforces the result: when the account has a verified factor and the token is
only `aal1`, every route answers `403 { "error": "mfa_required" }`. After enrolling or removing a
factor the app calls:

```bash
curl -X POST http://localhost:8787/api/auth/mfa/sync -H "Authorization: Bearer <token>"
# { "user": { ..., "mfa_enabled": true } }
```

`GET /api/auth/me` returns the mirrored profile (`id`, `email`, `display_name`, `mfa_enabled`) and
refreshes `mfa_enabled` from the Auth admin API.

### Recovery codes (no email needed)

Each account gets 8 one-time password-reset codes and 8 one-time MFA-recovery codes. The app shows
them after signup/regeneration; the API stores only scrypt hashes.

```bash
# remaining unused codes (authenticated)
curl http://localhost:8787/api/auth/recovery-codes -H "Authorization: Bearer <token>"
# { "password_remaining": 8, "mfa_remaining": 0 }

# regenerate codes: kind "password" (default) or "mfa"
curl -X POST http://localhost:8787/api/auth/recovery-codes \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"kind":"password"}'
# { "recovery_codes": ["XXXX-XXXX", ...8] }

# forgotten password: email + code + new password (public)
curl -X POST http://localhost:8787/api/auth/password/reset-with-code \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"alice@example.com","recovery_code":"XXXX-XXXX","new_password":"brand-new-password"}'

# lost authenticator: email + MFA recovery code, removes the TOTP factors (public)
curl -X POST http://localhost:8787/api/auth/mfa/recovery \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"alice@example.com","recovery_code":"XXXX-XXXX"}'
```

Both endpoints are rate limited (10 requests/minute per IP), return generic
`400 invalid_recovery_code` errors and consume the code. A password reset also signs out every
session through the Auth admin API. Break-glass on the server:

```bash
npm run reset-password -- <email> [new_password]
```

### Audit

Security-relevant app events (`password_reset`, `mfa_factor_reset`, `recovery_codes_regenerated`,
`password_reset_cli`) are recorded in `auth_events` with IP and user agent. Logins, confirmations and
factor changes are visible in the Supabase Auth logs and dashboard.

Data is owned per user through `profiles`/`sources.owner_id` (both keyed to `auth.users.id`);
`GET /health` is public.

## Health

```bash
curl http://localhost:8787/health
```

```json
{ "status": "ok", "database": "up", "time": "2026-09-12T08:00:00.000Z" }
```

## Sources

```bash
curl http://localhost:8787/api/sources
curl -X POST http://localhost:8787/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"kind":"local","label":"My pictures","root_path":"/home/droid/Pictures"}'
```

`PATCH /api/sources/<id>` updates `label`, `root_path`, `last_scan_at`, `include_subfolders`,
`device_id`, `album_key` and `auto_backup` (boolean). Enabling `auto_backup` sets
`backup_enabled_at` once, disabling it clears the column.

## Media

### List and filter

```
GET /api/media?west=&south=&east=&north=&from=&to=&status=&type=&source_id=&has_gps=&q=&limit=&offset=&order=
```

| Parameter | Values |
|---|---|
| `west,south,east,north` | bounding box filter (all four required together) |
| `from,to` | ISO timestamps on `taken_at` |
| `status` | `all`, `none`, `partial`, `full` |
| `type` | `all`, `image`, `video` |
| `source_id` | uuid |
| `has_gps` | `true`, `false` |
| `q` | name search (trigram indexed) |
| `order` | `taken_at.desc` (default), `taken_at.asc` |
| `limit`,`offset` | default 100, max 500 |

Items without metadata are returned like any other item; check `metadata_status` and `has_gps`.

```bash
curl 'http://localhost:8787/api/media?status=none&limit=10'
```

### Single item

```bash
curl http://localhost:8787/api/media/<uuid>
```

### Thumbnail or original bytes

```bash
curl -o thumb.jpg http://localhost:8787/api/media/<uuid>/thumbnail
```

Local sources stream the original file when no thumbnail exists (restricted by
`LOCAL_MEDIA_ROOTS`); kDrive sources are proxied through the API with the server-side token. Mobile
scans seed the cache directly: `thumbnail_b64` items are written to `<cache>/thumbs/<media id>.jpg`
and served from disk afterwards.

### Batch upsert (used by scans)

```bash
curl -X POST http://localhost:8787/api/media/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "source_id": "<uuid>",
    "scan_run_id": "<uuid>",
    "items": [
      {
        "external_key": "/home/droid/Pictures/IMG_0001.jpg",
        "path": "/home/droid/Pictures/IMG_0001.jpg",
        "name": "IMG_0001.jpg",
        "mime": "image/jpeg",
        "media_type": "image",
        "size_bytes": 2431000,
        "taken_at": "2026-08-01T18:22:10Z",
        "lat": 45.0703,
        "lon": 7.6869,
        "width": 4032,
        "height": 3024,
        "thumbnail_b64": "<base64 jpeg, optional>"
      }
    ]
  }'
```

`metadata_status` is derived automatically when omitted (date + GPS = `full`, one = `partial`,
none = `none`). Maximum 500 items per request.

`thumbnail_b64` is optional and used by the Android app, which uploads a 320 px JPEG preview
(≤ 256 KB) per asset because the API cannot read files that only exist on the phone. Invalid or
oversized payloads are ignored and the item is still indexed.

## Albums

Albums are database relations: a media item can belong to many albums and removing it from an
album never touches the file. `kind=manual` albums list their items in `album_items`; `kind=smart`
albums resolve live from a rule tree, so new matching media appear automatically.

```bash
# list (item_count and a serialized cover are computed live)
curl http://localhost:8787/api/albums -H "Authorization: Bearer <token>"
# create a manual album from the current selection
curl -X POST http://localhost:8787/api/albums -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Viaggio","media_ids":["<uuid>","<uuid>"]}'
# create a smart album
curl -X POST http://localhost:8787/api/albums -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Qui nel 2024","kind":"smart","rules":{"all":[
        {"field":"taken_at","op":"between","value":["2024-01-01","2024-12-31"]},
        {"field":"location","op":"within","value":{"lat":45.07,"lon":7.68,"radius_m":5000}}]}}'
# count preview for the builder
curl -X POST http://localhost:8787/api/albums/preview -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"rules":{"all":[{"field":"media_type","op":"eq","value":"video"}]}}'
# rename, change rules or cover (clear_cover drops the explicit cover)
curl -X PATCH http://localhost:8787/api/albums/<uuid> -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"name":"Estate","cover_media_id":"<uuid>"}'
# items of an album, same {items,total,limit,offset} shape as /api/media
curl "http://localhost:8787/api/albums/<uuid>/media?limit=100&offset=0" -H "Authorization: Bearer <token>"
# add or remove manual items
curl -X POST http://localhost:8787/api/albums/<uuid>/items -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"media_ids":["<uuid>"]}'
curl -X DELETE http://localhost:8787/api/albums/<uuid>/items -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"media_ids":["<uuid>"]}'
# delete the album (items and files are untouched)
curl -X DELETE http://localhost:8787/api/albums/<uuid> -H "Authorization: Bearer <token>"
```

Rules use one top-level group, `all` (AND) or `any` (OR), with up to 20 leaf conditions
`{field, op, value}`:

| Field | Ops | Value |
|---|---|---|
| `taken_at`, `backed_up_at` | `between`, `gte`, `lte`, `is_null` | ISO date (or a two-date array for `between`) |
| `location` | `within` | `{lat, lon, radius_m}`, radius 100 m – 500 km, PostGIS `ST_DWithin` |
| `media_type` | `eq` | `image` or `video` |
| `metadata_status` | `eq` | `none`, `partial`, `full` |
| `backup_status` | `eq`, `in` | `none`, `pending`, `uploading`, `uploaded`, `failed`, `skipped` |
| `source_id`, `device_id` | `eq` | uuid |
| `name` | `contains` | substring, `%` and `_` are escaped |

The engine supports all of them; the app builder currently exposes taken/upload date, location and
media type. Unknown fields/ops, out-of-range values or empty rules are rejected with `400`.
`POST /api/albums/:id/items` and `DELETE /api/albums/:id/items` only work on manual albums
(`400 album_is_smart`); media that is not yours is skipped or refused.

## Backup to kDrive

Originals are uploaded to `KDRIVE_BASE_PATH` (default `Media/PhotoAtlas`): per-folder backups land
in `Media/PhotoAtlas/<folder>`, manual uploads in `Media/PhotoAtlas/Manual`. Files keep their name
and kDrive is asked to rename on conflict, so nothing is ever overwritten. Uploads are driven by the
app; the API streams the body to a temporary file, computes the SHA-256 while streaming, extracts
EXIF from images (server-side metadata is authoritative), then uploads to kDrive (direct up to
1 GB, chunked session above) and records the state in `media_items`.

```bash
# register this device (fingerprint is stable per installation)
curl -X POST http://localhost:8787/api/devices -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"fingerprint":"<uuid>","name":"Pixel","platform":"android"}'

# queue of items still to upload, and verification queue
curl "http://localhost:8787/api/backup/pending?limit=100" -H "Authorization: Bearer <token>"
curl "http://localhost:8787/api/backup/verify-queue?limit=100" -H "Authorization: Bearer <token>"

# per-source counters (uploaded / pending / failed, bytes)
curl http://localhost:8787/api/backup/status -H "Authorization: Bearer <token>"
# upload one original (?destination=manual puts it in Media/PhotoAtlas/Manual)
curl -X POST "http://localhost:8787/api/media/<uuid>/upload?destination=manual" \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/octet-stream' \
  --data-binary @IMG_0001.jpg

# check that a backed-up file still exists on kDrive (missing -> back to pending)
curl -X POST http://localhost:8787/api/media/<uuid>/verify -H "Authorization: Bearer <token>"

# runs (kind backup|verify) with counters
curl -X POST http://localhost:8787/api/backup/runs -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"kind":"backup"}'
curl -X PATCH http://localhost:8787/api/backup/runs/<uuid> -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"status":"completed","files_uploaded":12}'
```

Media payloads now include `backup_status`, `kdrive_file_id`, `backed_up_at` and `backup_error`;
`GET /api/media` accepts `backup_status=none,pending` and `device_id=`. The batch endpoint
(`POST /api/media/batch`) also returns `items: [{id, external_key}]` so the app can upload right
after indexing. kDrive-sourced items are marked `uploaded` automatically.

`GET /api/backup/pending` **claims** the rows it returns: each item is atomically set to
`backup_status='uploading'` (`FOR UPDATE SKIP LOCKED`), so a foreground run and the Android
background worker never upload the same file twice (`conflict=rename` would create a duplicate on
kDrive). A claim older than 2 hours (worker killed mid-upload) is released back to `pending` with
`backup_error='stale_upload'` at the start of the next call; `GET /api/backup/status` counts
`uploading` items as pending. A completed backup run also updates `sources.backup_last_run_at`.

## Clusters (planet map)

```
GET /api/clusters?west=-180&south=-90&east=180&north=90&zoom=0
```

```json
{
  "clusters": [
    {
      "key": "133:137",
      "lat": 45.2,
      "lon": 8.4,
      "count": 13,
      "bounds": { "west": 7.6, "south": 45.0, "east": 9.2, "north": 45.5 },
      "representative_id": "..."
    }
  ]
}
```

Zoom 0 merges the whole world into few sections; each zoom level halves the cell size, splitting
sections as the user zooms in.

## Timeline

```
GET /api/timeline?from=2021-01-01T00:00:00Z
GET /api/timeline/items?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z&limit=200&offset=0
```

`/api/timeline` returns the list of buckets (day/week/month) with counts and a representative id.
`/api/timeline/items` returns the items inside one bucket range.

## Scan runs

```bash
curl -X POST http://localhost:8787/api/scan-runs -H 'Content-Type: application/json' -d '{"source_id":"<uuid>"}'
curl -X PATCH http://localhost:8787/api/scan-runs/<uuid> \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed","files_seen":120,"files_indexed":118}'
curl http://localhost:8787/api/scan-runs
```

## kDrive

```bash
curl -X POST http://localhost:8787/api/kdrive/connect \
  -H 'Content-Type: application/json' \
  -d '{"token":"<infomaniak token>","drive_id":12345,"label":"My kDrive"}'

curl http://localhost:8787/api/kdrive/status
curl 'http://localhost:8787/api/kdrive/folders?parent_id=1'
curl -X POST http://localhost:8787/api/kdrive/scan \
  -H 'Content-Type: application/json' \
  -d '{"folder_id":42,"include_subfolders":true,"label":"kDrive: Photos/Trips"}'
curl -X PATCH http://localhost:8787/api/sources/<source-uuid> \
  -H 'Content-Type: application/json' -d '{"include_subfolders":false}'
curl -X POST http://localhost:8787/api/kdrive/enrich \
  -H 'Content-Type: application/json' -d '{"limit":50}'
curl http://localhost:8787/api/kdrive/enrich
```

See [KDRIVE.md](KDRIVE.md) for the full flow and limits.
