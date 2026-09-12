#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <infomaniak_api_token> <kdrive_id>" >&2
  echo "create a token with the drive scope at https://manager.infomaniak.com/v3/ng/accounts/token/list" >&2
  exit 1
fi

token="$1"
drive_id="$2"

echo "checking drive $drive_id ..."
response="$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $token" "https://api.infomaniak.com/2/drive/$drive_id")"
code="$(printf '%s' "$response" | tail -n1)"
body="$(printf '%s' "$response" | sed '$d')"

if [ "$code" != "200" ]; then
  echo "authentication failed (HTTP $code):" >&2
  printf '%s\n' "$body" >&2
  exit 1
fi

printf '%s\n' "$body" | python3 -m json.tool | head -n 40
echo
echo "OK: token and drive id are valid"
