#!/usr/bin/env python3
"""
Monitor GIMI Discover challenges via public Spark API.

Usage:
  python3 scripts/gimi_monitor.py
  python3 scripts/gimi_monitor.py --ongoing-only
  python3 scripts/gimi_monitor.py --export-signals
  python3 scripts/gimi_monitor.py --limit 100 --category featured

Output:
  notes/gimi-challenges/YYYY-MM-DD.json
  notes/gimi-challenges/YYYY-MM-DD.md
  notes/gimi-challenges/latest.json
  notes/gimi-challenges/state.json          (seen ids for diff)
  notes/gimi-signals.json                   (with --export-signals, tier-4 stub)

API: https://prod-bb-backend.thequestofevolution.com/spark (no auth required)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "notes" / "gimi-challenges"
SIGNALS_FILE = ROOT / "notes" / "gimi-signals.json"
STATE_FILE = OUT_DIR / "state.json"
API_BASE = "https://prod-bb-backend.thequestofevolution.com"
APP_BASE = "https://app.gimi.co/en"

CRYPTO_BRAND_HINTS = (
    "bitget", "vechain", "vet", "solana", "sol", "crypto", "wallet", "web3",
    "defi", "blockchain", "token", "nft", "meteora", "jupiter", "coinbase",
    "binance", "ethereum", "eth", "knowroaming", "earn", "story protocol",
)

TAG_RE = re.compile(r"<[^>]+>")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _strip_html(text: str | None) -> str:
    if not text:
        return ""
    plain = TAG_RE.sub(" ", unescape(text))
    return re.sub(r"\s+", " ", plain).strip()


def _usd_cents(value) -> float | None:
    try:
        if value is None or value == "":
            return None
        return round(float(value) / 100.0, 2)
    except (TypeError, ValueError):
        return None


def _challenge_url(slug: str | None, challenge_id: str | None) -> str:
    if slug:
        return f"{APP_BASE}/spark/{slug}"
    if challenge_id:
        return f"{APP_BASE}/discover?challenge={challenge_id}"
    return f"{APP_BASE}/discover"


def _crypto_tags(brand: str, name: str, description: str) -> list[str]:
    blob = f"{brand} {name} {description}".lower()
    tags = [hint for hint in CRYPTO_BRAND_HINTS if hint in blob]
    if tags:
        tags.insert(0, "crypto-adjacent")
    return sorted(set(tags))


def fetch_spark_page(
    *,
    page: int = 1,
    limit: int = 100,
    category: str = "featured",
    sort_by: str = "recent",
    include_private: bool = False,
) -> dict:
    params = {
        "limit": str(limit),
        "page": str(page),
        "category": category,
        "sort_by": sort_by,
        "includePrivateDis": "true" if include_private else "false",
    }
    url = f"{API_BASE}/spark?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "meridian-gimi-monitor/1.0"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_all_challenges(
    *,
    limit: int = 100,
    category: str = "featured",
    sort_by: str = "recent",
    include_private: bool = False,
    max_pages: int = 5,
) -> list[dict]:
    all_rows: list[dict] = []
    seen_ids: set[str] = set()

    for page in range(1, max_pages + 1):
        payload = fetch_spark_page(
            page=page,
            limit=limit,
            category=category,
            sort_by=sort_by,
            include_private=include_private,
        )
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            cid = row.get("_id")
            if cid and cid in seen_ids:
                continue
            if cid:
                seen_ids.add(cid)
            all_rows.append(row)

        pagination = payload.get("pagination") or {}
        total_pages = int(pagination.get("totalPages") or 1)
        if page >= total_pages:
            break

    return all_rows


def normalize_challenge(raw: dict) -> dict:
    creator = raw.get("creator") or {}
    brand = creator.get("name") or creator.get("username") or "unknown"
    slug = raw.get("slug")
    challenge_id = raw.get("_id")
    description_plain = _strip_html(raw.get("description"))
    end_time = (raw.get("end_time") or {}).get("date")
    published = (raw.get("published_time") or {}).get("date")

    return {
        "id": challenge_id,
        "slug": slug,
        "name": raw.get("name"),
        "brand": brand,
        "brand_username": creator.get("username"),
        "status": raw.get("status"),
        "challenge_type": raw.get("challengeType"),
        "moderation_type": raw.get("moderation_type"),
        "budget_usd": _usd_cents(raw.get("budget")),
        "initial_budget_usd": _usd_cents(raw.get("initialBudget")),
        "approval_bonus_usd": _usd_cents(raw.get("approvalBonus")),
        "spotlight_bonus_usd": _usd_cents(raw.get("spotlightCost")),
        "performance_multiplier": raw.get("eesMultiple"),
        "contributions_count": raw.get("contributionsCount"),
        "platforms": raw.get("contribution_social_platforms") or [],
        "contribution_types": raw.get("contribution_types_allowed") or [],
        "is_private": bool(raw.get("isPrivate")),
        "locations": raw.get("location") or [],
        "deadline_enabled": bool(raw.get("deadline")),
        "end_time": end_time,
        "published_time": published,
        "url": _challenge_url(slug, challenge_id),
        "description_preview": description_plain[:280] if description_plain else "",
        "tags": _crypto_tags(brand, raw.get("name") or "", description_plain),
    }


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"seen_ids": [], "last_run": None}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"seen_ids": [], "last_run": None}


def save_state(seen_ids: list[str]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"seen_ids": seen_ids[-500:], "last_run": _utc_now()}, indent=2) + "\n",
        encoding="utf-8",
    )


def diff_new(challenges: list[dict], seen_ids: set[str]) -> list[dict]:
    return [c for c in challenges if c.get("id") and c["id"] not in seen_ids]


def to_markdown(payload: dict) -> str:
    lines = [
        f"# GIMI Discover — {payload['date']}",
        "",
        f"Scraped: {payload['scraped_at']}",
        f"Total: {payload['counts']['total']} | Ongoing: {payload['counts']['ongoing']} | New: {payload['counts']['new']}",
        "",
    ]

    if payload.get("new_challenges"):
        lines.extend(["## New since last run", ""])
        for c in payload["new_challenges"]:
            lines.append(
                f"- **{c['name']}** — {c['brand']} | pool ${c.get('budget_usd') or '?'} | "
                f"status={c.get('status')} | contrib={c.get('contributions_count')}"
            )
            if c.get("tags"):
                lines.append(f"  tags: {', '.join(c['tags'])}")
            lines.append(f"  {c['url']}")
        lines.append("")

    lines.extend(["## Ongoing challenges", ""])
    ongoing = [c for c in payload["challenges"] if c.get("status") == "ongoing"]
    for c in sorted(ongoing, key=lambda x: (x.get("budget_usd") or 0), reverse=True)[:25]:
        lines.append(
            f"- **{c['name']}** — {c['brand']} | ${c.get('budget_usd') or '?'} | "
            f"approval ${c.get('approval_bonus_usd') or '?'} | platforms={','.join(c.get('platforms') or [])}"
        )
        if c.get("end_time"):
            lines.append(f"  ends: {c['end_time']}")
        lines.append(f"  {c['url']}")
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def export_signals(new_challenges: list[dict], ongoing: list[dict]) -> list[dict]:
    """Tier-4 stub: research signals for Hermes (not Solana mints)."""
    existing: list[dict] = []
    if SIGNALS_FILE.exists():
        try:
            existing = json.loads(SIGNALS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = []

    by_id = {s.get("challenge_id"): s for s in existing if s.get("challenge_id")}
    scraped_at = _utc_now()

    for c in new_challenges:
        by_id[c["id"]] = {
            "source": "gimi",
            "status": "pending",
            "scraped_at": scraped_at,
            "is_new": True,
            "challenge_id": c["id"],
            "slug": c.get("slug"),
            "name": c.get("name"),
            "brand": c.get("brand"),
            "budget_usd": c.get("budget_usd"),
            "challenge_status": c.get("status"),
            "platforms": c.get("platforms"),
            "tags": c.get("tags"),
            "url": c.get("url"),
            "note": "GIMI challenge — research signal only, not a Solana pool mint",
        }

    # Refresh top ongoing crypto-adjacent challenges
    for c in ongoing:
        if "crypto-adjacent" not in (c.get("tags") or []):
            continue
        if c["id"] in by_id and by_id[c["id"]].get("is_new"):
            continue
        by_id[c["id"]] = {
            "source": "gimi",
            "status": by_id.get(c["id"], {}).get("status", "pending"),
            "scraped_at": scraped_at,
            "is_new": False,
            "challenge_id": c["id"],
            "slug": c.get("slug"),
            "name": c.get("name"),
            "brand": c.get("brand"),
            "budget_usd": c.get("budget_usd"),
            "challenge_status": c.get("status"),
            "platforms": c.get("platforms"),
            "tags": c.get("tags"),
            "url": c.get("url"),
            "note": "GIMI crypto-adjacent challenge — manual mapping to token/pool if needed",
        }

    signals = list(by_id.values())
    signals.sort(key=lambda s: (not s.get("is_new"), -(s.get("budget_usd") or 0)))
    return signals[:100]


def main() -> int:
    parser = argparse.ArgumentParser(description="Monitor GIMI Discover challenges")
    parser.add_argument("--limit", type=int, default=100, help="Page size per API call")
    parser.add_argument("--category", default="featured", help="Spark API category")
    parser.add_argument("--sort-by", default="recent", dest="sort_by")
    parser.add_argument("--ongoing-only", action="store_true", help="Drop completed challenges")
    parser.add_argument("--export-signals", action="store_true", help="Write notes/gimi-signals.json")
    parser.add_argument("--max-pages", type=int, default=3)
    args = parser.parse_args()

    try:
        raw_rows = fetch_all_challenges(
            limit=args.limit,
            category=args.category,
            sort_by=args.sort_by,
            max_pages=args.max_pages,
        )
    except urllib.error.URLError as exc:
        print(f"GIMI API error: {exc}", file=sys.stderr)
        return 1

    challenges = [normalize_challenge(row) for row in raw_rows]
    if args.ongoing_only:
        challenges = [c for c in challenges if c.get("status") == "ongoing"]

    state = load_state()
    seen_ids = set(state.get("seen_ids") or [])
    new_challenges = diff_new(challenges, seen_ids)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    payload = {
        "date": today,
        "scraped_at": _utc_now(),
        "source": f"{API_BASE}/spark",
        "category": args.category,
        "counts": {
            "total": len(challenges),
            "ongoing": sum(1 for c in challenges if c.get("status") == "ongoing"),
            "completed": sum(1 for c in challenges if c.get("status") == "completed"),
            "new": len(new_challenges),
        },
        "new_challenges": new_challenges,
        "challenges": challenges,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    json_path = OUT_DIR / f"{today}.json"
    md_path = OUT_DIR / f"{today}.md"
    latest_path = OUT_DIR / "latest.json"

    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    latest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(to_markdown(payload), encoding="utf-8")

    all_ids = list(seen_ids | {c["id"] for c in challenges if c.get("id")})
    save_state(all_ids)

    if args.export_signals:
        ongoing = [c for c in challenges if c.get("status") == "ongoing"]
        signals = export_signals(new_challenges, ongoing)
        SIGNALS_FILE.write_text(json.dumps(signals, indent=2) + "\n", encoding="utf-8")
        print(f"Signals: {SIGNALS_FILE} ({len(signals)} rows)", file=sys.stderr)

    print(
        f"GIMI monitor OK — total={payload['counts']['total']} "
        f"ongoing={payload['counts']['ongoing']} new={payload['counts']['new']}",
        file=sys.stderr,
    )
    print(json.dumps({
        "ok": True,
        "json": str(json_path),
        "markdown": str(md_path),
        "latest": str(latest_path),
        "counts": payload["counts"],
        "new": [c["name"] for c in new_challenges[:10]],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())