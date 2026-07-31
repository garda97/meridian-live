#!/usr/bin/env python3
"""Analyze Meridian closed-position post-mortems to extract winning patterns.

Parses notes/LESSONS_LEARNED.md (lines like:
  - **TOKEN** (strategy) — PnL +X% | mcap $Y.YYM | TVL $ZK | organic N | fee/TVL F | reason: ...
) and computes:
  - win rate, avg PnL overall and by strategy
  - PnL by mcap bucket
  - fee/TVL threshold that separates profit vs loss
  - organic% correlation
Outputs a structured summary Hermes/Claude can turn into config rules.
"""
import re
import json
import sys
from collections import defaultdict

PATH = "notes/LESSONS_LEARNED.md"

LINE_RE = re.compile(
    r"-\s+\*\*(?P<tok>[^*?]+|\?)\*\*\s*\((?P<strat>\w+)\)\s*—\s*"
    r"PnL\s*(?P<pnl>[+-]?[\d.]+)%\s*\|\s*"
    r"mcap\s*\$(?P<mcap>[\d.]+)(?P<mcapu>[MK])\s*\|\s*"
    r"TVL\s*\$(?P<tvl>[\d.]+)(?P<tvlu>[MK])\s*\|\s*"
    r"organic\s*(?P<org>\d+|None)\s*\|\s*"
    r"fee/TVL\s*(?P<fee>[\d.]+|None)"
)

def to_num(v, unit):
    v = float(v)
    if unit == "M":
        return v * 1_000_000
    if unit == "K":
        return v * 1_000
    return v

def mcap_bucket(m):
    if m < 500_000:
        return "<0.5M"
    if m < 1_000_000:
        return "0.5-1M"
    if m < 3_000_000:
        return "1-3M"
    if m < 10_000_000:
        return "3-10M"
    return ">10M"

def main():
    rows = []
    with open(PATH) as f:
        for line in f:
            m = LINE_RE.search(line)
            if not m:
                continue
            tok = m.group("tok").strip()
            strat = m.group("strat")
            pnl = float(m.group("pnl"))
            mcap = to_num(m.group("mcap"), m.group("mcapu"))
            tvl = to_num(m.group("tvl"), m.group("tvlu"))
            org = None if m.group("org") == "None" else int(m.group("org"))
            fee = None if m.group("fee") == "None" else float(m.group("fee"))
            rows.append(dict(tok=tok, strat=strat, pnl=pnl, mcap=mcap,
                             tvl=tvl, org=org, fee=fee,
                             bucket=mcap_bucket(mcap)))

    if not rows:
        print("NO DATA PARSED")
        return

    n = len(rows)
    wins = [r for r in rows if r["pnl"] > 0]
    losses = [r for r in rows if r["pnl"] < 0]
    flat = [r for r in rows if r["pnl"] == 0]
    avg_pnl = sum(r["pnl"] for r in rows) / n

    print(f"=== TOTAL POSITIONS ANALYZED: {n} ===")
    print(f"Wins: {len(wins)} ({len(wins)*100/n:.0f}%)  "
          f"Losses: {len(losses)} ({len(losses)*100/n:.0f}%)  "
          f"Flat: {len(flat)}")
    print(f"Avg PnL: {avg_pnl:+.2f}%   "
          f"Median PnL: {sorted(r['pnl'] for r in rows)[n//2]:+.2f}%")
    big = [r for r in rows if r["pnl"] >= 10]
    big_str = ", ".join(f"{r['tok']}({r['pnl']:.0f}%)" for r in big[:8])
    print(f"Big winners (>=10%): {len(big)} -> {big_str}")

    # By strategy
    print("\n=== BY STRATEGY ===")
    by_strat = defaultdict(list)
    for r in rows:
        by_strat[r["strat"]].append(r)
    for s, rs in sorted(by_strat.items(), key=lambda kv: -sum(r['pnl'] for r in kv[1])/len(kv[1])):
        ns = len(rs)
        wp = sum(1 for r in rs if r['pnl'] > 0)*100/ns
        ap = sum(r['pnl'] for r in rs)/ns
        print(f"  {s:8} n={ns:3}  winrate={wp:3.0f}%  avgPnL={ap:+.2f}%")

    # By mcap bucket
    print("\n=== BY MCAP BUCKET ===")
    by_b = defaultdict(list)
    for r in rows:
        by_b[r["bucket"]].append(r)
    for b in ["<0.5M", "0.5-1M", "1-3M", "3-10M", ">10M"]:
        rs = by_b.get(b, [])
        if not rs:
            continue
        ns = len(rs)
        wp = sum(1 for r in rs if r['pnl'] > 0)*100/ns
        ap = sum(r['pnl'] for r in rs)/ns
        print(f"  {b:8} n={ns:3}  winrate={wp:3.0f}%  avgPnL={ap:+.2f}%")

    # fee/TVL split (only rows with fee known)
    print("\n=== fee/TVL CORRELATION (avg PnL by fee/TVL bucket) ===")
    fee_rows = [r for r in rows if r["fee"] is not None]
    if fee_rows:
        fb = defaultdict(list)
        for r in fee_rows:
            if r["fee"] < 0.2: fb["<0.2"].append(r)
            elif r["fee"] < 0.5: fb["0.2-0.5"].append(r)
            elif r["fee"] < 1.0: fb["0.5-1.0"].append(r)
            else: fb[">=1.0"].append(r)
        for k in ["<0.2", "0.2-0.5", "0.5-1.0", ">=1.0"]:
            rs = fb.get(k, [])
            if not rs:
                continue
            ap = sum(r['pnl'] for r in rs)/len(rs)
            print(f"  fee/TVL {k:8} n={len(rs):3}  avgPnL={ap:+.2f}%")

    # organic split
    print("\n=== ORGANIC% CORRELATION ===")
    org_rows = [r for r in rows if r["org"] is not None]
    if org_rows:
        ob = defaultdict(list)
        for r in org_rows:
            ob["<75" if r["org"] < 75 else "75-85" if r["org"] <= 85 else ">85"].append(r)
        for k in ["<75", "75-85", ">85"]:
            rs = ob.get(k, [])
            if not rs:
                continue
            ap = sum(r['pnl'] for r in rs)/len(rs)
            print(f"  organic {k:5} n={len(rs):3}  avgPnL={ap:+.2f}%")

    # Best token profiles (winners only, with full data)
    print("\n=== TOP PROFITABLE PROFILES (winners w/ full metrics) ===")
    good = [r for r in wins if r["fee"] is not None and r["org"] is not None]
    good.sort(key=lambda r: r["pnl"], reverse=True)
    for r in good[:10]:
        print(f"  {r['tok']:14} {r['strat']:7} pnl={r['pnl']:+.2f}% "
              f"mcap=${r['mcap']/1e6:.2f}M org={r['org']} fee/TVL={r['fee']}")

    # Rules suggestion
    print("\n=== SUGGESTED RULES (from data) ===")
    # profitable mcap buckets
    prof_b = [b for b in ["<0.5M","0.5-1M","1-3M","3-10M",">10M"] if b in by_b and sum(r['pnl'] for r in by_b[b])/len(by_b[b]) > 0]
    print(f"  Profitable mcap buckets: {prof_b}")
    # fee/TVL threshold
    if fee_rows:
        prof_fee = [k for k in ["<0.2","0.2-0.5","0.5-1.0",">=1.0"] if k in fb and sum(r['pnl'] for r in fb[k])/len(fb[k]) > 0]
        print(f"  Profitable fee/TVL buckets: {prof_fee}")
    # strategy ranking
    best_strat = max(by_strat.items(), key=lambda kv: sum(r['pnl'] for r in kv[1])/len(kv[1]))
    print(f"  Best strategy by avg PnL: {best_strat[0]} ({sum(r['pnl'] for r in best_strat[1])/len(best_strat[1]):+.2f}%)")

    # dump JSON for downstream
    out = dict(n=n, winrate=len(wins)*100/n, avg_pnl=avg_pnl,
               by_strat={k: dict(n=len(v), avg=sum(r['pnl'] for r in v)/len(v)) for k,v in by_strat.items()},
               by_bucket={k: dict(n=len(v), avg=sum(r['pnl'] for r in v)/len(v)) for k,v in by_b.items()})
    with open("notes/lp_outcome_analysis.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\n[written] notes/lp_outcome_analysis.json")

if __name__ == "__main__":
    main()
