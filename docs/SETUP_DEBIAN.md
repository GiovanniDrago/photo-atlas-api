# Install dependencies on Debian / Linux

Tested on Debian 13 (trixie) and on a Debian-on-pixel-11 style environment (aarch64, ~5 GB RAM,
1 GB free). Commands use `sudo`; omit it if you are root.

## 1. Node.js 20 or newer

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v20.x or newer
```

Alternative without adding a repository:

```bash
sudo apt install -y nodejs npm   # Debian 13 ships Node 20
```

## 2. Clone and install the API

```bash
git clone https://github.com/GiovanniDrago/photo-atlas-api.git
cd photo-atlas-api
npm install --no-audit --no-fund
```

## 3. Database, option A: Docker + Supabase CLI (recommended for parity)

```bash
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in, or use newgrp docker
```

Then, from the repository:

```bash
npm install                       # installs the supabase CLI as a local dev dependency if present
npx supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor --ignore-health-check
```

Only the PostgreSQL container is started, which is what this project needs. The database is
available at `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

> The full Supabase stack needs ~7 GB of RAM and is not recommended on this device.

## 4. Database, option B: system PostgreSQL + PostGIS (lightest)

```bash
sudo apt install -y postgresql postgresql-17-postgis-3
sudo systemctl enable --now postgresql
```

`scripts/db-local.sh start` creates the `photo_atlas` role and database, enables PostGIS and writes
the right `DATABASE_URL` into `.env`. This path uses far less memory than Docker.

## 5. Optional: Supabase CLI globally

```bash
npm install -g supabase
supabase --version
```

## 6. Environment file

```bash
cp .env.example .env
openssl rand -hex 32     # paste the value into KDRIVE_ENC_KEY
```

`scripts/db-local.sh start` also generates `.env` automatically if it is missing.

## Resource notes for constrained devices

- Prefer option B (system PostgreSQL) on devices with less than 2 GB of free RAM.
- Keep `shared_buffers` small if you tune PostgreSQL (default is fine: ~128 MB).
- The API itself uses ~40 MB RSS; the Node server plus Postgres usually fit in less than 400 MB.
- Docker pulls ~500 MB of images on first use; run `docker system prune` afterwards if disk is tight.

## Next steps

- [RUN.md](RUN.md) to start the database and the API
- [SUPABASE_CLOUD.md](SUPABASE_CLOUD.md) to move to the hosted free plan later
