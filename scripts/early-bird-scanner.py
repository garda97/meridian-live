#!/usr/bin/env python3
"""
Meridian Early Bird Scanner
Scans Meteora for brand new pools and audits them via GMGN before they trend.
"""

import json
import subprocess
import sys
import time
from pathlib import Path
import urllib.parse
import urllib.request
import requests

# --- CONFIG ---
ROOT = Path(__file__).resolve().parent.parent
METEORA_API = "https://pool-discovery-api.datapi.meteora.ag/pools"
STATE_FILE = ROOT / ".early_bird_seen.txt"
MIN_TVL = 5000  # Filter out dust pools
MAX_POOLS_PER_TICK = 5
AUDIT_SCRIPT = ROOT / "scripts" / "meridian_gmgn_audit.py"

def get_seen_pools():
    if not STATE_FILE.exists():
        return set()
    return set(STATE_FILE.read_text().splitlines())

def mark_as_seen(pool_address):
    with open(STATE_FILE, "a") as f:
        f.write(f"{pool_address}\n")

def audit_token(mint):
    """Run full GMGN audit, return parsed dict (or None)."""
    try:
        result = subprocess.run(
            ["python3", str(AUDIT_SCRIPT), mint],
            capture_output=True,
            text=True,
            check=False,
            timeout=90
        )
        raw = result.stdout
        s = raw.find("{")
        if s < 0 or result.returncode != 0:
            return None
        return json.loads(raw[s:])
    except Exception as e:
        return None

def get_env_var(key):
    env_file = ROOT / ".env"
    try:
        for line in env_file.read_text().splitlines():
            if line.startswith(f"{key}="):
                v = line.split("=", 1)[1].strip()
                if v and not v.startswith("#"):
                    return v
    except Exception:
        pass
    return None

def send_telegram(message):
    bot = get_env_var("TELEGRAM_BOT_TOKEN")
    chat = get_env_var("TELEGRAM_CHAT_ID")
    if not bot or not chat:
        return False
    url = f"https://api.telegram.org/bot{bot}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": message,
        "parse_mode": "HTML",
    }).encode()
    try:
        with urllib.request.urlopen(url, data, timeout=10) as r:
            return r.status == 200
    except Exception:
        return False

def evaluate_clean(d):
    """Return (clean:bool, summary:str) using Meridian hard filters."""
    if not d:
        return False, "audit failed"
    a = d.get("audit", {})
    top10 = float(a.get("top10_pct") or 0)
    bots = float(a.get("bots_pct") or 0)
    fees = float(d.get("global_fees_sol") or 0)
    mcap = float(d.get("mcap") or 0)
    clean = (top10 < 30) and (bots < 25) and (fees >= 20) and (mcap >= 250000)
    summ = f"top10={top10:.1f}% bots={bots:.1f}% fees={fees:.0f}SOL mcap=${mcap:,.0f}"
    return clean, summ

def scan():
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Scanning Meteora for new pools...")
    
    params = {
        "page_size": MAX_POOLS_PER_TICK,
        "sort_by": "created_at:desc"
    }
    
    try:
        resp = requests.get(METEORA_API, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        
        pools = data.get("data", [])
        if not pools:
            print("  No pools found.")
            return

        seen = get_seen_pools()
        found_new = False

        for pool in pools:
            address = pool.get("pool_address")
            mint = pool.get("base_mint")
            tvl = float(pool.get("active_tvl", 0))
            
            if not address or not mint:
                continue
                
            if address in seen:
                continue
                
            # Filter: TVL must be above threshold to avoid noise
            if tvl < MIN_TVL:
                # print(f"  Skipping {mint[:6]}... (TVL ${tvl:.0f} < ${MIN_TVL})")
                continue

            found_new = True
            print(f"  ✨ NEW POOL: {mint[:8]}... | TVL: ${tvl:,.0f}")
            
            # Trigger Audit
            aud = audit_token(mint)
            clean, summ = evaluate_clean(aud)
            print(f"    Audit: {summ} -> {'CLEAN' if clean else 'skip'}")
            if clean:
                sym = (aud or {}).get("symbol", mint[:8])
                name = (aud or {}).get("name", "")
                msg = (
                    f"\U0001f195 <b>NEW POOL (clean audit) — Early Bird</b>\n"
                    f"{name} (${sym})\n"
                    f"CA: <code>{mint}</code>\n"
                    f"{summ}\n\n"
                    f"\u26a0\ufe0f Not auto-deployed. Owner review needed."
                )
                sent = send_telegram(msg)
                print(f"    [TG] clean-pool alert sent: {sent}")

            mark_as_seen(address)

        if not found_new:
            print("  No new qualify pools since last scan.")

    except Exception as e:
        print(f"  Error during scan: {e}")

if __name__ == "__main__":
    # To prevent duplicate runs if used in cron
    scan()
