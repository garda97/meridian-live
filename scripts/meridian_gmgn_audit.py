#!/usr/bin/env python3
"""
Unified GMGN holder/security audit via Meridian CLI (no gmgn-cli needed).

Usage:
  python3 scripts/meridian_gmgn_audit.py <MINT>
  python3 scripts/meridian_gmgn_audit.py <MINT> --compact
  python3 scripts/meridian_gmgn_audit.py --candidates --limit 5
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _run_json(cmd: list[str]) -> dict | list | None:
    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        print(err, file=sys.stderr)
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(proc.stdout, file=sys.stderr)
        return None


def audit_mint(mint: str, *, holder_limit: int = 10) -> dict:
    info = _run_json(["node", "cli.js", "token-info", "--query", mint])
    holders = _run_json([
        "node", "cli.js", "token-holders", "--mint", mint, "--limit", str(holder_limit),
    ])
    token = None
    if isinstance(info, dict) and info.get("results"):
        token = info["results"][0]

    holder_stats = holders if isinstance(holders, dict) else {}
    audit = token.get("audit") if token else {}

    return {
        "mint": mint,
        "symbol": token.get("symbol") if token else None,
        "mcap": token.get("mcap") if token else None,
        "holders": token.get("holders") if token else None,
        "global_fees_sol": token.get("global_fees_sol") if token else holder_stats.get("global_fees_sol"),
        "audit": {
            "top10_pct": audit.get("gmgn_top10_pct") or audit.get("top_holders_pct"),
            "bots_pct": audit.get("bot_holders_pct"),
            "gmgn_mint_renounced": audit.get("gmgn_mint_renounced"),
            "gmgn_freeze_renounced": audit.get("gmgn_freeze_renounced"),
            "gmgn_burn_status": audit.get("gmgn_burn_status"),
            "bundlers_pct_in_top_100": holder_stats.get("bundlers_pct_in_top_100"),
            "bundlers_in_top_100": holder_stats.get("bundlers_in_top_100"),
            "gmgn_smart_degen_count": holder_stats.get("gmgn_smart_degen_count"),
            "gmgn_sniper_count": holder_stats.get("gmgn_sniper_count"),
            "gmgn_dev_count": holder_stats.get("gmgn_dev_count"),
            "gmgn_dex_bot_count": holder_stats.get("gmgn_dex_bot_count"),
        },
        "gmgn_holder_tags": holder_stats.get("gmgn_holder_tags"),
        "top_holders_sample": holder_stats.get("gmgn_holders") or holder_stats.get("holders"),
        "source": "meridian+gmgn",
    }


def compact_line(payload: dict) -> str:
    a = payload.get("audit") or {}
    sym = payload.get("symbol") or payload.get("mint", "")[:8]
    return (
        f"{sym} | top10={a.get('top10_pct')}% | bots={a.get('bots_pct')}% "
        f"| bundlers={a.get('bundlers_pct_in_top_100')}% | sm={a.get('gmgn_smart_degen_count')} "
        f"| fees={payload.get('global_fees_sol')}SOL "
        f"| renounced={a.get('gmgn_mint_renounced')}/{a.get('gmgn_freeze_renounced')}"
    )


def candidates(limit: int) -> dict:
    raw = _run_json(["node", "cli.js", "candidates", "--limit", str(limit)])
    if not isinstance(raw, dict):
        return {"candidates": [], "error": "candidates lookup failed"}
    items = []
    for entry in raw.get("candidates") or []:
        token = entry.get("token") or {}
        audit = token.get("audit") or {}
        holders = entry.get("holders") or {}
        items.append({
            "pool": entry.get("pool"),
            "name": entry.get("name"),
            "mint": token.get("mint"),
            "organic_score": entry.get("organic_score"),
            "fee_tvl": entry.get("fee_active_tvl_ratio"),
            "audit": {
                "top10_pct": audit.get("top10_pct"),
                "bots_pct": audit.get("bots_pct"),
                "bundlers_pct_in_top_100": holders.get("bundlers_pct_in_top_100"),
                "gmgn_smart_degen_count": holders.get("gmgn_smart_degen_count"),
            },
        })
    return {"candidates": items, "total_screened": raw.get("total_screened")}


def main() -> int:
    parser = argparse.ArgumentParser(description="Meridian GMGN holder audit")
    parser.add_argument("mint", nargs="?", help="Token mint address")
    parser.add_argument("--compact", action="store_true", help="One-line summary")
    parser.add_argument("--candidates", action="store_true", help="Screened DLMM candidates with GMGN audit")
    parser.add_argument("--limit", type=int, default=5, help="Candidate limit (default 5)")
    parser.add_argument("--holder-limit", type=int, default=10, help="Top holders to sample")
    args = parser.parse_args()

    if args.candidates:
        payload = candidates(args.limit)
    elif args.mint:
        payload = audit_mint(args.mint, holder_limit=args.holder_limit)
    else:
        parser.error("Provide <MINT> or --candidates")

    if payload is None:
        return 1

    if args.compact and not args.candidates:
        print(compact_line(payload))
    else:
        print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())