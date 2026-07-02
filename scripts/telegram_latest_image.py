#!/usr/bin/env python3
"""
Read latest Telegram screenshot saved by Meridian bot polling.

Usage:
  python3 scripts/telegram_latest_image.py
  python3 scripts/telegram_latest_image.py --pending
  python3 scripts/telegram_latest_image.py --list 5
  python3 scripts/telegram_latest_image.py --ack
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "uploads" / "manifest.json"
PENDING = ROOT / "notes" / "telegram_image_pending.json"


def load_json(path: Path):
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def resolve_abs(entry: dict) -> str:
    if entry.get("abs_path"):
        return entry["abs_path"]
    rel = entry.get("path") or ""
    return str((ROOT / rel).resolve())


def main() -> int:
    parser = argparse.ArgumentParser(description="Latest Telegram screenshot for Hermes vision")
    parser.add_argument("--pending", action="store_true", help="Return pending image for Hermes")
    parser.add_argument("--list", type=int, metavar="N", help="List N recent uploads")
    parser.add_argument("--ack", action="store_true", help="Clear pending flag after Hermes processed")
    args = parser.parse_args()

    if args.ack:
        if PENDING.is_file():
            PENDING.unlink()
        print(json.dumps({"ack": True}))
        return 0

    if args.pending:
        pending = load_json(PENDING)
        if not pending:
            print(json.dumps({"pending": False}))
            return 0
        pending["abs_path"] = resolve_abs(pending)
        pending["pending"] = True
        print(json.dumps(pending, indent=2))
        return 0

    manifest = load_json(MANIFEST) or {"latest": None, "items": []}

    if args.list:
        items = []
        for entry in (manifest.get("items") or [])[: args.list]:
            row = dict(entry)
            row["abs_path"] = resolve_abs(row)
            items.append(row)
        print(json.dumps({"items": items, "latest": manifest.get("latest")}, indent=2))
        return 0

    latest_rel = manifest.get("latest")
    entry = next((item for item in manifest.get("items") or [] if item.get("path") == latest_rel), None)
    if not entry and manifest.get("items"):
        entry = manifest["items"][0]
    if not entry:
        print(json.dumps({"found": False, "message": "No Telegram uploads yet"}))
        return 1

    payload = {
        "found": True,
        "latest": latest_rel,
        "abs_path": resolve_abs(entry),
        "caption": entry.get("caption"),
        "saved_at": entry.get("saved_at"),
        "filename": entry.get("filename"),
        "pending": PENDING.is_file(),
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())