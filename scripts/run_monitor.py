#!/usr/bin/env python3
"""
Complete Meridian DLMM position monitor.
- Detects material changes (PnL, OORange, fees, trailing stops)
- Logs to MONITOR.md
- Sends Telegram alerts if configured
"""

import json
import sys
import os
import subprocess
from pathlib import Path
from datetime import datetime

def load_state(filepath):
    """Load JSON state file."""
    if not Path(filepath).exists():
        return {}
    with open(filepath) as f:
        return json.load(f)

def get_env_var(key):
    """Extract from .env file."""
    env_file = "/opt/meridian/.env"
    try:
        with open(env_file) as f:
            for line in f:
                if line.startswith(f"{key}="):
                    val = line.split("=", 1)[1].strip()
                    if val and not val.startswith("#"):
                        return val
    except:
        pass
    return None

def send_telegram(chat_id, bot_token, message):
    """Send message to Telegram using curl."""
    if not chat_id or not bot_token:
        return False
    
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    cmd = [
        'curl', '-s',
        '-d', f'chat_id={chat_id}',
        '-d', f'text={message}',
        url
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            resp = json.loads(result.stdout)
            return resp.get('ok', False)
    except Exception as e:
        return False
    
    return False

def log_alert(alert_msg):
    """Append alert to MONITOR.md."""
    log_file = Path("/opt/meridian/notes/MONITOR.md")
    log_file.parent.mkdir(parents=True, exist_ok=True)
    
    # Initialize if not exists
    if not log_file.exists():
        with open(log_file, 'w') as f:
            f.write("# Meridian Position Monitor Log\n\n")
    
    # Append
    with open(log_file, 'a') as f:
        ts = datetime.utcnow().isoformat() + "Z"
        f.write(f"{ts} | {alert_msg}\n")

def main():
    # Load states
    current = load_state("/opt/meridian/state.json")
    if not current:
        print("[ERROR] Cannot load state.json")
        return 1
    
    prev = load_state("/tmp/meridian_monitor_state.json")
    
    # Detect alerts
    alerts = []
    
    # Check OPEN positions
    for pos_id, pos in current.get('positions', {}).items():
        if pos.get('closed'):
            continue
        
        pool = pos.get('pool_name', '?')
        prev_pos = prev.get('positions', {}).get(pos_id, {})
        
        # 1. Significant PnL change (>0.5%)
        prev_pnl = prev_pos.get('peak_pnl_pct', 0)
        curr_pnl = pos.get('peak_pnl_pct', 0)
        delta = curr_pnl - prev_pnl
        
        if abs(delta) > 0.5:
            if delta > 0:
                msg = f"[{pool}] PnL +{delta:.2f}% (peak {curr_pnl:.2f}%)"
                alerts.append(msg)
            else:
                msg = f"[{pool}] PnL {delta:.2f}% (peak {curr_pnl:.2f}%)"
                alerts.append(msg)
        
        # 2. Out-of-range transition
        prev_oor = prev_pos.get('out_of_range_since')
        curr_oor = pos.get('out_of_range_since')
        if prev_oor is None and curr_oor is not None:
            alerts.append(f"[{pool}] OUT OF RANGE - rebalance needed")
        
        # 3. Fee accumulation >$5
        prev_fee = prev_pos.get('total_fees_claimed_usd', 0)
        curr_fee = pos.get('total_fees_claimed_usd', 0)
        fee_delta = curr_fee - prev_fee
        if fee_delta > 5:
            alerts.append(f"[{pool}] Fees +${fee_delta:.1f} accumulated")
        
        # 4. Trailing stop activation
        if not prev_pos.get('trailing_active') and pos.get('trailing_active'):
            alerts.append(f"[{pool}] Trailing stop ACTIVATED")
        
        # 5. Pending exit
        if pos.get('pending_exit_action'):
            alerts.append(f"[{pool}] Pending exit: {pos['pending_exit_action']}")
    
    # Check closed positions (newly closed)
    for pos_id, prev_pos in prev.get('positions', {}).items():
        curr_pos = current.get('positions', {}).get(pos_id, {})
        if not prev_pos.get('closed') and curr_pos.get('closed'):
            pool = curr_pos.get('pool_name', '?')
            pnl = curr_pos.get('peak_pnl_pct', 0)
            alerts.append(f"[{pool}] CLOSED | PnL: {pnl:.2f}%")
    
    # Save current state
    snapshot = {
        'timestamp': current.get('lastUpdated'),
        'positions': {}
    }
    for pos_id, pos in current.get('positions', {}).items():
        snapshot['positions'][pos_id] = {
            'pool_name': pos.get('pool_name'),
            'peak_pnl_pct': pos.get('peak_pnl_pct'),
            'out_of_range_since': pos.get('out_of_range_since'),
            'trailing_active': pos.get('trailing_active'),
            'pending_exit_action': pos.get('pending_exit_action'),
            'total_fees_claimed_usd': pos.get('total_fees_claimed_usd'),
            'closed': pos.get('closed')
        }
    
    with open('/tmp/meridian_monitor_state.json', 'w') as f:
        json.dump(snapshot, f, indent=2)
    
    # Report
    ts = datetime.utcnow().isoformat() + "Z"
    print(f"[Monitor] {ts} | {len(alerts)} alert(s)")
    
    if not alerts:
        return 0
    
    # Process alerts
    chat_id = get_env_var("TELEGRAM_CHAT_ID")
    bot_token = get_env_var("TELEGRAM_BOT_TOKEN")
    
    alerts_paused = Path('/opt/meridian/.telegram_alerts_paused').exists()
    for alert in alerts:
        print(f"  {alert}")
        log_alert(alert)
        
        # Try to send to Telegram
        if alerts_paused:
            print(f"    -> Telegram skipped (alerts paused)")
        elif chat_id and bot_token:
            if send_telegram(chat_id, bot_token, alert):
                print(f"    -> Telegram sent")
    
    return 0

if __name__ == '__main__':
    sys.exit(main())
