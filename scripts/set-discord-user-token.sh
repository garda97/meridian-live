#!/usr/bin/env bash
# Securely set secondary Discord account token for meridian-discord listener.
# Usage:
#   ./scripts/set-discord-user-token.sh          # prompts (hidden input)
#   ./scripts/set-discord-user-token.sh <token> # non-interactive (avoid shell history)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

TOKEN="${1:-}"
if [[ -z "$TOKEN" ]]; then
  read -rsp "Paste DISCORD_USER_TOKEN (secondary account): " TOKEN
  echo
fi

TOKEN="$(echo "$TOKEN" | tr -d '[:space:]')"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: empty token"
  exit 1
fi

python3 - "$ENV_FILE" "$TOKEN" <<'PY'
import re, sys
path, token = sys.argv[1], sys.argv[2]

with open(path) as f:
    lines = f.readlines()

def upsert(key, value):
    global lines
    pat = re.compile(rf"^{re.escape(key)}=")
    for i, line in enumerate(lines):
        if pat.match(line):
            lines[i] = f"{key}={value}\n"
            return
    lines.append(f"{key}={value}\n")

upsert("DISCORD_USER_TOKEN", token)
upsert("DISCORD_AUTH_MODE", "user")

with open(path, "w") as f:
    f.writelines(lines)
PY

chmod 600 "$ENV_FILE"
echo "OK: DISCORD_USER_TOKEN + DISCORD_AUTH_MODE=user saved to .env"

echo "Testing connection (10s)..."
cd "$ROOT/discord-listener"
timeout 12 node index.js 2>&1 | head -20 || true

echo
echo "If guild + channels look correct, enable service:"
echo "  sudo systemctl enable --now meridian-discord"