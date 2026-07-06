#!/bin/bash

# Meridian DLMM Position Monitor
# Monitor Telegram alerts untuk perubahan material pada DLMM positions

cd /opt/meridian

echo "=== MERIDIAN DLMM MONITOR ===" 
echo "Startup: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Load Telegram config
TELEGRAM_CHAT_ID=$(grep TELEGRAM_CHAT_ID .env | cut -d= -f2)
TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)

if [ -z "$TELEGRAM_CHAT_ID" ] || [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "WARNING: Telegram not configured"
  TELEGRAM_READY=0
else
  echo "Telegram configured: Chat ID ${TELEGRAM_CHAT_ID:0:10}..."
  TELEGRAM_READY=1
fi
echo ""

# Check state.json
if [ ! -f state.json ]; then
  echo "ERROR: state.json not found"
  exit 1
fi

echo "=== POSITION ANALYSIS ==="
echo ""

# Extract positions from state.json and analyze using jq
jq -r '.positions | to_entries[] | "\(.value.pool_name)|\(.value.deployed_at)|\(.value.peak_pnl_pct)|\(.value.trailing_active)|\(.value.closed)|\(.value.out_of_range_since // "null")"' state.json | while IFS='|' read -r pool_name deployed_at peak_pnl trailing closed oor_since; do
  
  echo "Position: $pool_name"
  echo "  Deployed: $deployed_at"
  echo "  Peak PnL: ${peak_pnl}%"
  echo "  Trailing: $trailing"
  echo "  Closed: $closed"
  echo "  Out of Range Since: $oor_since"
  echo ""
  
done

echo "=== MONITOR COMPLETE ==="
echo "Note: First run - no previous state available for delta detection"
echo ""

# Save current state for next run
cp state.json /tmp/meridian_monitor_state.json.new

# Log to monitor notes
{
  echo "## Monitor Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "Positions checked: $(jq '.positions | length' state.json)"
  echo "Telegram ready: $TELEGRAM_READY"
  echo ""
} >> notes/MONITOR.md

echo "Saved state snapshot to /tmp/meridian_monitor_state.json.new"
