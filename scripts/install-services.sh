#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/photo-atlas-api.service"
SERVICE_NAME="photo-atlas-api.service"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Photo Atlas API
After=network-online.target

[Service]
WorkingDirectory=$ROOT_DIR
ExecStart=$NODE_BIN $ROOT_DIR/src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
chmod 600 "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
systemctl --user status "$SERVICE_NAME" --no-pager | head -12

echo
echo "[install-services] unit:   $UNIT_FILE"
echo "[install-services] logs:   journalctl --user -u $SERVICE_NAME -f"
echo "[install-services] status: systemctl --user status $SERVICE_NAME"
echo "[install-services] note:   starts with the ${USER:-user} session; for boot start run:"
echo "                           sudo loginctl enable-linger ${USER:-user}"
