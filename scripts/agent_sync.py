#!/usr/bin/env python3
"""
Meridian trio bridge — Hermes ↔ Grok ↔ Claude.

Refresh notes/BRIDGE.json + notes/BRIDGE.md and manage notes/HANDOFF.md.

Usage:
    python3 scripts/agent_sync.py
    python3 scripts/agent_sync.py status
    python3 scripts/agent_sync.py hermes
    python3 scripts/agent_sync.py handoff --from grok --to hermes --summary "..." --tasks "none"
    python3 scripts/agent_sync.py dispatch --assignee grok --priority P1 --summary "..." --tasks "..."
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_ROOT = Path(__file__).resolve().parent.parent
NOTES_DIR = _ROOT / "notes"
BRIDGE_JSON = NOTES_DIR / "BRIDGE.json"
BRIDGE_MD = NOTES_DIR / "BRIDGE.md"
HANDOFF_MD = NOTES_DIR / "HANDOFF.md"
CURRENT_MD = NOTES_DIR / "CURRENT.md"
HANDOFF_LOCK_FILE = NOTES_DIR / ".handoff.lock"
DECISION_LOG = _ROOT / "decision-log.json"
USER_CONFIG = _ROOT / "user-config.json"
AGENT_CHOICES = ("hermes", "grok", "claude", "owner")
MAX_HANDOFF_ENTRIES = 30


@contextlib.contextmanager
def _handoff_lock():
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    with open(HANDOFF_LOCK_FILE, "w") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_git(args: list[str]) -> str:
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def _git_info() -> dict:
    branch = _run_git(["branch", "--show-current"]) or "unknown"
    last_commit = _run_git(["log", "-1", "--format=%h %s (%cr)"])
    dirty = _run_git(["status", "--porcelain"])
    dirty_count = len([l for l in dirty.splitlines() if l.strip()]) if dirty else 0
    return {
        "branch": branch,
        "last_commit": last_commit or "no commits",
        "dirty_files": dirty_count,
        "is_dirty": dirty_count > 0,
    }


def _load_json(path: Path) -> Optional[dict | list]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _meridian_state() -> dict:
    cfg = _load_json(USER_CONFIG) or {}
    decisions = _load_json(DECISION_LOG)
    recent = []
    if isinstance(decisions, list):
        recent = decisions[-3:]
    return {
        "dry_run": cfg.get("dryRun", True),
        "max_positions": cfg.get("maxPositions"),
        "deploy_amount_sol": cfg.get("deployAmountSol"),
        "screening_interval_min": cfg.get("screeningIntervalMin"),
        "management_interval_min": cfg.get("managementIntervalMin"),
        "has_user_config": USER_CONFIG.is_file(),
        "has_env": (_ROOT / ".env").is_file(),
        "recent_decisions": len(recent),
        "last_decision": recent[-1].get("summary") if recent else None,
    }


def _parse_handoff_entries(text: str) -> list[dict]:
    entries = []
    pattern = re.compile(
        r"^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC) \| (\w+) → (\w+)\s*\n(.*?)(?=^## |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    for m in pattern.finditer(text):
        body = m.group(4).strip()
        def _grab(label: str) -> str:
            hit = re.search(rf"\*\*{label}:\*\* (.+)", body)
            return hit.group(1).strip() if hit else ""
        entries.append({
            "at": m.group(1),
            "from": m.group(2),
            "to": m.group(3),
            "summary": _grab("Summary"),
            "tasks": _grab("Tasks"),
            "assignee": _grab("Assignee") or m.group(3),
            "priority": _grab("Priority"),
            "status": (_grab("Status") or "open").lower(),
            "done": _grab("Done"),
            "blockers": _grab("Blockers"),
        })
    return entries


def _read_handoff() -> list[dict]:
    if not HANDOFF_MD.exists():
        return []
    return _parse_handoff_entries(HANDOFF_MD.read_text(encoding="utf-8"))


def _write_handoff_file(entries: list[dict]) -> None:
    lines = ["# HANDOFF — Meridian trio task queue\n", f"_Updated: {_iso_now()}_\n\n"]
    for e in entries[-MAX_HANDOFF_ENTRIES:]:
        lines.append(f"## {e['at']} | {e['from']} → {e['to']}\n\n")
        if e.get("summary"):
            lines.append(f"**Summary:** {e['summary']}\n\n")
        if e.get("tasks"):
            lines.append(f"**Tasks:** {e['tasks']}\n\n")
        if e.get("assignee"):
            lines.append(f"**Assignee:** {e['assignee']}\n\n")
        if e.get("priority"):
            lines.append(f"**Priority:** {e['priority']}\n\n")
        lines.append(f"**Status:** {e.get('status', 'open')}\n\n")
        if e.get("done"):
            lines.append(f"**Done:** {e['done']}\n\n")
        if e.get("blockers"):
            lines.append(f"**Blockers:** {e['blockers']}\n\n")
    HANDOFF_MD.write_text("".join(lines), encoding="utf-8")


def append_handoff(
    *,
    from_agent: str,
    to_agent: str,
    summary: str,
    tasks: str = "none",
    assignee: Optional[str] = None,
    priority: str = "",
    status: str = "open",
    done: str = "",
    blockers: str = "",
) -> dict:
    with _handoff_lock():
        entries = _read_handoff()
        entry = {
            "at": _utc_now(),
            "from": from_agent,
            "to": to_agent,
            "summary": summary,
            "tasks": tasks,
            "assignee": assignee or to_agent,
            "priority": priority,
            "status": status,
            "done": done,
            "blockers": blockers,
        }
        entries.append(entry)
        _write_handoff_file(entries)
    return entry


def _pending_for(agent: str, entries: list[dict]) -> list[str]:
    pending = []
    for e in entries:
        if e.get("status", "open") == "closed":
            continue
        target = (e.get("assignee") or e.get("to") or "").lower()
        tasks = (e.get("tasks") or "").strip().lower()
        if target == agent.lower() and tasks not in {"", "none", "—", "-", "n/a"}:
            prefix = f"[{e['priority']}] " if e.get("priority") else ""
            pending.append(f"{prefix}{e['tasks']}")
    return pending


def _phase_from_current() -> str:
    if not CURRENT_MD.is_file():
        return "bootstrap"
    text = CURRENT_MD.read_text(encoding="utf-8")
    m = re.search(r"^## Phase\s*\n\*\*(.+?)\*\*", text, re.MULTILINE)
    return m.group(1).strip() if m else "unknown"


def build_bridge(by: str = "agent_sync") -> dict:
    entries = _read_handoff()
    latest = entries[-1] if entries else None
    bridge = {
        "updated_at": _iso_now(),
        "updated_by": by,
        "project": "meridian",
        "phase": _phase_from_current(),
        "git": _git_info(),
        "meridian": _meridian_state(),
        "handoff_count": len(entries),
        "latest": latest,
        "pending": {
            "hermes": _pending_for("hermes", entries),
            "grok": _pending_for("grok", entries),
            "claude": _pending_for("claude", entries),
        },
    }
    return bridge


def _render_bridge_md(bridge: dict) -> str:
    git = bridge["git"]
    m = bridge["meridian"]
    latest = bridge.get("latest") or {}
    lines = [
        "# BRIDGE — Hermes ↔ Grok ↔ Claude (Meridian)\n\n",
        f"_Updated: {bridge['updated_at']} by **{bridge['updated_by']}**_\n\n",
        "## Quick status\n\n",
        "| Item | Value |\n|------|-------|\n",
        f"| Phase | `{bridge['phase']}` |\n",
        f"| Git branch | `{git['branch']}` |\n",
        f"| Uncommitted files | {git['dirty_files']} |\n",
        f"| Last commit | {git['last_commit']} |\n",
        f"| DRY_RUN | `{m.get('dry_run', True)}` |\n",
        f"| user-config.json | {'yes' if m.get('has_user_config') else '**missing**'} |\n",
        f"| .env | {'yes' if m.get('has_env') else '**missing**'} |\n",
        f"| Recent decisions | {m.get('recent_decisions', 0)} |\n\n",
    ]
    if latest:
        lines.extend([
            "## Latest handoff\n\n",
            f"**{latest.get('at', '?')}** | `{latest.get('from', '?')}` → `{latest.get('to', '?')}`\n",
            f"> {latest.get('summary', '(no summary)')}\n\n",
            f"Tasks: `{latest.get('tasks', 'none')}`\n\n",
        ])
    for agent in ("hermes", "grok", "claude"):
        pending = bridge["pending"].get(agent) or []
        if pending:
            lines.append(f"## Pending for {agent}\n\n")
            for p in pending:
                lines.append(f"- {p}\n")
            lines.append("\n")
    lines.extend([
        "## Read next\n\n",
        "1. `notes/HERMES.md` — otak utama\n",
        "2. `notes/GROK.md` — eksekutor\n",
        "3. `notes/CURRENT.md` — fase project\n",
        "4. `notes/HANDOFF.md` — task queue\n",
        "5. `CLAUDE.md` — engineering manual Meridian\n",
    ])
    return "".join(lines)


def refresh(by: str = "agent_sync") -> dict:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    bridge = build_bridge(by=by)
    BRIDGE_JSON.write_text(json.dumps(bridge, indent=2), encoding="utf-8")
    BRIDGE_MD.write_text(_render_bridge_md(bridge), encoding="utf-8")
    return bridge


def cmd_status() -> int:
    bridge = refresh()
    print(f"phase={bridge['phase']} dry_run={bridge['meridian'].get('dry_run')}")
    print(f"git={bridge['git']['branch']} dirty={bridge['git']['dirty_files']}")
    for agent in ("hermes", "grok", "claude"):
        pending = bridge["pending"].get(agent) or []
        if pending:
            print(f"pending[{agent}]: {len(pending)}")
    return 0


def cmd_hermes() -> int:
    bridge = refresh(by="hermes_digest")
    print(json.dumps({
        "phase": bridge["phase"],
        "meridian": bridge["meridian"],
        "pending_hermes": bridge["pending"]["hermes"],
        "pending_grok": bridge["pending"]["grok"],
        "latest_handoff": bridge.get("latest"),
    }, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Meridian trio bridge sync")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("status")
    sub.add_parser("hermes")

    handoff_p = sub.add_parser("handoff")
    handoff_p.add_argument("--from", dest="from_agent", required=True, choices=AGENT_CHOICES)
    handoff_p.add_argument("--to", required=True, choices=AGENT_CHOICES)
    handoff_p.add_argument("--summary", required=True)
    handoff_p.add_argument("--tasks", default="none")
    handoff_p.add_argument("--assignee")
    handoff_p.add_argument("--priority", default="")
    handoff_p.add_argument("--status", default="open")
    handoff_p.add_argument("--done", default="")
    handoff_p.add_argument("--blockers", default="")

    dispatch_p = sub.add_parser("dispatch")
    dispatch_p.add_argument("--assignee", required=True, choices=("grok", "claude", "hermes"))
    dispatch_p.add_argument("--summary", required=True)
    dispatch_p.add_argument("--tasks", required=True)
    dispatch_p.add_argument("--priority", default="P2")
    dispatch_p.add_argument("--from", dest="from_agent", default="hermes")

    args = parser.parse_args()
    if args.cmd == "status":
        return cmd_status()
    if args.cmd == "hermes":
        return cmd_hermes()
    if args.cmd == "handoff":
        append_handoff(
            from_agent=args.from_agent,
            to_agent=args.to,
            summary=args.summary,
            tasks=args.tasks,
            assignee=args.assignee,
            priority=args.priority,
            status=args.status,
            done=args.done,
            blockers=args.blockers,
        )
        refresh(by=args.from_agent)
        return 0
    if args.cmd == "dispatch":
        append_handoff(
            from_agent=args.from_agent,
            to_agent=args.assignee,
            summary=args.summary,
            tasks=args.tasks,
            assignee=args.assignee,
            priority=args.priority,
        )
        refresh(by=args.from_agent)
        print(f"dispatched → {args.assignee}: {args.summary}")
        return 0

    refresh()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())