"""Shared GIMI API + auth helpers for monitor/join scripts."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SECRETS_DIR = Path.home() / ".meridian" / "secrets"
TOKEN_FILE = SECRETS_DIR / "gimi.session"
STORAGE_FILE = SECRETS_DIR / "gimi-storage.json"
API_BASE = "https://prod-bb-backend.thequestofevolution.com"
APP_BASE = "https://app.gimi.co/en"


class GimiAuthError(RuntimeError):
    pass


def load_session_token() -> str | None:
    env = os.environ.get("GIMI_SESSION_TOKEN", "").strip()
    if env:
        return env
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        return token or None
    return None


def has_playwright_storage() -> bool:
    return STORAGE_FILE.exists()


def auth_status() -> dict[str, Any]:
    token = load_session_token()
    return {
        "token_file": str(TOKEN_FILE),
        "storage_file": str(STORAGE_FILE),
        "has_token": bool(token),
        "has_storage": has_playwright_storage(),
        "ready": bool(token) or has_playwright_storage(),
    }


def _request(
    method: str,
    path: str,
    *,
    token: str | None = None,
    query: dict[str, str] | None = None,
    body: dict | None = None,
    timeout: int = 45,
) -> tuple[int, Any]:
    params = f"?{urllib.parse.urlencode(query)}" if query else ""
    url = f"{API_BASE}{path}{params}"
    data = None
    headers = {
        "User-Agent": "meridian-gimi-client/1.0",
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {"message": raw}
        except json.JSONDecodeError:
            payload = {"message": raw}
        return exc.code, payload


def get_user_info(token: str | None = None) -> tuple[int, Any]:
    token = token or load_session_token()
    if not token:
        raise GimiAuthError("No GIMI session token — run scripts/set-gimi-session.sh")
    return _request("GET", "/spark/user/info", token=token)


def join_spark(spark_id: str, token: str | None = None) -> tuple[int, Any]:
    token = token or load_session_token()
    if not token:
        raise GimiAuthError("No GIMI session token — run scripts/set-gimi-session.sh")
    return _request("GET", "/users/join-spark", token=token, query={"sparkId": spark_id})


def campaign_url(slug: str | None) -> str:
    if slug:
        return f"{APP_BASE}/campaigns/{slug}"
    return f"{APP_BASE}/discover"