#!/usr/bin/env python3
"""
metlex_poll.py — Poll Metlex Terminal Telegram channel for "New DLMM Found" signals.
Reads CA + metrics, writes to metlex-signals.json for Meridian bot to consume as candidate feed.

Usage:
  python3 metlex_poll.py            # one-shot poll (new messages since last run)
  python3 metlex_poll.py --backfill 50   # fetch last 50 messages (first run / re-seed)

Requires: telethon, valid session at /root/.config/screening_g97/solhouse.session
Creds loaded from /root/.config/screening_g97/secrets/telegram_user.json
"""
import asyncio, json, re, sys, os
from datetime import datetime, timezone

SECRETS = "/root/.config/screening_g97/secrets/telegram_user.json"
SESSION = "/root/.config/screening_g97/solhouse.session"
CHANNEL = -1002381320790  # Metlex Terminal
OUT = "/opt/meridian/metlex-signals.json"
STATE = "/opt/meridian/metlex-state.json"

# Solana CA = base58, 32-44 chars
CA_RE = re.compile(r'\b([1-9A-HJ-NP-Za-km-z]{32,44})\b')
NUM_RE = re.compile(r'([0-9][0-9.,]*[KMBkmb]?)')

def parse_msg(text, entities=None):
    """Parse a Metlex 'New DLMM Found' message into structured dict.
    CA is extracted from URL entities (gmgn/jup/rugcheck) since the inline text is truncated."""
    if "New DLMM Found" not in text:
        return None
    ca = None
    # 1) try URL entities (most reliable — full CA present)
    if entities:
        for e in entities:
            url = getattr(e, "url", None)
            if url:
                for pat in (r"gmgn\.ai/sol/token/[A-Za-z0-9_]*_([1-9A-HJ-NP-Za-km-z]{32,44})",
                            r"(?:jup\.ag|rugcheck\.xyz|dexscreener\.com|axiom\.trade|app\.meteora\.ag|edge\.meteora\.ag)/[^\s/]*?([1-9A-HJ-NP-Za-km-z]{32,44})"):
                    mm = re.search(pat, url)
                    if mm:
                        ca = mm.group(1)
                        break
            if ca:
                break
    # 2) fallback: any base58 token in text
    if not ca:
        m = CA_RE.search(text)
        if not m:
            return None
        ca = m.group(1)
    # token name + symbol: line like "Loom (Loom) • Age: 5h"
    name = None
    sym = None
    age = None
    nm = re.search(r'([A-Za-z0-9 ]+?)\s*\(([A-Za-z0-9]+)\)\s*•\s*Age:\s*([0-9]+[mhd]?)', text)
    if nm:
        name = nm.group(1).strip()
        sym = nm.group(2).strip()
        age = nm.group(3)
    # metrics
    def grab(label):
        mm = re.search(rf'{label}[:\s]*\$?([0-9][0-9.,]*[KMBkmb]?)', text)
        return mm.group(1) if mm else None
    mc = grab(r'MC')
    liq = grab(r'LIQ')
    vol = grab(r'VOL')
    th = grab(r'TH')  # top holder %
    holders = None
    hm = re.search(r'Holders:\s*([0-9][0-9.,]*[KMBkmb]?)', text)
    if hm:
        holders = hm.group(1)
    org = None
    om = re.search(r'Organic\s*([0-9]+)', text)
    if om:
        org = int(om.group(1))
    return {
        "address": ca,
        "name": name,
        "symbol": sym,
        "age": age,
        "mc": mc,
        "liq": liq,
        "vol": vol,
        "top_holder_pct": th,
        "holders": holders,
        "organic": org,
    }

def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"last_id": 0}

def save_state(s):
    with open(STATE, "w") as f:
        json.dump(s, f)

def load_existing():
    try:
        return json.load(open(OUT))
    except Exception:
        return []

async def main():
    creds = json.load(open(SECRETS))
    api_id = creds["api_id"]; api_hash = creds["api_hash"]
    from telethon import TelegramClient
    client = TelegramClient(SESSION, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        print("SESSION_EXPIRED"); await client.disconnect(); return
    entity = await client.get_entity(CHANNEL)
    backfill = False
    for a in sys.argv[1:]:
        if a.startswith("--backfill"):
            backfill = True
    state = load_state()
    existing = load_existing()
    existing_cas = {e["address"] for e in existing}
    new_entries = []
    if backfill:
        msgs = []
        async for msg in client.iter_messages(entity, limit=int(sys.argv[sys.argv.index("--backfill")+1]) if "--backfill" in sys.argv else 50):
            msgs.append(msg)
        msgs.reverse()
    else:
        msgs = []
        async for msg in client.iter_messages(entity, limit=50):
            if msg.id <= state["last_id"]:
                break
            msgs.append(msg)
        msgs.reverse()
    max_id = state["last_id"]
    for msg in msgs:
        parsed = parse_msg(msg.message or "", getattr(msg, "entities", None))
        if parsed and parsed["address"] not in existing_cas:
            parsed["ts"] = msg.date.strftime("%Y-%m-%dT%H:%M:%SZ")
            parsed["msg_id"] = msg.id
            new_entries.append(parsed)
            existing_cas.add(parsed["address"])
            max_id = max(max_id, msg.id)
    if not backfill:
        state["last_id"] = max_id
        save_state(state)
    # merge: prepend new, keep last 200
    merged = new_entries + existing
    merged = merged[:200]
    with open(OUT, "w") as f:
        json.dump(merged, f, indent=1)
    print(f"Added {len(new_entries)} new Metlex signals. Total tracked: {len(merged)}")
    for e in new_entries[:10]:
        print(f"  {e['symbol'] or e['name']} | {e['address']} | MC {e['mc']} LIQ {e['liq']} TH {e['top_holder_pct']} Org {e['organic']}")
    await client.disconnect()

asyncio.run(main())
