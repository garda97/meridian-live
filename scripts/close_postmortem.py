#!/usr/bin/env python3
"""
Meridian Close-Position Post-Mortem (Hermes, 2026-07-07)
Runs on a schedule; detects newly-closed DLMM positions in state.json,
extracts entry/exit metrics, and appends a lesson to notes/LESSONS_LEARNED.md.

PnL source: prefers state.json pnl_pct, falls back to decision-log close entries
(e.g. "Closed externally at 4.17%"). Positions without any PnL are marked "pending".

When >=5 closed positions WITH PnL exist, prints a correlation summary
(no auto config change — owner reviews, then tunes manually).

Does NOT deploy, close, or modify config. Read-only analysis + append to notes.

IMPORTANT: only logs positions not yet seen (tracked in .postmortem_seen.json),
so re-runs never re-log history.
"""
import json
import time
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state.json"
DECISION = ROOT / "decision-log.json"
LEARN = ROOT / "notes" / "LESSONS_LEARNED.md"
SEEN = ROOT / ".postmortem_seen.json"


def load_json(p):
    if p.exists():
        try:
            return json.load(open(p))
        except Exception:
            return None
    return None


def load_seen():
    d = load_json(SEEN)
    return d if isinstance(d, dict) else {}


def save_seen(seen):
    json.dump(seen, open(SEEN, "w"), indent=2)


def collect_decision_pnl():
    """Map pool_address -> pnl_pct from decision-log close entries."""
    d = load_json(DECISION)
    if not d:
        return {}
    out = {}
    for e in d.get("decisions", []):
        if e.get("type") != "close":
            continue
        s = e.get("summary", "")
        import re
        m = re.search(r"(-?\d+(?:\.\d+)?)\s*%", s)
        if m and e.get("pool"):
            out[e["pool"]] = float(m.group(1))
    return out


def main():
    st = load_json(STATE)
    if not st:
        print(f"[{ts()}] state.json not found — skip")
        return
    positions = st.get("positions", {})
    seen = load_seen()
    decision_pnl = collect_decision_pnl()
    new_closed = []

    for pid, p in positions.items():
        if not p.get("closed") or pid in seen:
            continue
        pnl = p.get("pnl_pct") or p.get("realized_pnl_pct")
        if pnl is None:
            pnl = decision_pnl.get(p.get("pool", ""))
        # Skip positions with no PnL source (historical noise). Only log
        # positions we can attribute a real PnL to (state or decision-log).
        if pnl is None:
            seen[pid] = ts()
            continue
        rec = {
            "pool": p.get("pool_name", "?"),
            "strategy": p.get("strategy", "?"),
            "pnl_pct": pnl,
            "entry_mcap": (p.get("entry_mcap") or 0) / 1_000_000,
            "entry_tvl": (p.get("entry_tvl") or 0) / 1_000,
            "organic": p.get("organic_score"),
            "fee_tvl": p.get("fee_tvl_ratio") or p.get("initial_fee_tvl_24h"),
            "reason": p.get("closed_reason") or "unknown",
            "fees_usd": p.get("total_fees_claimed_usd"),
        }
        new_closed.append((pid, rec))
        seen[pid] = ts()

    if not new_closed:
        print(f"[{ts()}] No new closed positions.")
        save_seen(seen)
        return

    lines = [f"\n## {ts()} — Post-mortem batch ({len(new_closed)} new)\n"]
    for pid, r in new_closed:
        if isinstance(r["pnl_pct"], (int, float)):
            pnl = f"{r['pnl_pct']:+.2f}%"
        else:
            pnl = "pending (see decision-log)"
        lines.append(
            f"- **{r['pool']}** ({r['strategy']}) — PnL {pnl} | "
            f"mcap ${r['entry_mcap']:.2f}M | TVL ${r['entry_tvl']:.0f}K | "
            f"organic {r['organic']} | fee/TVL {r['fee_tvl']} | reason: {r['reason']}"
        )
    lines.append("")

    with open(LEARN, "a") as f:
        f.write("\n".join(lines))
    print(f"[{ts()}] Logged {len(new_closed)} closed position(s) to {LEARN.name}")

    # correlation summary only if >=5 have real PnL
    with_pnl = [p for p in positions.values()
                if p.get("closed") and isinstance(p.get("pnl_pct") or decision_pnl.get(p.get("pool_name", ""), None), (int, float))]
    if len(with_pnl) >= 5:
        wins = [p for p in with_pnl
                if (p.get("pnl_pct") or decision_pnl.get(p.get("pool_name", ""))) > 0]
        print(f"  [ANALYSIS] {len(with_pnl)} closed w/ PnL — wins={len(wins)}/{len(with_pnl)}")
        print("  [NOTE] No auto config change — owner reviews notes/LESSONS_LEARNED.md, then tunes.")

    save_seen(seen)


def ts():
    return time.strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    main()
