# Run the API and the database

## One command

```bash
bash scripts/dev-up.sh    # API + app web preview, prints the URLs (uses the .env database)
bash scripts/dev-down.sh  # stops what dev-up started
```

`dev-up.sh` reuses anything already listening on the API (8787) or web (8080) port, so it is safe
to run next to a manually started `npm run dev`. It starts the app web preview through
`photo-atlas-app/scripts/serve-web.sh` (override the repo location with `PHOTO_ATLAS_APP_DIR`).

The production database is **Supabase cloud** (`DATABASE_URL` points at the Session Pooler). The
script only starts a local PostgreSQL when `DATABASE_URL` is local (plain PostgreSQL development);
with the Supabase URL it leaves the local service alone.

## URLs

```bash
bash scripts/dev-urls.sh
```

```
Photo Atlas development URLs
  VM IP:        <vm-ip>
  API (here):   http://localhost:8787
  API (phone):  http://<vm-ip>:8787
  API status:   online
  Web (phone):  http://<vm-ip>:8080/photo-atlas-app/
```

The API also prints every reachable URL on startup, for example:

```
Photo Atlas API ready: http://localhost:8787  |  http://<vm-ip>:8787
```

The VM IP comes from DHCP and can change when the VM restarts; the web app detects its own host
automatically, so opening the printed `Web (phone)` URL is enough.

## Autostart (systemd user service)

The API runs as a systemd **user** service, so it starts with the `droid` session (the same
mechanism as the opencode-web service) and restarts on failure:

```bash
bash scripts/install-services.sh          # install/update + enable + start (idempotent)

systemctl --user status photo-atlas-api   # state
systemctl --user restart photo-atlas-api  # restart
journalctl --user -u photo-atlas-api -f   # live logs (journal)
```

Logs go to the systemd journal (no `.run/api.log` when the service manages the process).
`dev-up.sh` starts the unit when it exists and falls back to a `nohup` process otherwise;
`dev-down.sh` stops it. The web preview (port 8080) is not managed by systemd: use
`photo-atlas-app/scripts/serve-web.sh`.

By default the service starts with the user session only; to also start it at boot without a login
(once, needs sudo):

```bash
sudo loginctl enable-linger droid
```

## Day-to-day

```bash
npm run migrate                  # apply new SQL migrations to DATABASE_URL
npm run seed -- <email>          # optional demo sources/media assigned to an existing account
npm run dev                      # API with --watch on http://localhost:8787
```

Check the API (the token comes from the app or from a Supabase Auth session):

```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/config
curl -H "Authorization: Bearer <supabase-access-token>" \
  'http://localhost:8787/api/media?limit=5'
```

Every `/api/*` route except `/api/config`, `/api/auth/password/reset-with-code` and
`/api/auth/mfa/recovery` requires a **Supabase access token** (`Authorization: Bearer <jwt>`); the
API verifies the signature locally against `SUPABASE_JWKS_URL`. Accounts, passwords, email
confirmation and TOTP factors are managed by Supabase Auth (dashboard → Authentication → Users).

## Users and recovery

- Users register in the app with email + password; Supabase sends the confirmation email and the
  link lands on the Netlify page (see [SUPABASE_CLOUD.md](SUPABASE_CLOUD.md)).
- The app shows one-time **recovery codes** used to reset the password without email; each code works
  once and the API signs out every session after a reset.
- Break-glass from the server: `npm run reset-password -- <email> [new_password]` (needs the
  service key in `.env`; prints the new password and signs the user out where supported).
- Losing a 2FA device: an MFA recovery code removes the TOTP factors
  (`POST /api/auth/mfa/recovery`); an admin can also delete the factor from the Supabase dashboard.

## Previews cache

kDrive previews are cached under `MEDIA_CACHE_DIR` (default `~/.cache/photo-atlas`). Progress of the
automatic delta job after each scan: `GET /api/kdrive/previews`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` to keep it local |
| `CORS_ORIGIN` | `*` | Allowed origin(s), comma separated |
| `DATABASE_URL` | local PostgreSQL | PostgreSQL connection string (Supabase Session Pooler in production, `?sslmode=require`) |
| `SUPABASE_URL` | empty | Project URL, e.g. `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | empty | Public key exposed to the app by `GET /api/config` |
| `SUPABASE_SECRET_KEY` | empty | Server-only key for the Auth admin API (password reset, factors) |
| `SUPABASE_JWKS_URL` | empty | JWKS endpoint used to verify access tokens |
| `EMAIL_CONFIRM_REDIRECT_URL` | empty | Netlify page returned to the app for the signup email |
| `KDRIVE_ENC_KEY` | empty | 64 hex chars; required to connect kDrive |
| `LOCAL_MEDIA_ROOTS` | empty | Colon separated allowlist for local thumbnails |
| `KDRIVE_API_BASE` | `https://api.infomaniak.com` | Override for tests |
| `MEDIA_URL_SECRET` | `KDRIVE_ENC_KEY` | HMAC secret for signed thumbnail/download URLs |
| `MEDIA_CACHE_DIR` | `~/.cache/photo-atlas` | Thumbnail cache directory |

## Tests

```bash
npm test
```

Unit tests run anywhere. Database integration tests use `TEST_DATABASE_URL` (a throwaway database)
and are skipped when it is not set — never point it at the production Supabase database.

```bash
TEST_DATABASE_URL=postgresql://photo_atlas:photo_atlas@127.0.0.1:5432/photo_atlas npm test
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED ...:5432` on a local database | PostgreSQL is not running: `sudo systemctl start postgresql`, or use the Supabase URL |
| `missing_supabase_configuration` / 500 on `/api/config` | `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are not set in `.env` |
| `401 unauthorized` on every request | Token expired or project keys changed; sign in again from the app |
| `403 mfa_required` | The account has TOTP enabled and the session is only AAL1; complete the MFA challenge |
| `extension "postgis" is not available` | Enable PostGIS (and `pg_trgm`) in the Supabase dashboard or locally with `sudo apt install postgresql-17-postgis-3` |
| Migration says `failed` | The transaction was rolled back; fix the SQL and re-run `npm run migrate` |
| `KDRIVE_ENC_KEY must be...` | Put a 32-byte hex key in `.env` (`openssl rand -hex 32`) |
| Port 8787 in use | Set `PORT=8788` in `.env` |
