#!/bin/bash

set -e

cd /opt/meridian

STATE_FILE="state.json"
PREV_STATE_FILE="/tmp/meridian_monitor_state.json"
MONITOR_LOG="notes/MONITOR.md"
ENV_FILE=".env"

# Load env vars
TELEGRAM_CHAT_ID=590074898
TELEGRAM_BOT_TOKEN=""

if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE" 2>/dev/null || true
fi

echo "=== MERIDIAN DLMM POSITION MONITOR ==="
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "Timestamp: $NOW"

# Check if state.json exists and has positions
if [ ! -f "$STATE_FILE" ]; then
    echo "ERROR: state.json not found"
    exit 1
fi

# Use Python for JSON parsing
python3 - << 'PYEOF'
import json
import sys
from datetime import datetime
import os
import subprocess

state_file = "state.json"
prev_state_file = "/tmp/meridian_monitor_state.json"
monitor_log = "notes/MONITOR.md"

# Load current state
with open(state_file, 'r') as f:
    current_state = json.load(f)

# Load previous state
prev_state = {}
if os.path.exists(prev_state_file):
    with open(prev_state_file, 'r') as f:
        prev_state = json.load(f)

print("\n=== POSITION ANALYSIS ===")

positions = current_state.get('positions', {})
open_positions = [p for p in positions.values() if not p.get('closed', False)]
closed_positions = [p for p in positions.values() if p.get('closed', False)]

print(f"OPEN POSITIONS: {len(open_positions)}")
print(f"CLOSED POSITIONS: {len(closed_positions)}")

prev_positions = prev_state.get('positions', {})

alerts = []
material_changes = []

for pos_id, pos in positions.items():
    pool_name = pos.get('pool_name', 'UNKNOWN')
    closed = pos.get('closed', False)
    current_pnl = pos.get('peak_pnl_pct', 0)
    current_oor = pos.get('out_of_range_since')
    current_fees = pos.get('total_fees_claimed_usd', 0)
    current_trailing = pos.get('trailing_active', False)
    
    prev_pos = prev_positions.get(pos_id, {})
    prev_pnl = prev_pos.get('peak_pnl_pct', 0)
    prev_oor = prev_pos.get('out_of_range_since')
    prev_fees = prev_pos.get('total_fees_claimed_usd', 0)
    prev_trailing = prev_pos.get('trailing_active', False)
    prev_closed = prev_pos.get('closed', False)
    
    # Check position closure
    if closed and not prev_closed:
        notes = pos.get('notes', [])
        note_text = f" | {notes[-1]}" if notes else ""
        alert = f"❌ [{pool_name}] Position CLOSED{note_text}"
        alerts.append(alert)
        material_changes.append(alert)
    
    # Only check following for OPEN positions
    if not closed:
        # PnL change > 0.5%
        pnl_delta = abs(current_pnl - prev_pnl)
        if pnl_delta > 0.5:
            sign = "📈" if current_pnl > prev_pnl else "📉"
            alert = f"{sign} [{pool_name}] PnL {current_pnl:+.2f}% | Δ {pnl_delta:+.2f}%"
            alerts.append(alert)
            material_changes.append(alert)
        
        # Out-of-range status change
        oor_changed = (current_oor is None) != (prev_oor is None)
        if oor_changed:
            if current_oor is not None:
                alert = f"⚠️ [{pool_name}] OUT OF RANGE | Perlu rebalance"
            else:
                alert = f"✅ [{pool_name}] Back IN RANGE"
            alerts.append(alert)
            material_changes.append(alert)
        
        # Fee accumulation > $5
        fee_delta = current_fees - prev_fees
        if fee_delta > 5:
            alert = f"💰 [{pool_name}] Fees +${fee_delta:.2f} | Ready to claim"
            alerts.append(alert)
            material_changes.append(alert)
        
        # Trailing stop activation
        if current_trailing and not prev_trailing:
            alert = f"🎯 [{pool_name}] Trailing Stop ACTIVATED"
            alerts.append(alert)
            material_changes.append(alert)
        
        # Stop loss
        if current_pnl < -15:
            alert = f"🚨 [STOP LOSS] {pool_name} hit {current_pnl:.1f}%"
            alerts.append(alert)
            material_changes.append(alert)

print(f"MATERIAL CHANGES: {len(material_changes)}")
if alerts:
    print("\nAlerts:")
    for alert in alerts:
        print(f"  {alert}")
        
# Save current state to prev_state file
new_prev_state = {
    'timestamp': datetime.utcnow().isoformat() + 'Z',
    'positions': {}
}

for pos_id, pos in positions.items():
    new_prev_state['positions'][pos_id] = {
        'pool_name': pos.get('pool_name'),
        'peak_pnl_pct': pos.get('peak_pnl_pct', 0),
        'out_of_range_since': pos.get('out_of_range_since'),
        'trailing_active': pos.get('trailing_active', False),
        'pending_exit_action': pos.get('pending_exit_action'),
        'total_fees_claimed_usd': pos.get('total_fees_claimed_usd', 0),
        'closed': pos.get('closed', False)
    }

with open(prev_state_file, 'w') as f:
    json.dump(new_prev_state, f, indent=2)

print(f"\nState saved to {prev_state_file}")

# Update monitor log
timestamp = datetime.utcnow().isoformat() + 'Z'
summary = f"\n## [{timestamp}] Monitor Cycle\n\n"
summary += f"- Open positions: {len(open_positions)}\n"
summary += f"- Closed positions: {len(closed_positions)}\n"
summary += f"- Material changes: {len(material_changes)}\n"
summary += f"- Alert status: {'🚨 ALERTS SENT' if material_changes else '[SILENT]'}\n"

if material_changes:
    summary += "\n**Alerts:**\n"
    for alert in material_changes:
        summary += f"- {alert}\n"
else:
    summary += "\n**Status:** All positions stable | No alerts required\n"

with open(monitor_log, 'a') as f:
    f.write(summary)

print("Log updated.")

# Output alerts for parent script to send via Telegram
if material_changes:
    print("\n=== ALERTS TO SEND ===")
    for alert in material_changes:
        print(alert)
    sys.exit(0)
else:
    print("\n✓ No alerts to send (status stable)")
    sys.exit(1)

PYEOF

exit_code=$?
if [ $exit_code -ne 1 ]; then
    # Alerts were detected, send them
    echo ""
    echo "=== Sending Telegram Alerts ==="
    # The alerts are already printed above by Python script
fi
