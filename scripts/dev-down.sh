#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${PHOTO_ATLAS_APP_DIR:-$(cd "$ROOT_DIR/.." && pwd)/photo-atlas-app}"

stopped=0
API_UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/photo-atlas-api.service"
if [ -f "$API_UNIT" ] && systemctl --user is-active --quiet photo-atlas-api.service; then
  systemctl --user stop photo-atlas-api.service
  echo "[dev-down] stopped API (systemd unit photo-atlas-api.service)"
  stopped=1
fi

if [ -f "$ROOT_DIR/.run/api.pid" ]; then
  pid="$(cat "$ROOT_DIR/.run/api.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "[dev-down] stopped API (pid $pid)"
    stopped=1
  fi
  rm -f "$ROOT_DIR/.run/api.pid"
fi

if [ -x "$APP_DIR/scripts/serve-web.sh" ]; then
  bash "$APP_DIR/scripts/serve-web.sh" --stop || true
  stopped=1
fi

if [ "$stopped" -eq 0 ]; then
  echo "[dev-down] nothing managed by dev-up was running"
  echo "[dev-down] note: an API started manually with 'npm run dev' is not stopped by this script"
fi
