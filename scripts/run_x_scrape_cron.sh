#!/usr/bin/env bash
# Daily X LP scrape for Hermes knowledge base.
# Cron: 0 5 * * * /opt/meridian/scripts/run_x_scrape_cron.sh
set -euo pipefail

ROOT="/opt/meridian"
LOG="${ROOT}/logs/x-scrape-cron.log"
mkdir -p "${ROOT}/logs" "${ROOT}/notes/x-scrape"

cd "${ROOT}"

EXTRA=()
# Sunday UTC: resolve threads + pinned (fuller digest for weekly review)
if [ "$(date -u +%u)" = "7" ]; then
  EXTRA+=(--threads)
fi

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) x_scrape_lp ${EXTRA[*]:-} ==="
  python3 scripts/x_scrape_lp.py "${EXTRA[@]}"
  echo "=== done exit=$? ==="
  echo ""
} >> "${LOG}" 2>&1