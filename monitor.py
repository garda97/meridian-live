#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime
import subprocess

# 1. Load current state
state_file = Path('/root/meridian/state.json')
with open(state_file) as f:
    current_state = json.load(f)

print(f"[OK] State loaded: {len(current_state.get('positions', {}))} positions")

# 2. Load previous state
prev_state_file = Path('/tmp/meridian_monitor_state.json')
if prev_state_file.exists():
    with open(prev_state_file) as f:
        prev_state = json.load(f)
else:
    prev_state = {'positions': {}, 'last_check': None}

print(f"[OK] Previous state loaded")

# 3. Find OPEN positions
alerts = []
open_positions = {
    pos_id: p 
    for pos_id, p in current_state.get('positions', {}).items() 
    if not p.get('closed', False)
}

if not open_positions:
    print("[OK] No open positions to monitor")
else:
    print(f"[OK] Found {len(open_positions)} open positions")
    
    for pos_id, position in open_positions.items():
        prev_pos = prev_state.get('positions', {}).get(pos_id, {})
        symbol = position.get('pool_name', 'UNKNOWN')
        
        # Current state
        current_pnl_pct = position.get('current_pnl_pct', 0)
        prev_pnl_pct = prev_pos.get('pnl_pct', 0)
        current_out_of_range = position.get('out_of_range_since') is not None
        prev_out_of_range = prev_pos.get('out_of_range', False)
        
        # Check 1: PnL change > 0.5%
        pnl_delta = current_pnl_pct - prev_pnl_pct
        if abs(pnl_delta) > 0.5:
            emoji = "[UP]" if pnl_delta > 0 else "[DOWN]"
            alert = f"[{symbol}] {emoji} PnL {current_pnl_pct:+.2f}% (delta {pnl_delta:+.2f}%)"
            alerts.append(alert)
            print(f"  ALERT: {alert}")
        
        # Check 2: Out-of-range status
        if current_out_of_range != prev_out_of_range:
            if current_out_of_range:
                alert = f"[{symbol}] OUT OF RANGE | Perlu rebalance"
            else:
                alert = f"[{symbol}] BACK IN RANGE"
            alerts.append(alert)
            print(f"  ALERT: {alert}")

# 4. Get Telegram credentials
env_file = Path('/root/meridian/.env')
telegram_chat_id = None
telegram_bot_token = None

with open(env_file) as f:
    for line in f:
        if 'TELEGRAM_CHAT_ID=' in line:
            telegram_chat_id = line.split('=')[1].strip()
        if 'TELEGRAM_BOT_TOKEN=' in line:
            telegram_bot_token = line.split('=')[1].strip()

# 5. Send Telegram alerts (skip when paused — see .telegram_alerts_paused)
alerts_paused = Path('/root/meridian/.telegram_alerts_paused').exists()
if alerts_paused and alerts:
    print(f"[PAUSED] Telegram alerts disabled — {len(alerts)} alert(s) logged only")
    for alert in alerts:
        print(f"  [skipped] {alert}")
elif alerts and telegram_chat_id and telegram_bot_token and '***' not in telegram_bot_token:
    for alert in alerts:
        msg = f"Meridian DLMM: {alert}"
        cmd = ['curl', '-s', '-X', 'POST',
               f'https://api.telegram.org/bot{telegram_bot_token}/sendMessage',
               '-d', f'chat_id={telegram_chat_id}',
               '-d', f'text={msg}']
        result = subprocess.run(cmd, capture_output=True)
        print(f"  SENT: {alert[:40]}...")
else:
    if alerts:
        print(f"[WARN] Telegram not configured - {len(alerts)} alerts not sent")

# 6. Update state file
new_state = {
    'positions': {
        pos_id: {
            'pool_name': p.get('pool_name'),
            'closed': p.get('closed', False),
            'pnl_pct': p.get('current_pnl_pct', 0),
            'out_of_range': p.get('out_of_range_since') is not None
        }
        for pos_id, p in open_positions.items()
    },
    'last_check': datetime.now().isoformat()
}

with open(prev_state_file, 'w') as f:
    json.dump(new_state, f, indent=2)
print(f"[OK] State saved")

# 7. Log to MONITOR.md
monitor_file = Path('/root/meridian/notes/MONITOR.md')
monitor_file.parent.mkdir(parents=True, exist_ok=True)

with open(monitor_file, 'a') as f:
    f.write(f"\n### {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    if alerts:
        for alert in alerts:
            f.write(f"- {alert}\n")
    else:
        f.write("- (no material changes)\n")

print(f"[OK] Monitoring complete. {len(alerts)} alerts recorded.")
