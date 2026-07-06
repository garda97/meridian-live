#!/usr/bin/env python3
"""Send alert to Telegram if configured."""

import json
import sys
import os
from pathlib import Path
from datetime import datetime

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
    """Send message to Telegram."""
    if not chat_id or not bot_token:
        return False
    
    import urllib.request
    import urllib.parse
    
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    data = urllib.parse.urlencode({
        'chat_id': chat_id,
        'text': message,
        'parse_mode': 'HTML'
    }).encode()
    
    try:
        with urllib.request.urlopen(url, data, timeout=10) as resp:
            result = json.loads(resp.read())
            return result.get('ok', False)
    except Exception as e:
        print(f"[ERROR] Telegram send failed: {e}", file=sys.stderr)
        return False

def main():
    if len(sys.argv) < 2:
        print("Usage: send_telegram_alert.py <alert_message>")
        sys.exit(1)
    
    alert = sys.argv[1]
    chat_id = get_env_var("TELEGRAM_CHAT_ID")
    bot_token = get_env_var("TELEGRAM_BOT_TOKEN")
    
    if not chat_id or not bot_token:
        print("[SKIP] Telegram not configured")
        return
    
    # Send
    if send_telegram(chat_id, bot_token, alert):
        print(f"[OK] Alert sent to Telegram")
    else:
        print(f"[FAIL] Could not send to Telegram")
    
    # Log to MONITOR.md
    log_file = "/opt/meridian/notes/MONITOR.md"
    Path("/opt/meridian/notes").mkdir(parents=True, exist_ok=True)
    
    with open(log_file, 'a') as f:
        f.write(f"\n{datetime.utcnow().isoformat()}Z | {alert}")

if __name__ == '__main__':
    main()
