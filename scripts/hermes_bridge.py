#!/usr/bin/env python3
"""
Meridian — Hermes ↔ Grok ↔ Claude bridge helper.

Usage:
  python3 scripts/hermes_bridge.py connect
  python3 scripts/hermes_bridge.py status
  python3 scripts/hermes_bridge.py dispatch --assignee grok --summary "..." --tasks "..."
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT_SYNC = [sys.executable, str(ROOT / "scripts" / "agent_sync.py")]


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, check=False, text=True, capture_output=True, **kwargs)


def cmd_connect() -> int:
    print("=== Meridian Trio — Connection Status ===\n")
    checks: list[tuple[str, bool, str]] = []

    for name, bin_name in [("Hermes CLI", "hermes"), ("Claude CLI", "claude"), ("Grok CLI", "grok")]:
        r = _run(["bash", "-lc", f"command -v {bin_name}"])
        checks.append((name, r.returncode == 0, r.stdout.strip() or "not found"))

    grok_auth = Path.home() / ".grok" / "auth.json"
    grok_ok = grok_auth.is_file() and grok_auth.stat().st_size > 32
    checks.append(("Grok auth", grok_ok, str(grok_auth) if grok_ok else "run: grok login"))

    meridian_env = (ROOT / ".env").is_file()
    checks.append(("Meridian .env", meridian_env, str(ROOT / ".env")))

    user_cfg = (ROOT / "user-config.json").is_file()
    checks.append(("user-config.json", user_cfg, str(ROOT / "user-config.json")))

    node_r = _run(["bash", "-lc", "node --version"])
    checks.append(("Node.js", node_r.returncode == 0, node_r.stdout.strip() or "missing"))

    for label, ok, detail in checks:
        mark = "OK" if ok else "MISSING"
        print(f"  [{mark}] {label}: {detail}")

    print()
    r = _run([*AGENT_SYNC, "status"])
    print(r.stdout or r.stderr)
    return 0


def cmd_status() -> int:
    r = _run([*AGENT_SYNC, "hermes"])
    print(r.stdout or r.stderr)
    return r.returncode


def cmd_dispatch(args: argparse.Namespace) -> int:
    cmd = [
        *AGENT_SYNC,
        "dispatch",
        "--assignee", args.assignee,
        "--summary", args.summary,
        "--tasks", args.tasks,
        "--priority", args.priority,
        "--from", args.from_agent,
    ]
    r = _run(cmd)
    print(r.stdout or r.stderr)
    return r.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Meridian hermes bridge")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("connect")
    sub.add_parser("status")

    dispatch_p = sub.add_parser("dispatch")
    dispatch_p.add_argument("--assignee", required=True, choices=("grok", "claude", "hermes"))
    dispatch_p.add_argument("--summary", required=True)
    dispatch_p.add_argument("--tasks", required=True)
    dispatch_p.add_argument("--priority", default="P2")
    dispatch_p.add_argument("--from", dest="from_agent", default="hermes")

    args = parser.parse_args()
    if args.cmd == "connect":
        return cmd_connect()
    if args.cmd == "status":
        return cmd_status()
    if args.cmd == "dispatch":
        return cmd_dispatch(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())