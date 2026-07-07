#!/usr/bin/env python3
"""
Meridian Health Watchdog (Hermes, 2026-07-07)
Runs every 15m as a cron. Monitors things the daemon itself CANNOT alert on:
  - daemon process alive (systemctl is-active)
  - SOL balance drain (vs last snapshot)
  - any cron scripts erroring (last-modified staleness)
Sends Telegram alert on anomalies. Writes notes/HEALTH_WATCHDOG.md summary.

This is the "monitor terus" layer — independent of the daemon so it still
fires if the daemon crashes.
"""
import json
import time
import subprocess
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "user-config.json"
STATE = ROOT / "state.json"
SNAP = ROOT / ".health_snapshot.json"
HEALTH = ROOT / "notes" / "HEALTH_WATCHDOG.md"
LOGS = ROOT / "logs"


def load_json(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


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


def daemon_active():
    try:
        r = subprocess.run(["systemctl", "is-active", "meridian-daemon"],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() == "active"
    except Exception:
        return False


def get_balance_sol():
    try:
        r = subprocess.run(["node", "cli.js", "balance"], cwd=str(ROOT),
                           capture_output=True, text=True, timeout=30)
        out = r.stdout
        i = out.find("{")
        if i < 0:
            return None
        d = json.loads(out[i:])
        return float(d.get("sol", 0))
    except Exception:
        return None


def check_crons():
    """Return list of cron logs not updated in >40 min (stale = possibly dead)."""
    stale = []
    try:
        crontab = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
        logs = [l.split()[-1] for l in crontab.stdout.splitlines() if l.strip() and ">>" in l]
        now = time.time()
        for logf in set(logs):
            p = Path(logf)
            if p.exists():
                age = now - p.stat().st_mtime
                if age > 2400:  # 40 min
                    stale.append((p.name, int(age // 60)))
    except Exception:
        pass
    return stale


def main():
    snap = load_json(SNAP) or {}
    alerts = []

    # 1. daemon alive
    active = daemon_active()
    if not active:
        alerts.append("🚨 DAEMON DOWN — meridian-daemon not active!")

    # 2. balance drain
    bal = get_balance_sol()
    last_bal = snap.get("sol")
    if bal is not None:
        if last_bal is not None and last_bal - bal > 0.5:
            alerts.append(f"⚠️ SOL DRAIN: {last_bal:.3f} → {bal:.3f} (-{last_bal-bal:.3f})")
        snap["sol"] = bal

    # 3. cron health
    stale = check_crons()
    for name, age in stale:
        alerts.append(f"⚠️ Cron stale: {name} ({age}m no update)")

    snap["ts"] = datetime.now().isoformat()
    json.dump(snap, open(SNAP, "w"), indent=2)

    # write health log
    line = f"\n## {datetime.now():%Y-%m-%d %H:%M} — daemon={'OK' if active else 'DOWN'} sol={bal} cron_stale={len(stale)}"
    with open(HEALTH, "a") as f:
        f.write(line + "\n")

    if alerts:
        msg = "🔍 Meridian Health Watchdog\n" + "\n".join(alerts) + "\n(checked " + datetime.now().strftime("%H:%M") + ")"
        print(msg)
        send_telegram(msg)
    else:
        print(f"[{datetime.now():%H:%M}] All healthy. daemon=OK sol={bal}")


if __name__ == "__main__":
    main()
