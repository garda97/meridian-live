#!/usr/bin/env python3
"""
Fetch an X/Twitter thread via GetXAPI.

Usage:
  python3 scripts/x_thread.py <tweet_id_or_url>
  python3 scripts/x_thread.py https://x.com/user/status/1234567890

API key (first match wins):
  GETXAPI_KEY env
  ~/.meridian/secrets/getxapi.key
  ~/.config/screening_g97/secrets/api_keys.json (legacy backup)
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_BASE = "https://api.getxapi.com"


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


def _parse_tweet_id(raw: str) -> str:
    raw = raw.strip()
    m = re.search(r"/status/(\d+)", raw)
    if m:
        return m.group(1)
    if raw.isdigit():
        return raw
    raise ValueError(f"Could not parse tweet id from: {raw}")


def fetch_thread(tweet_id: str, api_key: str) -> dict:
    url = f"{API_BASE}/twitter/tweet/thread?id={tweet_id}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def format_thread(data: dict) -> str:
    tweets = data.get("tweets") or data.get("thread") or data.get("data") or []
    if isinstance(tweets, dict):
        tweets = tweets.get("tweets") or []
    if not tweets:
        return json.dumps(data, indent=2, ensure_ascii=False)

    lines: list[str] = []
    for i, tw in enumerate(tweets, 1):
        author = tw.get("screenName") or tw.get("userName") or tw.get("author") or "?"
        text = (tw.get("text") or tw.get("full_text") or "").strip()
        created = tw.get("createdAt") or tw.get("created_at") or ""
        likes = tw.get("likeCount") or tw.get("favorite_count")
        lines.append(f"[{i}] @{author} {created}".strip())
        lines.append(text)
        if likes is not None:
            lines.append(f"  ♥ {likes}")
        lines.append("")
    return "\n".join(lines).strip()


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/x_thread.py <tweet_id_or_url>", file=sys.stderr)
        return 2

    api_key = _load_key()
    if not api_key:
        print(
            "Missing GETXAPI_KEY. Copy API key from https://www.getxapi.com/dashboard\n"
            "then: echo 'get-x-api-...' > ~/.meridian/secrets/getxapi.key && chmod 600 ~/.meridian/secrets/getxapi.key",
            file=sys.stderr,
        )
        return 1

    try:
        tweet_id = _parse_tweet_id(sys.argv[1])
        data = fetch_thread(tweet_id, api_key)
        print(format_thread(data))
        return 0
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"GetXAPI HTTP {exc.code}: {body}", file=sys.stderr)
        if exc.code == 401:
            print("API key invalid — paste fresh key from https://www.getxapi.com/dashboard", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())