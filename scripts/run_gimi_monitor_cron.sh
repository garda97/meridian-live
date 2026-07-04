#!/usr/bin/env bash
# GIMI Discover monitor — Tier 1 (HTTP API, no browser auth required).
# Cron example: 0 */6 * * * /root/meridian/scripts/run_gimi_monitor_cron.sh
set -euo pipefail

ROOT="/root/meridian"
LOG="${ROOT}/logs/gimi-monitor-cron.log"
mkdir -p "${ROOT}/logs" "${ROOT}/notes/gimi-challenges"

cd "${ROOT}"

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) gimi_monitor ==="
  python3 scripts/gimi_monitor.py --ongoing-only --export-signals
  python3 scripts/gimi_join.py --tags crypto-adjacent --max-joins 5 || true
  echo "=== done exit=$? ==="
  echo ""
} >> "${LOG}" 2>&1