#!/usr/bin/env bash
# Publish Meridian to a new GitHub repo under the authenticated account.
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./scripts/publish-to-github.sh [repo-name]
# Or create an empty repo on GitHub first, then:
#   ./scripts/publish-to-github.sh [repo-name] --push-only

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO_NAME="${1:-meridian-live}"
PUSH_ONLY=false
[[ "${2:-}" == "--push-only" ]] && PUSH_ONLY=true

GH_USER="${GH_USER:-garda97}"
REMOTE="git@github.com:${GH_USER}/${REPO_NAME}.git"

if ! $PUSH_ONLY; then
  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "GITHUB_TOKEN required to create repo (or use --push-only after creating empty repo on GitHub)."
    echo "Generate: https://github.com/settings/tokens (scope: repo)"
    exit 1
  fi
  echo "Creating ${GH_USER}/${REPO_NAME}..."
  gh auth login --with-token <<<"$GITHUB_TOKEN"
  gh repo create "${GH_USER}/${REPO_NAME}" --public --source="$ROOT" --remote=origin --push
  echo "Done: https://github.com/${GH_USER}/${REPO_NAME}"
  exit 0
fi

git remote set-url origin "$REMOTE"
git push -u origin main
echo "Pushed to https://github.com/${GH_USER}/${REPO_NAME}"