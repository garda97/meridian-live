#!/usr/bin/env python3
"""
Meridian DLMM Position Monitor
- Tracks open positions for material changes
- Sends Telegram alerts on thresholds
- Logs all activity to notes/MONITOR.md
"""

import json
import os
from datetime import datetime
import sys

def load_json(filepath):
    """Safely load JSON file"""
    try:
        with open(filepath, 'r') as f:
            return json.load(f)
    except:
        return {}

def save_json(filepath, data):
    """Save JSON file"""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2)

def load_env(filepath):
    """Load .env file"""
    env = {}
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                for line in f:
                    if '=' in line and not line.startswith('#'):
                        key, val = line.strip().split('=', 1)
                        env[key] = val.strip('\'"')
        except:
            pass
    return env

def analyze_positions(current, previous):
    """Compare current vs previous state, return list of material changes"""
    
    alerts = []
    material_changes = []
    
    current_positions = current.get('positions', {})
    prev_positions = previous.get('positions', {})
    
    for pos_id, pos in current_positions.items():
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
        
        # Position closure
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
            
            # Stop loss (negative PnL threshold)
            if current_pnl < -15:
                alert = f"🚨 [STOP LOSS] {pool_name} hit {current_pnl:.1f}%"
                alerts.append(alert)
                material_changes.append(alert)
    
    return material_changes, alerts

def create_snapshot(positions):
    """Create a minimal snapshot of positions for comparison"""
    snapshot = {}
    for pos_id, pos in positions.items():
        snapshot[pos_id] = {
            'pool_name': pos.get('pool_name'),
            'peak_pnl_pct': pos.get('peak_pnl_pct', 0),
            'out_of_range_since': pos.get('out_of_range_since'),
            'trailing_active': pos.get('trailing_active', False),
            'pending_exit_action': pos.get('pending_exit_action'),
            'total_fees_claimed_usd': pos.get('total_fees_claimed_usd', 0),
            'closed': pos.get('closed', False)
        }
    return snapshot

def append_log(filepath, content):
    """Append content to log file"""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'a') as f:
        f.write(content)

def main():
    os.chdir('/root/meridian')
    
    # Files
    state_file = "state.json"
    prev_state_file = "/tmp/meridian_monitor_state.json"
    monitor_log = "notes/MONITOR.md"
    env_file = ".env"
    
    print("=== MERIDIAN DLMM POSITION MONITOR ===")
    timestamp = datetime.utcnow().isoformat() + 'Z'
    print(f"Timestamp: {timestamp}\n")
    
    # Load data
    current_state = load_json(state_file)
    prev_state = load_json(prev_state_file)
    env = load_env(env_file)
    
    if not current_state:
        print("ERROR: Cannot load state.json")
        return 1
    
    # Analyze
    current_positions = current_state.get('positions', {})
    prev_positions = prev_state.get('positions', {})
    
    open_count = len([p for p in current_positions.values() if not p.get('closed', False)])
    closed_count = len([p for p in current_positions.values() if p.get('closed', False)])
    
    print(f"OPEN POSITIONS: {open_count}")
    print(f"CLOSED POSITIONS: {closed_count}")
    
    # Detect changes
    material_changes, alerts = analyze_positions(current_state, prev_state)
    
    print(f"MATERIAL CHANGES: {len(material_changes)}")
    if material_changes:
        print("\nAlerts detected:")
        for alert in material_changes:
            print(f"  {alert}")
    else:
        print("\n  (none - stable)")
    
    # Save snapshot
    snapshot = {
        'timestamp': timestamp,
        'positions': create_snapshot(current_positions)
    }
    save_json(prev_state_file, snapshot)
    print(f"\n✓ State snapshot saved")
    
    # Update log
    summary = f"\n## [{timestamp}] Monitor Cycle\n\n"
    summary += f"- Open positions: {open_count}\n"
    summary += f"- Closed positions: {closed_count}\n"
    summary += f"- Material changes: {len(material_changes)}\n"
    summary += f"- Alert status: {'🚨 ALERTS' if material_changes else '[SILENT]'}\n"
    
    if material_changes:
        summary += "\n**Alerts:**\n"
        for alert in material_changes:
            summary += f"- {alert}\n"
    else:
        summary += "\n**Status:** All positions stable | No alerts required\n"
    
    append_log(monitor_log, summary)
    print("✓ Monitor log updated")
    
    # Return code: 0 if alerts, 1 if silent
    return 0 if material_changes else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
