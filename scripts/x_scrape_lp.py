#!/usr/bin/env python3
"""
Batch-scrape LP / Meteora X accounts via GetXAPI.

Usage:
  python3 scripts/x_scrape_lp.py                    # Tier 1 daily (default)
  python3 scripts/x_scrape_lp.py --tier all         # daily + weekly + automation
  python3 scripts/x_scrape_lp.py --user met_lparmy --count 10
  python3 scripts/x_scrape_lp.py --search           # keyword queries only
  python3 scripts/x_scrape_lp.py --threads          # also resolve self-threads

Output: notes/x-scrape/YYYY-MM-DD.{json,md}

API key: GETXAPI_KEY or ~/.meridian/secrets/getxapi.key (same as x_thread.py)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_BASE = "https://api.getxapi.com"
OUT_DIR = ROOT / "notes" / "x-scrape"

TIER_DAILY = [
    ("met_lparmy", "Printboard, bounty, academy"),
    ("MeteoraAG", "Official product updates"),
    ("web3probe", "DLMM mega-thread / case studies"),
    ("Jaypee_Sol", "LP Army content threads"),
    ("MeteoraIDN", "Komunitas LP Indonesia"),
]

TIER_WEEKLY = [
    ("Heavymetalcook6", "Bootcamp lead / fundamentals"),
    ("tendorian9", "Evil Panda / Logical TA"),
    ("bengsharksol", "Zen bid-ask, IL protection (ID)"),
    ("MeteoraFR", "Anti-rug checklist, bin step"),
    ("GeekLad", "DLMM screener / analytics"),
    ("Friday_SOL", "Market structure"),
    ("0xSoju", "Meteora co-lead macro"),
]

TIER_AUTOMATION = [
    ("meridian_agent", "Our autonomous agent"),
    ("met_engine", "Copy LP / Telegram"),
    ("liquid_nova", "Auto-rebalance bot"),
    ("SOL_Decoder", "DLMM farmer Discord"),
    ("ponkexchange", "Ponk Clouds autonomous LP"),
    ("RocketScan_fun", "On-chain pool scanner"),
    ("UseUltraLP", "PnL copilot"),
]

SEARCH_QUERIES = [
    "from:met_lparmy Printboard",
    "from:met_lparmy fee printing",
    '"autonomous DLMM" OR "Meteora bot"',
    '"rebalance bot" Meteora',
    "from:web3probe Meteora",
    "from:bengsharksol Meteora",
]

# Known high-value thread roots (optional deep fetch with --threads)
PINNED_THREADS = [
    ("web3probe", "1884158448746782868"),
    ("Jaypee_Sol", "2070442743101292955"),
    ("bengsharksol", "2060220900428177743"),
    ("MeteoraFR", "2069363008409580016"),
    ("met_lparmy", "2072809384783020393"),
]


def _load_key() -> str | None:
    env = (os.environ.get("GETXAPI_KEY") or "").strip()
    if env:
        return env
    key_file = Path.home() / ".meridian" / "secrets" / "getxapi.key"
    if key_file.is_file():
        val = key_file.read_text(encoding="utf-8").strip()
        if val:
            return val
    legacy = Path.home() / ".config" / "screening_g97" / "secrets" / "api_keys.json"
    if legacy.is_file():
        try:
            data = json.loads(legacy.read_text(encoding="utf-8"))
            return (data.get("getxapi") or {}).get("key")
        except (OSError, json.JSONDecodeError):
            pass
    return None


def api_get(path: str, api_key: str) -> dict:
    import http.client
    last_exc = None
    for attempt in range(3):
        try:
            url = f"{API_BASE}/{path}"
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (http.client.IncompleteRead, urllib.error.URLError, OSError) as exc:
            last_exc = exc
            print(f"[RETRY] api_get failed (attempt {attempt+1}/3): {exc}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise last_exc  # type: ignore[union-attr]


def fetch_user_tweets(user: str, count: int, api_key: str) -> list[dict]:
    params = urllib.parse.urlencode({"userName": user, "count": count})
    data = api_get(f"twitter/user/tweets?{params}", api_key)
    tweets = data.get("tweets") or []
    for tw in tweets:
        tw["_source_user"] = user
    return tweets


def fetch_search(q: str, count: int, api_key: str) -> list[dict]:
    params = urllib.parse.urlencode({"q": q, "queryType": "Latest", "count": count})
    data = api_get(f"twitter/tweet/advanced_search?{params}", api_key)
    tweets = data.get("tweets") or []
    for tw in tweets:
        tw["_search_query"] = q
    return tweets


def fetch_thread(tweet_id: str, api_key: str) -> dict:
    return api_get(f"twitter/tweet/thread?id={tweet_id}", api_key)


def _is_thread_starter(tw: dict) -> bool:
    if tw.get("isReply"):
        return False
    text = (tw.get("text") or "").lower()
    return "🧵" in (tw.get("text") or "") or "thread" in text or "👇" in (tw.get("text") or "")


def _tweet_summary(tw: dict) -> dict:
    author = tw.get("author") or {}
    return {
        "id": tw.get("id"),
        "url": tw.get("url") or tw.get("twitterUrl"),
        "user": author.get("userName") or tw.get("_source_user"),
        "createdAt": tw.get("createdAt"),
        "likes": tw.get("likeCount"),
        "retweets": tw.get("retweetCount"),
        "views": tw.get("viewCount"),
        "text": (tw.get("text") or "").strip(),
        "isReply": tw.get("isReply"),
        "isPinned": tw.get("isPinned"),
    }


def _format_thread_text(data: dict) -> str:
    tweets = data.get("tweets") or data.get("thread") or data.get("data") or []
    if isinstance(tweets, dict):
        tweets = tweets.get("tweets") or []
    lines: list[str] = []
    for i, tw in enumerate(tweets, 1):
        author = tw.get("screenName") or tw.get("userName") or (tw.get("author") or {}).get("userName") or "?"
        text = (tw.get("text") or tw.get("full_text") or "").strip()
        lines.append(f"[{i}] @{author}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).strip()


def _dedupe_accounts(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for user, note in rows:
        key = user.lower().lstrip("@")
        if key in seen:
            continue
        seen.add(key)
        out.append((key, note))
    return out


def _accounts_for_tier(tier: str) -> list[tuple[str, str]]:
    if tier == "daily":
        return _dedupe_accounts(TIER_DAILY)
    if tier == "weekly":
        return _dedupe_accounts(TIER_WEEKLY)
    if tier == "automation":
        return _dedupe_accounts(TIER_AUTOMATION)
    if tier == "all":
        return _dedupe_accounts(TIER_DAILY + TIER_WEEKLY + TIER_AUTOMATION)
    raise ValueError(f"Unknown tier: {tier}")


def build_markdown(payload: dict) -> str:
    lines = [
        f"# X LP Scrape — {payload['date']}",
        "",
        f"Generated: {payload['scraped_at']}",
        f"Tier: `{payload['tier']}` | Users: {len(payload.get('users', {}))} | "
        f"Searches: {len(payload.get('searches', {}))} | Threads: {len(payload.get('threads', {}))}",
        "",
    ]

    for user, block in sorted(payload.get("users", {}).items()):
        lines.append(f"## @{user}")
        if block.get("note"):
            lines.append(f"*{block['note']}*")
            lines.append("")
        for tw in block.get("tweets", [])[:15]:
            likes = tw.get("likes") or 0
            lines.append(f"- [{tw.get('createdAt', '?')}] ♥{likes} — {tw.get('text', '')[:220]}")
            if tw.get("url"):
                lines.append(f"  {tw['url']}")
        lines.append("")

    if payload.get("searches"):
        lines.append("## Keyword search")
        lines.append("")
        for q, tweets in payload["searches"].items():
            lines.append(f"### `{q}`")
            for tw in tweets[:8]:
                lines.append(f"- @{tw.get('user')} ♥{tw.get('likes')} — {tw.get('text', '')[:200]}")
            lines.append("")

    if payload.get("threads"):
        lines.append("## Resolved threads")
        lines.append("")
        for tid, block in payload["threads"].items():
            lines.append(f"### {block.get('label', tid)}")
            lines.append(f"URL: {block.get('url', '')}")
            lines.append("")
            lines.append(block.get("text", "")[:8000])
            lines.append("")

    return "\n".join(lines).strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch scrape Meteora LP X accounts via GetXAPI")
    parser.add_argument("--tier", default="daily", choices=["daily", "weekly", "automation", "all"])
    parser.add_argument("--user", help="Scrape single user only")
    parser.add_argument("--count", type=int, default=8, help="Tweets per user (default 8)")
    parser.add_argument("--search", action="store_true", help="Run keyword searches only")
    parser.add_argument("--threads", action="store_true", help="Fetch pinned threads + thread starters")
    parser.add_argument("--search-count", type=int, default=10, help="Results per search query")
    parser.add_argument("--delay", type=float, default=0.6, help="Seconds between API calls")
    args = parser.parse_args()

    api_key = _load_key()
    if not api_key:
        print(
            "Missing GETXAPI_KEY — set ~/.meridian/secrets/getxapi.key\n"
            "See meridian/notes/GETXAPI.md",
            file=sys.stderr,
        )
        return 1

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    payload: dict = {
        "date": today,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "tier": args.tier,
        "users": {},
        "searches": {},
        "threads": {},
    }

    try:
        if not args.search:
            accounts = (
                [(args.user.lstrip("@"), "manual")]
                if args.user
                else _accounts_for_tier(args.tier)
            )
            for user, note in accounts:
                print(f"Fetching @{user}...", file=sys.stderr)
                raw = fetch_user_tweets(user, args.count, api_key)
                payload["users"][user] = {
                    "note": note,
                    "tweets": [_tweet_summary(tw) for tw in raw if not tw.get("retweeted_tweet")],
                }
                time.sleep(args.delay)

                if args.threads:
                    for tw in raw:
                        if _is_thread_starter(tw) and tw.get("id"):
                            tid = str(tw["id"])
                            if tid in payload["threads"]:
                                continue
                            print(f"  thread @{user}/{tid}...", file=sys.stderr)
                            th = fetch_thread(tid, api_key)
                            payload["threads"][tid] = {
                                "label": f"@{user} thread",
                                "url": tw.get("url"),
                                "text": _format_thread_text(th),
                            }
                            time.sleep(args.delay)

        if args.search or (not args.user and args.tier in ("daily", "all")):
            for q in SEARCH_QUERIES:
                print(f"Search: {q}...", file=sys.stderr)
                raw = fetch_search(q, args.search_count, api_key)
                payload["searches"][q] = [_tweet_summary(tw) for tw in raw]
                time.sleep(args.delay)

        if args.threads and not args.search:
            for user, tid in PINNED_THREADS:
                if tid in payload["threads"]:
                    continue
                print(f"Pinned thread @{user}/{tid}...", file=sys.stderr)
                th = fetch_thread(tid, api_key)
                payload["threads"][tid] = {
                    "label": f"@{user} pinned",
                    "url": f"https://x.com/{user}/status/{tid}",
                    "text": _format_thread_text(th),
                }
                time.sleep(args.delay)

    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"GetXAPI HTTP {exc.code}: {body}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    json_path = OUT_DIR / f"{today}.json"
    md_path = OUT_DIR / f"{today}.md"
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    md_path.write_text(build_markdown(payload), encoding="utf-8")

    n_tweets = sum(len(v.get("tweets", [])) for v in payload["users"].values())
    print(f"OK — {n_tweets} tweets, {len(payload['searches'])} searches, {len(payload['threads'])} threads")
    print(f"  {json_path}")
    print(f"  {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())