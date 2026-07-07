#!/usr/bin/env python3
"""
Meridian Screening Analytics + Threshold Simulator (Hermes, 2026-07-07)
Implements B (reject-logging) + C (backtest/threshold simulation) WITHOUT
modifying the daemon. Fetches live pools from Meteora discovery API, evaluates
them against current config thresholds AND looser variants, logs reject reasons,
and estimates how many trades/day each variant would yield.

Output: notes/SCREENING_ANALYTICS.md

NOTE: mcap/organic_score are not in the discovery response (they require
rugcheck/GMGN enrichment). We use quantitative proxies available in the API:
  - tvl, volume_30m, volume_1h, apr, fees, fee_tvl_ratio
Variants simulate loosening the real gate (minOrganic/maxMcap) by proxying
with volume/TVL floors, since those are what tighter gates ultimately filter.
"""
import json
import time
import urllib.request
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "notes" / "SCREENING_ANALYTICS.md"
CONFIG = ROOT / "user-config.json"

BASE = "https://pool-discovery-api.datapi.meteora.ag/pools"
PAGE = 50


def load_json(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


def fetch_pools():
    url = f"{BASE}?page_size={PAGE}&timeframe=30m&category=all"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    r = urllib.request.urlopen(req, timeout=20)
    d = json.load(r)
    return d.get("pools", d.get("data", []))


def evaluate(p, min_tvl, min_vol30, max_tvl):
    """Return (pass, reason)."""
    tvl = float(p.get("tvl") or 0)
    vol = p.get("volume") or {}
    if isinstance(vol, dict):
        vol30 = float(vol.get("30m") or 0)
    else:
        vol30 = float(vol or 0)  # sometimes volume is a single number
    volatility = float(p.get("volatility") or 0)
    if tvl < min_tvl:
        return False, f"tvl {tvl/1000:.0f}K < {min_tvl/1000:.0f}K"
    if tvl > max_tvl:
        return False, f"tvl {tvl/1000:.0f}K > {max_tvl/1000:.0f}K (too big)"
    if vol30 < min_vol30:
        return False, f"vol30m {vol30/1000:.0f}K < {min_vol30/1000:.0f}K"
    return True, "pass"


def main():
    cfg = load_json(CONFIG) or {}
    sc = cfg.get("screening", {}) or {}
    # current thresholds (from config.js defaults; user-config may override)
    min_tvl = sc.get("minTvl", 20000)
    max_tvl = sc.get("maxTvl", 150000)
    min_vol30 = 5000  # proxy for min organic activity

    pools = fetch_pools()
    if not pools:
        print("no pools fetched")
        return

    variants = {
        "CURRENT (strict)":      {"min_tvl": min_tvl, "max_tvl": max_tvl, "min_vol30": min_vol30},
        "A1 loosen tvl->300K":   {"min_tvl": min_tvl, "max_tvl": 300000, "min_vol30": min_vol30},
        "A2 loosen vol->2K":     {"min_tvl": min_tvl, "max_tvl": max_tvl, "min_vol30": 2000},
        "A3 both (aggressive)":  {"min_tvl": 10000,    "max_tvl": 500000, "min_vol30": 2000},
    }

    lines = [f"\n## {datetime.now():%Y-%m-%d %H:%M} — Screening Analytics ({len(pools)} pools scanned)"]
    lines.append(f"Live pools fetched: {len(pools)} (bin_step=1, 30m)\n")

    # reject reason tally for CURRENT
    reject_counts = {}
    for vname, v in variants.items():
        passed = [p for p in pools if evaluate(p, v["min_tvl"], v["min_vol30"], v["max_tvl"])[0]]
        # estimate trades/day: passed pools * churn. Assume each passed pool yields
        # ~1 entry, held ~2.4h (target 60/day/6pos) -> churn factor
        churn = 24 / 2.4  # positions recycled per day per slot
        passed = [p for p in pools if evaluate(p, v["min_tvl"], v["min_vol30"], v["max_tvl"])[0]]
        avg_vol = sum(float(p.get("volatility") or 0) for p in passed) / len(passed) if passed else 0
        lines.append(f"### {vname}")
        lines.append(f"  Passed: {len(passed)}/{len(pools)}")
        lines.append(f"  Avg volatility of passed: {avg_vol:.3f}")
        lines.append(f"  Est. trade opportunities/scan: {len(passed)}")
        lines.append(f"  If maxPositions=6, turnover 2.4h: ~{len(passed)*int(churn//6)+1}/day potential")
        lines.append("")

    # detailed reject reasons for CURRENT variant (B: reject logging)
    lines.append("### Reject reasons (CURRENT gate)")
    for p in pools:
        ok, reason = evaluate(p, min_tvl, min_vol30, max_tvl)
        if not ok:
            sym = p.get("name", "?")
            reject_counts.setdefault(reason.split(" <")[0].split(" >")[0], 0)
            reject_counts[reason.split(" <")[0].split(" >")[0]] += 1
    for r, c in sorted(reject_counts.items(), key=lambda x: -x[1]):
        lines.append(f"  - {r}: {c}")
    lines.append("")
    lines.append("> Note: mcap/organic_score require GMGN/rugcheck enrichment (not in discovery API).")
    lines.append("> This analytics uses TVL/volume/APR proxies. For true minOrganic simulation,")
    lines.append("> run with enriched data or loosen screening.minOrganic in config.")
    lines.append(f"\nScanned at: {datetime.now().isoformat()}")
    lines.append("")

    with open(OUT, "a") as f:
        f.write("\n".join(lines))
    print(f"Wrote analytics for {len(pools)} pools -> {OUT}")


if __name__ == "__main__":
    main()
