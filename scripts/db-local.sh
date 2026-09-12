#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_DB_URL="postgresql://photo_atlas:photo_atlas@127.0.0.1:54329/photo_atlas"
SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
SYSTEM_DB_URL="postgresql://photo_atlas:photo_atlas@127.0.0.1:5432/photo_atlas"

log() { printf '[db-local] %s\n' "$*" >&2; }

ensure_env_file() {
  if [ -f "$ENV_FILE" ]; then
    log ".env already exists, leaving it untouched"
    return 0
  fi
  local key url
  url="$1"
  key="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENV_FILE" <<EOF
PORT=8787
HOST=0.0.0.0
CORS_ORIGIN=*
DATABASE_URL=$url
KDRIVE_ENC_KEY=$key
LOCAL_MEDIA_ROOTS=
KDRIVE_API_BASE=https://api.infomaniak.com
EOF
  log "created .env with DATABASE_URL=$url and a fresh KDRIVE_ENC_KEY"
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

try_supabase() {
  docker_available || return 1
  [ -f "$ROOT_DIR/supabase/config.toml" ] || return 1
  local cli=""
  if [ -x "$ROOT_DIR/node_modules/.bin/supabase" ]; then
    cli="$ROOT_DIR/node_modules/.bin/supabase"
  elif command -v npx >/dev/null 2>&1; then
    cli="npx --yes supabase"
  else
    return 1
  fi
  log "starting Supabase local stack (database only)"
  (cd "$ROOT_DIR" && $cli start \
    -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor \
    --ignore-health-check >/dev/null 2>&1) || return 1
  echo "$SUPABASE_DB_URL"
}

try_docker() {
  docker_available || return 1
  if docker ps -a --format '{{.Names}}' | grep -qx 'photo-atlas-db'; then
    docker start photo-atlas-db >/dev/null
  else
    log "starting PostGIS container photo-atlas-db"
    docker run -d --name photo-atlas-db \
      -e POSTGRES_USER=photo_atlas \
      -e POSTGRES_PASSWORD=photo_atlas \
      -e POSTGRES_DB=photo_atlas \
      -p 127.0.0.1:54329:5432 \
      postgis/postgis:17-3.5 >/dev/null
  fi
  echo "$COMPOSE_DB_URL"
}

try_system() {
  command -v psql >/dev/null 2>&1 || return 1
  if ! pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
    log "starting system PostgreSQL"
    sudo systemctl start postgresql >/dev/null 2>&1 || sudo pg_ctlcluster 17 main start >/dev/null 2>&1 || true
    sleep 2
  fi
  pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null || return 1
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'photo_atlas') THEN
    CREATE ROLE photo_atlas LOGIN PASSWORD 'photo_atlas' CREATEDB;
  END IF;
END $$;
SQL
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'photo_atlas'" | grep -q 1; then
    sudo -u postgres createdb -O photo_atlas photo_atlas
  fi
  sudo -u postgres psql -d photo_atlas -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null
  echo "$SYSTEM_DB_URL"
}

case "${1:-start}" in
  start)
    url=""
    if url="$(try_supabase)"; then
      log "backend: supabase (db only)"
    elif url="$(try_docker)"; then
      log "backend: docker (postgis/postgis:17-3.5)"
    elif url="$(try_system)"; then
      log "backend: system PostgreSQL"
    else
      log "no database backend available."
      log "install Docker (see docs/SETUP_DEBIAN.md) or run: sudo apt install postgresql postgresql-17-postgis-3"
      exit 1
    fi
    ensure_env_file "$url"
    log "ready: $url"
    ;;
  stop)
    if docker_available && docker ps -a --format '{{.Names}}' | grep -qx 'photo-atlas-db'; then
      docker stop photo-atlas-db >/dev/null && log "stopped photo-atlas-db"
    fi
    if [ -x "$ROOT_DIR/node_modules/.bin/supabase" ]; then
      (cd "$ROOT_DIR" && node_modules/.bin/supabase stop --no-backup >/dev/null 2>&1) || true
    fi
    ;;
  url)
    grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-
    ;;
  *)
    echo "usage: $0 [start|stop|url]" >&2
    exit 1
    ;;
esac
