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
    """Call the existing GMGN audit script."""
    try:
        result = subprocess.run(
            ["python3", str(AUDIT_SCRIPT), mint, "--compact"],
            capture_output=True,
            text=True,
            check=False
        )
        return result.stdout.strip() if result.returncode == 0 else "Audit failed"
    except Exception as e:
        return f"Error auditing: {e}"

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
            audit_res = audit_token(mint)
            print(f"    Audit: {audit_res}")
            
            mark_as_seen(address)

        if not found_new:
            print("  No new qualify pools since last scan.")

    except Exception as e:
        print(f"  Error during scan: {e}")

if __name__ == "__main__":
    # To prevent duplicate runs if used in cron
    scan()
