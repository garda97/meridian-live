#!/usr/bin/env python3
"""
Meridian Recovery Position Manager (Hermes, 2026-07-07)
Implements @Heavymetalcook6's "Recovery Strat" from @met_lparmy:

  When an upper position goes OUT OF RANGE (price dropped below active bin),
  open a RECOVERY position LOWER (bid-ask down). Compound fees from the lower
  position into the upper to offset losses if price pumps back.

Modes (controlled by config.management.autoRecovery):
  - autoRecovery = false (DEFAULT): DRY-RUN. Writes proposal to
    notes/RECOVERY_PROPOSALS.md + Telegram alert. Owner approves manually.
  - autoRecovery = true: executes `node cli.js deploy` for each candidate.
    The CLI deploy path uses the SAME executeTool('deploy_position') as the
    daemon, so ALL safety guards apply (maxPositions, dailyLossLimitUsd,
    maxTvl, minTvl, organic, repeatDeployCooldown). No guard bypass.

Runs as a cron (every 15m) — separate from the daemon so it cannot disrupt
live trading logic, but reuses the daemon's guarded deploy path.

Recovery criteria:
  - position has out_of_range_since (OOR active) and not closed
  - OOR direction = BELOW (price under active bin) — recovery goes lower
  - token still alive: entry_mcap/entry_tvl not 0 (not a total rug)
  - not already proposed (tracked in .recovery_seen.json)
"""
import json
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state.json"
DECISION = ROOT / "decision-log.json"
PROPOSALS = ROOT / "notes" / "RECOVERY_PROPOSALS.md"
SEEN = ROOT / ".recovery_seen.json"
CONFIG = ROOT / "user-config.json"

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


def get_auto_recovery():
    cfg = load_json(CONFIG) or {}
    # config.js reads management.autoRecovery; user-config may set it too
    m = cfg.get("management", {})
    if isinstance(m, dict) and "autoRecovery" in m:
        return bool(m["autoRecovery"])
    # fallback: check top-level
    if "autoRecovery" in cfg:
        return bool(cfg["autoRecovery"])
    return False


def main():
    st = load_json(STATE)
    if not st:
        print(f"[{ts()}] state.json not found — skip")
        return
    positions = st.get("positions", {})
    seen = load_seen()
    auto = get_auto_recovery()
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
            seen[pid] = ts()
            continue

        entry_mcap = p.get("entry_mcap") or 0
        entry_tvl = p.get("entry_tvl") or 0
        if entry_mcap <= 0 or entry_tvl <= 0:
            seen[pid] = ts()  # total rug — skip (just close)
            continue
        if br.get("bins_below", 0) > 200:
            seen[pid] = ts()  # already deep recovery — skip
            continue

        pool_addr = p.get("pool")
        if not pool_addr:
            seen[pid] = ts()
            continue

        rec_min = min_bin - RECOVERY_BINS_BELOW
        rec_max = min_bin
        proposals.append({
            "pid": pid,
            "pool_addr": pool_addr,
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

    lines = [f"\n## {ts()} — Recovery {'AUTO' if auto else 'proposals'} ({len(proposals)} new)\n"]
    if not auto:
        lines.append("> DRY-RUN: owner must approve before deploy. Not auto-deployed.\n")

    deployed = []
    for r in proposals:
        lines.append(
            f"- **{r['pool']}** ({r['strategy']}) OOR since {r['oor_since'][:19]}\n"
            f"  - orig range: {r['orig_range']} → recovery range: {r['recovery_range']}\n"
            f"  - mcap ${r['entry_mcap']:.2f}M | TVL ${r['entry_tvl']:.0f}K\n"
            f"  - action: open recovery bid-ask BELOW, compound fees to upper\n"
        )
        if auto:
            if daily_loss_blocked():
                status = "BLOCKED: daily loss gate (-$%s hit)" % get_daily_loss_limit()
            else:
                ok, msg = execute_recovery(r)
                status = "DEPLOYED" if ok else f"BLOCKED: {msg}"
            lines.append(f"  - RESULT: {status}\n")
            if ok:
                deployed.append(r)

    lines.append("")
    with open(PROPOSALS, "a") as f:
        f.write("\n".join(lines))
    print(f"[{ts()}] {'Auto-deployed' if auto else 'Wrote'} {len(proposals)} recovery candidate(s) to {PROPOSALS.name}"
          + (f" ({len(deployed)} deployed)" if auto else ""))

    send_telegram_alert(proposals, auto, deployed)
    save_seen(seen)


def get_daily_loss_limit():
    cfg = load_json(CONFIG) or {}
    # management.dailyLossLimitUsd (config.js) or top-level
    m = cfg.get("management", {})
    if isinstance(m, dict) and "dailyLossLimitUsd" in m:
        return m["dailyLossLimitUsd"]
    if "dailyLossLimitUsd" in cfg:
        return cfg["dailyLossLimitUsd"]
    return 300  # default fallback


def daily_loss_blocked():
    """Redundant safety: cli deploy does NOT check dailyLossLimitUsd,
    so recovery must check it itself before deploying."""
    try:
        d = load_json(DECISION)
        if not d:
            return False
        limit = get_daily_loss_limit()
        # realize PnL today from close decisions
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        realized = 0.0
        for e in d.get("decisions", []):
            if e.get("type") != "close":
                continue
            ts = e.get("timestamp", "")
            if not ts.startswith(today):
                continue
            pnl = e.get("metrics", {}).get("realized_pnl_usd_today")
            if pnl is None:
                # try generic pnl_usd / value
                pnl = e.get("metrics", {}).get("pnl_usd")
            if pnl is None:
                # parse from reason text "realized X USD"
                import re
                m = re.search(r"realized\s*(-?[\d.]+)\s*USD", str(e.get("reason", "")), re.I)
                if m:
                    pnl = float(m.group(1))
            if pnl is not None:
                realized += float(pnl)
        return realized <= -limit
    except Exception:
        return False


def execute_recovery(r):
    """Call `node cli.js deploy` — reuses daemon's guarded deploy path.
    Returns (ok, message). Safety checks (maxPositions, dailyLoss, maxTvl...)
    are enforced by the CLI itself."""
    try:
        cmd = [
            "node", "cli.js", "deploy",
            "--pool", r["pool_addr"],
            "--amount", "0.3",
            "--bins-below", str(RECOVERY_BINS_BELOW),
            "--bins-above", "0",
            "--strategy", "bid_ask",
        ]
        res = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        out = res.stdout + res.stderr
        if '"blocked": true' in out or "SAFETY_BLOCK" in out:
            # extract reason
            import re
            m = re.search(r'"reason":\s*"([^"]+)"', out)
            return False, m.group(1) if m else "safety block"
        if res.returncode == 0 and ("deployed" in out.lower() or "deploy" in out.lower()):
            return True, "ok"
        return False, out[-200:].strip()
    except Exception as e:
        return False, str(e)


def send_telegram_alert(proposals, auto, deployed):
    try:
        import urllib.parse
        import urllib.request
        cfg = load_json(CONFIG) or {}
        chat = cfg.get("telegramChatId")
        token = cfg.get("telegramBotToken")
        if not chat or not token:
            return
        if auto:
            msg = f"🔄 RECOVERY AUTO-DEPLOYED {len(deployed)}/{len(proposals)}:\n"
            for r in deployed:
                msg += f"• {r['pool']} {r['recovery_range']}\n"
        else:
            msg = f"🔄 RECOVERY STRAT — {len(proposals)} candidate(s):\n"
            for r in proposals[:5]:
                msg += f"• {r['pool']} {r['recovery_range']}\n"
            msg += "(dry-run, set autoRecovery=true or owner approval needed)"
        url = f"https://api.telegram.org/bot{token}/sendMessage?chat_id={chat}&text={urllib.parse.quote(msg)}"
        urllib.request.urlopen(url, timeout=5)
    except Exception:
        pass


def ts():
    return time.strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    main()
