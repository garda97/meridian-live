#!/usr/bin/env python3
"""
Telegram alert sender for Meridian monitor
Reads alerts from monitor output and sends via Telegram API
"""

import json
import os
import sys
import subprocess
from datetime import datetime

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

def send_telegram(chat_id, token, message):
    """Send message via Telegram Bot API"""
    if not token or not chat_id:
        print("WARNING: Telegram credentials not configured")
        return False
    
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        import urllib.request
        import urllib.parse
        
        data = urllib.parse.urlencode({
            'chat_id': chat_id,
            'text': message,
            'parse_mode': 'Markdown'
        }).encode('utf-8')
        
        req = urllib.request.Request(url, data=data)
        response = urllib.request.urlopen(req, timeout=10)
        
        if response.status == 200:
            return True
    except Exception as e:
        print(f"ERROR sending Telegram: {e}")
    
    return False

def main():
    os.chdir('/opt/meridian')
    
    # Load env
    env = load_env('.env')
    chat_id = env.get('TELEGRAM_CHAT_ID', '590074898')
    token = env.get('TELEGRAM_BOT_TOKEN', '')
    
    # Run monitor
    result = subprocess.run(['python3', 'scripts/monitor_positions.py'], 
                          capture_output=True, text=True)
    
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    
    # If monitor found alerts (exit code 0), send Telegram
    if result.returncode == 0:
        # Parse alerts from output
        alerts = []
        for line in result.stdout.split('\n'):
            if line.startswith('  ') and ('❌' in line or '📈' in line or '📉' in line or 
                                         '⚠️' in line or '✅' in line or '💰' in line or 
                                         '🎯' in line or '🚨' in line):
                alerts.append(line.strip())
        
        if alerts and token:
            print("\n=== Sending Telegram Alerts ===")
            timestamp = datetime.utcnow().isoformat() + 'Z'
            
            for i, alert in enumerate(alerts, 1):
                msg = f"🤖 *Meridian Monitor* [{timestamp}]\n\n{alert}"
                
                if send_telegram(chat_id, token, msg):
                    print(f"✓ Alert {i}/{len(alerts)} sent")
                else:
                    print(f"✗ Alert {i}/{len(alerts)} failed")
            
            print(f"\nTotal alerts sent: {len(alerts)}")
    else:
        print("✓ No material changes detected (monitor silent)")
    
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(2)
