#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${PHOTO_ATLAS_APP_DIR:-$(cd "$ROOT_DIR/.." && pwd)/photo-atlas-app}"
RUN_DIR="$ROOT_DIR/.run"
mkdir -p "$RUN_DIR"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi
API_PORT="${PORT:-8787}"
WEB_PORT="${WEB_PORT:-8080}"

if [ ! -f "$ROOT_DIR/.env" ]; then
  bash "$ROOT_DIR/scripts/db-local.sh" start
fi

if ! pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
  echo "[dev-up] PostgreSQL is not ready, starting it"
  bash "$ROOT_DIR/scripts/db-local.sh" start
fi

if ss -ltn 2>/dev/null | grep -q ":${API_PORT} "; then
  echo "[dev-up] API already listening on ${API_PORT}"
else
  (
    cd "$ROOT_DIR"
    nohup node src/server.js > "$RUN_DIR/api.log" 2>&1 &
    echo $! > "$RUN_DIR/api.pid"
  )
  sleep 1
  echo "[dev-up] API started (log: .run/api.log)"
fi

if ss -ltn 2>/dev/null | grep -q ":${WEB_PORT} "; then
  echo "[dev-up] web server already listening on ${WEB_PORT}"
elif [ -x "$APP_DIR/scripts/serve-web.sh" ]; then
  bash "$APP_DIR/scripts/serve-web.sh" --background || echo "[dev-up] web server not started (run photo-atlas-app/scripts/fetch-web-build.sh first)"
else
  echo "[dev-up] app repository not found at $APP_DIR (set PHOTO_ATLAS_APP_DIR)"
fi

sleep 1
bash "$ROOT_DIR/scripts/dev-urls.sh"
