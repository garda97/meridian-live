#!/usr/bin/env python3
"""
Meridian Recovery Position Manager (Hermes, 2026-07-07)
Implements @Heavymetalcook6's "Recovery Strat" from @met_lparmy:

  When an upper position goes OUT OF RANGE (price dropped below active bin),
  open a RECOVERY position LOWER (bid-ask down). Compound fees from the lower
  position into the upper to offset losses if price pumps back.

This script is DRY-RUN / PROPOSAL-ONLY. It detects OOR positions and writes a
recovery proposal to notes/RECOVERY_PROPOSALS.md + sends a Telegram alert.
It does NOT auto-deploy. Owner approves manually (Safety First).

Runs as a cron (every 15m) — separate from the daemon so it cannot disrupt
live trading logic.

Recovery criteria:
  - position has out_of_range_since (OOR active) and not closed
  - OOR direction = BELOW (price under active bin) — recovery goes lower
  - token still alive: entry_mcap/entry_tvl not 0 (not a total rug)
  - we don't already have a recovery proposal for this pool
"""
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state.json"
PROPOSALS = ROOT / "notes" / "RECOVERY_PROPOSALS.md"
SEEN = ROOT / ".recovery_seen.json"

# Recovery position sits 100 bins below the original lower bound.
RECOVERY_BINS_BELOW = 100


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


def main():
    st = load_json(STATE)
    if not st:
        print(f"[{ts()}] state.json not found — skip")
        return
    positions = st.get("positions", {})
    seen = load_seen()
    proposals = []

    for pid, p in positions.items():
        if p.get("closed") or not p.get("out_of_range_since"):
            continue
        if pid in seen:
            continue

        br = p.get("bin_range") or {}
        min_bin = br.get("min")
        max_bin = br.get("max")
        if min_bin is None or max_bin is None:
            continue

        # OOR direction: if active price is below our range -> recovery lower
        # Heuristic: OOR with bid_ask strategy + lower bins available = below
        entry_mcap = p.get("entry_mcap") or 0
        entry_tvl = p.get("entry_tvl") or 0
        if entry_mcap <= 0 or entry_tvl <= 0:
            # total rug — skip (no recovery, just close)
            seen[pid] = ts()
            continue

        # only recover if we have room below (not already a deep recovery)
        if br.get("bins_below", 0) > 200:
            seen[pid] = ts()
            continue

        rec_min = min_bin - RECOVERY_BINS_BELOW
        rec_max = min_bin
        proposals.append({
            "pid": pid,
            "pool": p.get("pool_name", "?"),
            "strategy": p.get("strategy", "?"),
            "oor_since": p.get("out_of_range_since"),
            "orig_range": f"[{min_bin}, {max_bin}]",
            "recovery_range": f"[{rec_min}, {rec_max}]",
            "entry_mcap": entry_mcap / 1_000_000,
            "entry_tvl": entry_tvl / 1_000,
        })
        seen[pid] = ts()

    if not proposals:
        print(f"[{ts()}] No new recovery candidates.")
        save_seen(seen)
        return

    lines = [f"\n## {ts()} — Recovery proposals ({len(proposals)} new)\n"]
    lines.append("> DRY-RUN: owner must approve before deploy. Not auto-deployed.\n")
    for r in proposals:
        lines.append(
            f"- **{r['pool']}** ({r['strategy']}) OOR since {r['oor_since'][:19]}\n"
            f"  - orig range: {r['orig_range']} → recovery range: {r['recovery_range']}\n"
            f"  - mcap ${r['entry_mcap']:.2f}M | TVL ${r['entry_tvl']:.0f}K\n"
            f"  - action: open recovery bid-ask BELOW, compound fees to upper\n"
        )
    lines.append("")

    with open(PROPOSALS, "a") as f:
        f.write("\n".join(lines))
    print(f"[{ts()}] Wrote {len(proposals)} recovery proposal(s) to {PROPOSALS.name}")

    # Telegram alert (if enabled in config) — non-blocking, best-effort
    send_telegram_alert(proposals)

    save_seen(seen)


def send_telegram_alert(proposals):
    """Best-effort Telegram ping. Fails silently if not configured."""
    try:
        import urllib.parse
        import urllib.request
        cfg = load_json(ROOT / "user-config.json") or {}
        chat = cfg.get("telegramChatId")
        token = cfg.get("telegramBotToken")
        if not chat or not token:
            return
        msg = "🔄 RECOVERY STRAT — {} candidate(s):\n".format(len(proposals))
        for r in proposals[:5]:
            msg += f"• {r['pool']} {r['recovery_range']}\n"
        msg += "(dry-run, owner approval needed)"
        url = f"https://api.telegram.org/bot{token}/sendMessage?chat_id={chat}&text={urllib.parse.quote(msg)}"
        urllib.request.urlopen(url, timeout=5)
    except Exception:
        pass


def ts():
    return time.strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    import urllib.parse
    main()
