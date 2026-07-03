#!/usr/bin/env python3
"""
Tier 2 — auto-join eligible GIMI challenges.

Requires auth (one of):
  ~/.meridian/secrets/gimi.session
  GIMI_SESSION_TOKEN in environment / .env
  ~/.meridian/secrets/gimi-storage.json (Playwright fallback)

Usage:
  python3 scripts/gimi_join.py --dry-run
  python3 scripts/gimi_join.py --execute --max-joins 3
  python3 scripts/gimi_join.py --execute --tags crypto-adjacent
  python3 scripts/gimi_join.py --challenge-id 69f34fa3255501d0f4c3ef09 --execute

Get token (owner, once):
  1. Login https://app.gimi.co in Chrome
  2. DevTools → Network → any prod-bb-backend request → Authorization: Bearer <token>
  3. ./scripts/set-gimi-session.sh <token>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LATEST = ROOT / "notes" / "gimi-challenges" / "latest.json"
STATE_FILE = ROOT / "notes" / "gimi-challenges" / "join-state.json"
VENV_PYTHON = ROOT / ".venv-gimi" / "bin" / "python3"

sys.path.insert(0, str(ROOT / "scripts"))
from gimi_client import (  # noqa: E402
    GimiAuthError,
    auth_status,
    campaign_url,
    get_user_info,
    has_playwright_storage,
    join_spark,
    load_session_token,
    STORAGE_FILE,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"joined": [], "failed": [], "skipped": [], "last_run": None}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"joined": [], "failed": [], "skipped": [], "last_run": None}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["last_run"] = _utc_now()
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def load_challenges() -> list[dict]:
    if not LATEST.exists():
        raise FileNotFoundError(
            f"{LATEST} missing — run python3 scripts/gimi_monitor.py first"
        )
    payload = json.loads(LATEST.read_text(encoding="utf-8"))
    return payload.get("challenges") or []


def joined_ids(state: dict) -> set[str]:
    return {row.get("id") for row in state.get("joined", []) if row.get("id")}


def is_eligible(challenge: dict, *, global_only: bool, tag_filter: set[str] | None) -> tuple[bool, str]:
    if challenge.get("status") != "ongoing":
        return False, "not_ongoing"
    if challenge.get("is_private"):
        return False, "private"
    locations = challenge.get("locations") or []
    if global_only and locations and "GLOBAL" not in locations:
        return False, f"region_locked:{','.join(locations)}"
    if tag_filter:
        tags = set(challenge.get("tags") or [])
        if not tags.intersection(tag_filter):
            return False, "tag_mismatch"
    return True, "eligible"


async def join_via_browser(slug: str) -> dict:
    if not has_playwright_storage():
        raise GimiAuthError("No Playwright storage — use set-gimi-session.sh")

    from playwright.async_api import async_playwright

    result = {"method": "browser", "slug": slug, "ok": False, "detail": ""}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(storage_state=str(STORAGE_FILE))
        page = await context.new_page()
        url = campaign_url(slug)
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(2500)

        body = await page.inner_text("body")
        if any(x in body.lower() for x in ("already joined", "you joined", "joined challenge")):
            result.update({"ok": True, "detail": "already_joined"})
            await browser.close()
            return result

        for label in ("Join Challenge", "Join", "Start Challenge", "Participate"):
            loc = page.get_by_role("button", name=label)
            if await loc.count():
                await loc.first.click(timeout=8000)
                await page.wait_for_timeout(3000)
                body2 = await page.inner_text("body")
                result["detail"] = body2[:240].replace("\n", " ")
                result["ok"] = True
                await browser.close()
                return result

        result["detail"] = "no_join_button"
        await browser.close()
    return result


def join_one(challenge: dict, *, execute: bool, use_browser_fallback: bool) -> dict:
    spark_id = challenge.get("id")
    slug = challenge.get("slug")
    name = challenge.get("name")
    out = {
        "id": spark_id,
        "slug": slug,
        "name": name,
        "ok": False,
        "method": None,
        "detail": "",
        "at": _utc_now(),
    }

    if not execute:
        out.update({"ok": True, "method": "dry_run", "detail": "would_join"})
        return out

    token = load_session_token()
    if token:
        code, payload = join_spark(spark_id, token=token)
        out["method"] = "api"
        out["detail"] = json.dumps(payload, ensure_ascii=False)[:500]
        if code in (200, 201):
            out["ok"] = True
            return out
        if code == 409 or "already" in str(payload).lower():
            out["ok"] = True
            out["detail"] = "already_joined"
            return out

    if use_browser_fallback and slug:
        try:
            browser_result = asyncio.run(join_via_browser(slug))
            out["method"] = "browser"
            out["detail"] = browser_result.get("detail", "")
            out["ok"] = bool(browser_result.get("ok"))
            return out
        except Exception as exc:
            out["detail"] = f"browser_error:{exc}"
            return out

    if not token:
        out["detail"] = "no_auth"
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto-join eligible GIMI challenges")
    parser.add_argument("--execute", action="store_true", help="Actually join (default: dry-run)")
    parser.add_argument("--max-joins", type=int, default=3)
    parser.add_argument("--global-only", action="store_true", default=True)
    parser.add_argument("--allow-region-locked", action="store_true")
    parser.add_argument("--tags", default="", help="Comma tags, e.g. crypto-adjacent")
    parser.add_argument("--challenge-id", default="", help="Join one challenge by id")
    parser.add_argument("--browser-fallback", action="store_true", default=True)
    args = parser.parse_args()

    execute = bool(args.execute)

    tag_filter = {t.strip() for t in args.tags.split(",") if t.strip()} or None
    global_only = args.global_only and not args.allow_region_locked

    status = auth_status()
    if execute and not status["ready"]:
        print(
            "GIMI auth missing. Owner setup:\n"
            "  1. Login https://app.gimi.co in Chrome\n"
            "  2. DevTools → Network → prod-bb-backend request → copy Bearer token\n"
            "  3. ./scripts/set-gimi-session.sh <token>\n"
            "Or save Playwright storage to ~/.meridian/secrets/gimi-storage.json",
            file=sys.stderr,
        )
        return 2

    if execute and status["has_token"]:
        code, info = get_user_info()
        if code >= 400:
            print(f"GIMI token invalid ({code}): {info}", file=sys.stderr)
            return 2
        print(f"GIMI auth OK — user info {json.dumps(info)[:200]}", file=sys.stderr)

    challenges = load_challenges()
    state = load_state()
    seen = joined_ids(state)

    if args.challenge_id:
        targets = [c for c in challenges if c.get("id") == args.challenge_id]
        if not targets:
            print(f"Challenge id not found in latest.json: {args.challenge_id}", file=sys.stderr)
            return 1
    else:
        targets = []
        for c in challenges:
            if c.get("id") in seen:
                continue
            ok, reason = is_eligible(c, global_only=global_only, tag_filter=tag_filter)
            if ok:
                targets.append(c)
            elif execute:
                state.setdefault("skipped", []).append({
                    "id": c.get("id"), "name": c.get("name"), "reason": reason, "at": _utc_now(),
                })
        targets.sort(key=lambda x: (x.get("budget_usd") or 0), reverse=True)
        targets = targets[: max(0, args.max_joins)]

    results = []
    for challenge in targets:
        result = join_one(
            challenge,
            execute=execute,
            use_browser_fallback=args.browser_fallback,
        )
        results.append(result)
        if not execute:
            continue
        if result.get("ok") and result.get("method") != "dry_run":
            state.setdefault("joined", []).append(result)
        elif not result.get("ok"):
            state.setdefault("failed", []).append(result)

    if execute or results:
        save_state(state)

    summary = {
        "ok": True,
        "mode": "execute" if execute else "dry_run",
        "auth": status,
        "attempted": len(results),
        "joined_ok": sum(1 for r in results if r.get("ok")),
        "targets": [
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "ok": r.get("ok"),
                "method": r.get("method"),
                "detail": (r.get("detail") or "")[:120],
            }
            for r in results
        ],
        "state_file": str(STATE_FILE),
    }
    print(json.dumps(summary, indent=2))
    return 0 if summary["joined_ok"] == len(results) or not execute else 1


if __name__ == "__main__":
    raise SystemExit(main())