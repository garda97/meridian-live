#!/usr/bin/env bash
# Store GIMI Clerk/API Bearer token for auto-join.
# Usage:
#   ./scripts/set-gimi-session.sh              # prompts (hidden)
#   ./scripts/set-gimi-session.sh <token>      # non-interactive

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SECRET_FILE="${HOME}/.meridian/secrets/gimi.session"

TOKEN="${1:-}"
if [[ -z "$TOKEN" ]]; then
  read -rsp "Paste GIMI Bearer token (from DevTools → Network → Authorization): " TOKEN
  echo
fi

TOKEN="$(echo "$TOKEN" | sed 's/^Bearer[[:space:]]*//i' | tr -d '[:space:]')"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: empty token"
  exit 1
fi

mkdir -p "$(dirname "$SECRET_FILE")"
chmod 700 "$(dirname "$SECRET_FILE")"
printf '%s' "$TOKEN" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

if [[ -f "$ENV_FILE" ]]; then
  python3 - "$ENV_FILE" "$TOKEN" <<'PY'
import re, sys
path, token = sys.argv[1], sys.argv[2]
with open(path) as f:
    lines = f.readlines()
pat = re.compile(r'^GIMI_SESSION_TOKEN=')
found = False
for i, line in enumerate(lines):
    if pat.match(line):
        lines[i] = f'GIMI_SESSION_TOKEN={token}\n'
        found = True
        break
if not found:
    lines.append(f'GIMI_SESSION_TOKEN={token}\n')
with open(path, 'w') as f:
    f.writelines(lines)
PY
fi

echo "OK — token saved to $SECRET_FILE"
echo "Test: python3 scripts/gimi_join.py --dry-run"