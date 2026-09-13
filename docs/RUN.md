# Run the API and the database

## One command

```bash
bash scripts/dev-up.sh    # database check + API + app web preview, prints the URLs
bash scripts/dev-down.sh  # stops what dev-up started
```

`dev-up.sh` reuses anything already listening on the API (8787) or web (8080) port, so it is safe
to run next to a manually started `npm run dev`. It starts the app web preview through
`photo-atlas-app/scripts/serve-web.sh` (override the repo location with `PHOTO_ATLAS_APP_DIR`).

## URLs

```bash
bash scripts/dev-urls.sh
```

```
Photo Atlas development URLs
  VM IP:        10.30.127.225
  API (here):   http://localhost:8787
  API (phone):  http://10.30.127.225:8787
  API status:   online
  Web (phone):  http://10.30.127.225:8080/photo-atlas-app/
```

The API also prints every reachable URL on startup, for example:

```
Photo Atlas API ready: http://localhost:8787  |  http://10.30.127.225:8787
```

The VM IP comes from DHCP and can change when the VM restarts; the web app detects its own host
automatically, so opening the printed `Web (phone)` URL is enough.

## Day-to-day

```bash
bash scripts/db-local.sh start   # start database and ensure .env
npm run migrate                  # apply new SQL migrations
npm run seed                     # demo data (safe to re-run)
npm run dev                      # API with --watch on http://localhost:8787
```

Check the API:

```bash
curl http://localhost:8787/health
curl 'http://localhost:8787/api/clusters?west=-180&south=-90&east=180&north=90&zoom=0'
curl 'http://localhost:8787/api/timeline' | head -c 400
```

Stop the database:

```bash
bash scripts/db-local.sh stop    # stops the Docker/Supabase containers (not system PostgreSQL)
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` to keep it local |
| `CORS_ORIGIN` | `*` | Allowed origin(s), comma separated |
| `DATABASE_URL` | system URL | PostgreSQL connection string |
| `KDRIVE_ENC_KEY` | empty | 64 hex chars; required to connect kDrive |
| `LOCAL_MEDIA_ROOTS` | empty | Colon separated allowlist for local thumbnails |
| `KDRIVE_API_BASE` | `https://api.infomaniak.com` | Override for tests |

## Tests

```bash
npm test
```

`test/crypto.test.js` runs anywhere. `test/db.test.js` requires a reachable database and is skipped
when `DATABASE_URL` is not set.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL is not running: `sudo systemctl start postgresql` |
| `permission denied for schema public` | The DB role is not the database owner; re-run `bash scripts/db-local.sh start` |
| `extension "postgis" is not available` | Install `postgresql-17-postgis-3` |
| Migration says `failed` | The transaction was rolled back; fix the SQL and re-run `npm run migrate` |
| `KDRIVE_ENC_KEY must be...` | Put a 32-byte hex key in `.env` (`openssl rand -hex 32`) |
| Port 8787 in use | Set `PORT=8788` in `.env` |
