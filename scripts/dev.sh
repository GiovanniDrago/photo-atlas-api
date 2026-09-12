#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  bash scripts/db-local.sh start
fi

set -a
source .env
set +a

node scripts/migrate.js
node scripts/server.js
