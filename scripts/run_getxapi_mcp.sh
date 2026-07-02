#!/usr/bin/env bash
set -euo pipefail
KEY_FILE="${HOME}/.meridian/secrets/getxapi.key"
if [[ -z "${GETXAPI_KEY:-}" && -f "$KEY_FILE" ]]; then
  export GETXAPI_KEY
  GETXAPI_KEY="$(tr -d '\n' < "$KEY_FILE")"
fi
if [[ -z "${GETXAPI_KEY:-}" ]]; then
  echo "[getxapi-mcp] Missing GETXAPI_KEY — set ~/.meridian/secrets/getxapi.key" >&2
  exit 1
fi
exec npx -y @getxapi/mcp@latest