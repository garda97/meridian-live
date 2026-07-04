#!/usr/bin/env python3
"""
Save GIMI Playwright storage state after manual login.

Usage (on machine with display or X11 forwarding):
  /root/meridian/.venv-gimi/bin/python3 scripts/gimi_auth_setup.py

Headless VPS (recommended):
  Use scripts/set-gimi-session.sh with Bearer token from browser DevTools instead.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRETS_DIR = Path.home() / ".meridian" / "secrets"
STORAGE_FILE = SECRETS_DIR / "gimi-storage.json"
VENV_PYTHON = ROOT / ".venv-gimi" / "bin" / "python3"


async def main() -> int:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("Playwright missing. Run: python3 -m venv .venv-gimi && .venv-gimi/bin/pip install playwright", file=sys.stderr)
        return 1

    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    print("Opening GIMI login — sign in manually, then press Enter in this terminal...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto("https://app.gimi.co/en/sign-in", wait_until="domcontentloaded")
        input("Press Enter after you are logged in and see Discover...")
        await context.storage_state(path=str(STORAGE_FILE))
        await browser.close()

    print(f"Saved Playwright storage → {STORAGE_FILE}")
    print("Optional: also run set-gimi-session.sh with Bearer token for API joins.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))