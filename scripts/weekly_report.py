#!/usr/bin/env python3
"""
Meridian Weekly P&L Digest + Close-Reason Correlation (Hermes, 2026-07-07)
Runs Sundays (cron). Sends a "report card" to Telegram + appends to
notes/WEEKLY_REPORT.md. Also computes close-reason vs PnL correlation using
state.json (reason derived heuristically where daemon did not record it).

Heuristic reason mapping (daemon does not always write close_reason):
  - out_of_range_since present -> "oor_exit"  (price left range, daemon closed)
  - peak_pnl_pct >= takeProfit  -> "take_profit"
  - peak_pnl_pct <= stopLoss   -> "stop_loss"
  - else                        -> "manual_other"
"""
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state.json"
DECISION = ROOT / "decision-log.json"
REPORT = ROOT / "notes" / "WEEKLY_REPORT.md"
CONFIG = ROOT / "user-config.json"


def load_json(p):
    if p.exists():
        try:
            return json.load(open(p))
        except Exception:
            return None
    return None


def derive_reason(p, cfg):
    if p.get("out_of_range_since"):
        return "oor_exit"
    tp = (cfg.get("management", {}) or {}).get("takeProfitPct", 3)
    sl = (cfg.get("management", {}) or {}).get("stopLossPct", -20)
    pnl = p.get("peak_pnl_pct") or p.get("pnl_pct")
    if pnl is None:
        return "manual_other"
    if pnl >= tp:
        return "take_profit"
    if pnl <= sl:
        return "stop_loss"
    return "manual_other"


def main():
    st = load_json(STATE)
    positions = st.get("positions", {}) if st else {}
    cfg = load_json(CONFIG) or {}

    closed = [p for p in positions.values() if p.get("closed")]
    rows = []
    for p in closed:
        pnl = p.get("peak_pnl_pct") or p.get("pnl_pct")
        if pnl is None:
            continue
        rows.append({
            "pool": p.get("pool_name", "?"),
            "pnl": pnl,
            "reason": derive_reason(p, cfg),
            "mcap": (p.get("entry_mcap") or 0) / 1e6,
        })

    if not rows:
        msg = "📊 Meridian Weekly: no closed positions with PnL yet."
        print(msg)
        send_telegram(msg)
        return

    total = len(rows)
    wins = sum(1 for r in rows if r["pnl"] > 0)
    avg = sum(r["pnl"] for r in rows) / total
    best = max(rows, key=lambda r: r["pnl"])
    worst = min(rows, key=lambda r: r["pnl"])

    # reason correlation
    from collections import defaultdict
    by_reason = defaultdict(list)
    for r in rows:
        by_reason[r["reason"]].append(r["pnl"])
    reason_lines = []
    for reason, pnls in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        n = len(pnls)
        avg_r = sum(pnls) / n
        reason_lines.append(f"  • {reason}: {n} closes, avg {avg_r:+.2f}%")

    lines = []
    lines.append(f"\n## {time.strftime('%Y-%m-%d')} — Weekly Report")
    lines.append(f"- Closed w/ PnL: {total}")
    lines.append(f"- Win rate: {wins}/{total} ({100*wins/total:.0f}%)")
    lines.append(f"- Avg PnL: {avg:+.2f}%")
    lines.append(f"- Best: {best['pool']} {best['pnl']:+.2f}%")
    lines.append(f"- Worst: {worst['pool']} {worst['pnl']:+.2f}%")
    lines.append(f"- Close-reason correlation (heuristic):")
    lines.extend(reason_lines)
    lines.append("")
    with open(REPORT, "a") as f:
        f.write("\n".join(lines))

    tg = (f"📊 Meridian Weekly\n"
          f"Closed: {total} | Win: {wins}/{total} ({100*wins/total:.0f}%)\n"
          f"Avg PnL: {avg:+.2f}%\n"
          f"Best: {best['pool']} {best['pnl']:+.2f}%\n"
          f"Worst: {worst['pool']} {worst['pnl']:+.2f}%\n"
          f"Top reason: {reason_lines[0] if reason_lines else 'n/a'}")
    print(tg)
    send_telegram(tg)


def send_telegram(msg):
    try:
        import urllib.parse
        import urllib.request
        cfg = load_json(CONFIG) or {}
        chat = cfg.get("telegramChatId")
        token = cfg.get("telegramBotToken")
        if not chat or not token:
            return
        url = f"https://api.telegram.org/bot{token}/sendMessage?chat_id={chat}&text={urllib.parse.quote(msg)}"
        urllib.request.urlopen(url, timeout=5)
    except Exception:
        pass


if __name__ == "__main__":
    main()
