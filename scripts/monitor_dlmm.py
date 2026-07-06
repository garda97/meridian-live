#!/usr/bin/env python3
"""
Meridian DLMM Position Monitor - Detect material changes and send Telegram alerts
"""

import json
import os
import sys
from datetime import datetime
import subprocess

def load_json(path):
    """Load JSON file safely"""
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except:
        return {}

def send_telegram(chat_id, token, message):
    """Send Telegram alert"""
    if not chat_id or not token:
        return False
    
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML"
        }
        # Use curl instead of requests to avoid dependencies
        cmd = [
            "curl", "-s", "-X", "POST", url,
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload)
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=10)
        resp = json.loads(result.stdout.decode() or '{}')
        return resp.get('ok', False)
    except Exception as e:
        print(f"ERROR sending Telegram: {e}", file=sys.stderr)
        return False

def main():
    print("=== MERIDIAN DLMM POSITION MONITOR ===")
    print(f"Time: {datetime.now().isoformat()}")
    print()
    
    # Paths
    state_file = '/opt/meridian/state.json'
    prev_state_file = '/tmp/meridian_monitor_state.json'
    monitor_log = '/opt/meridian/notes/MONITOR.md'
    env_file = '/opt/meridian/.env'
    
    # Load configs
    env_vars = {}
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                if '=' in line:
                    k, v = line.strip().split('=', 1)
                    env_vars[k] = v
    
    telegram_chat_id = env_vars.get('TELEGRAM_CHAT_ID', '')
    telegram_token = env_vars.get('TELEGRAM_BOT_TOKEN', '')
    
    print(f"Telegram: {'READY' if telegram_chat_id and telegram_token else 'NOT CONFIGURED'}")
    if telegram_chat_id:
        print(f"  Chat: {telegram_chat_id[:10]}...")
    print()
    
    # Load states
    curr_state = load_json(state_file)
    prev_state = load_json(prev_state_file)
    
    if not curr_state:
        print("ERROR: No current state found")
        return
    
    print(f"Positions in current state: {len(curr_state.get('positions', {}))}")
    print(f"Positions in previous state: {len(prev_state.get('positions', {}))}")
    print()
    
    # Analyze each position
    alerts = []
    current_positions = curr_state.get('positions', {})
    previous_positions = prev_state.get('positions', {})
    
    print("=== ANALYZING POSITIONS ===")
    print()
    
    for pos_id, pos_curr in current_positions.items():
        pool_name = pos_curr.get('pool_name', 'UNKNOWN')
        print(f"Position: {pool_name}")
        
        # Only monitor OPEN positions
        if pos_curr.get('closed', False):
            print(f"  Status: CLOSED (skipped)")
            continue
        
        print(f"  Status: OPEN")
        
        pos_prev = previous_positions.get(pos_id, {})
        
        # Extract metrics
        pnl_curr = float(pos_curr.get('peak_pnl_pct', 0))
        pnl_prev = float(pos_prev.get('peak_pnl_pct', 0)) if pos_prev else 0
        pnl_delta = pnl_curr - pnl_prev
        
        oor_curr = pos_curr.get('out_of_range_since') is not None
        oor_prev = pos_prev.get('out_of_range_since') is not None if pos_prev else False
        
        ts_curr = pos_curr.get('trailing_active', False)
        ts_prev = pos_prev.get('trailing_active', False) if pos_prev else False
        
        fees_curr = float(pos_curr.get('total_fees_claimed_usd', 0))
        fees_prev = float(pos_prev.get('total_fees_claimed_usd', 0)) if pos_prev else 0
        fees_delta = fees_curr - fees_prev
        
        # Check 1: Significant PnL change (>0.5%)
        if abs(pnl_delta) > 0.5:
            direction = "UP" if pnl_delta > 0 else "DOWN"
            alert = f"[{pool_name}] {direction} PnL {pnl_curr:+.2f}% | Delta {pnl_delta:+.2f}%"
            alerts.append(alert)
            print(f"  ALERT: {alert}")
        else:
            print(f"  PnL: {pnl_curr:+.2f}% (Delta {pnl_delta:+.2f}%)")
        
        # Check 2: Out of range status change
        if oor_curr != oor_prev:
            if oor_curr:
                alert = f"[{pool_name}] WARNING: OUT OF RANGE | Rebalance needed"
                print(f"  ALERT: {alert}")
            else:
                alert = f"[{pool_name}] OK: Back IN RANGE"
                print(f"  ALERT: {alert}")
            alerts.append(alert)
        
        # Check 3: Fee accumulation >$5
        if fees_curr > 5 and fees_delta > 0.1:
            alert = f"[{pool_name}] FEES: +${fees_delta:.2f} | Total ${fees_curr:.2f}"
            alerts.append(alert)
            print(f"  ALERT: {alert}")
        
        # Check 4: Trailing stop activation
        if ts_curr and not ts_prev:
            alert = f"[{pool_name}] TRAILING STOP: Activated"
            alerts.append(alert)
            print(f"  ALERT: {alert}")
        elif ts_curr:
            print(f"  INFO: Trailing stop active (ongoing)")
        
        print()
    
    # Report
    print("=== ALERT SUMMARY ===")
    print(f"Total alerts: {len(alerts)}")
    for alert in alerts:
        print(f"  > {alert}")
    print()
    
    # Send Telegram alerts (skip when paused — see .telegram_alerts_paused)
    alerts_paused = os.path.exists('/opt/meridian/.telegram_alerts_paused')
    if alerts_paused and alerts:
        print("=== TELEGRAM ALERTS PAUSED (.telegram_alerts_paused) ===")
        for alert in alerts:
            print(f"  [skipped] {alert}")
        print()
    elif alerts and telegram_chat_id and telegram_token:
        print("=== SENDING TELEGRAM ALERTS ===")
        
        for alert in alerts:
            # Format with HTML
            msg = f"<b>MERIDIAN ALERT</b>\n{alert}"
            
            success = send_telegram(telegram_chat_id, telegram_token, msg)
            status = "OK" if success else "FAILED"
            print(f"  [{status}] {alert[:60]}...")
        
        print()
    elif alerts:
        print("WARNING: Alerts generated but Telegram not configured")
        print()
    else:
        print("No material changes detected")
        print()
    
    # Log to monitor file
    try:
        with open(monitor_log, 'a') as f:
            f.write(f"\n## Monitor Run: {datetime.now().isoformat()}\n")
            f.write(f"Positions checked: {len(current_positions)}\n")
            f.write(f"Alerts sent: {len(alerts)}\n")
            if alerts:
                f.write("\n**Alerts:**\n")
                for alert in alerts:
                    f.write(f"- {alert}\n")
    except Exception as e:
        print(f"WARNING: Could not write to monitor log: {e}")
    
    # Save current state as previous for next run
    try:
        with open('/tmp/meridian_monitor_state.json', 'w') as f:
            json.dump(curr_state, f, indent=2)
        print("State snapshot saved for next run")
    except Exception as e:
        print(f"ERROR: Could not save state: {e}")

if __name__ == '__main__':
    main()
