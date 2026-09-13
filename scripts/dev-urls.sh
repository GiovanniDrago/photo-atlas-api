#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

API_PORT="${PORT:-8787}"
WEB_PORT="${WEB_PORT:-8080}"

ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
if [ -z "${ip:-}" ]; then
  ip="$(hostname -I | awk '{print $1}')"
fi

api_local="http://localhost:${API_PORT}"
api_lan="http://${ip}:${API_PORT}"
web_lan="http://${ip}:${WEB_PORT}/photo-atlas-app/"

echo "Photo Atlas development URLs"
echo "  VM IP:        ${ip}"
echo "  API (here):   ${api_local}"
echo "  API (phone):  ${api_lan}"

if curl -s --max-time 2 "${api_local}/health" >/dev/null 2>&1; then
  echo "  API status:   online"
else
  echo "  API status:   offline"
fi

if ss -ltn 2>/dev/null | grep -q ":${WEB_PORT} "; then
  echo "  Web (phone):  ${web_lan}"
else
  echo "  Web (phone):  not running (start photo-atlas-app/scripts/serve-web.sh)"
fi

echo "  Health check: curl ${api_lan}/health"
