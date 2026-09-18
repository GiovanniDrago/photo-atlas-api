#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/netlify/email-confirm"
OUT_DIR="$ROOT_DIR/dist"
OUT_FILE="$OUT_DIR/photo-atlas-confirm-email.zip"

if [ ! -f "$SRC_DIR/index.html" ]; then
  echo "[build-netlify-page] $SRC_DIR/index.html not found" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

python3 - "$SRC_DIR" "$OUT_FILE" <<'PY'
import os
import sys
import zipfile

src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if os.path.isfile(path):
            archive.write(path, name)
print(f'[build-netlify-page] wrote {out}')
PY

echo "[build-netlify-page] upload the zip to Netlify (drag & drop on app.netlify.com/drop)"
