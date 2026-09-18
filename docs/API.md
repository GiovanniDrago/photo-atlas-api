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
