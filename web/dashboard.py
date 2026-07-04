#!/usr/bin/env python3
"""
Meridian ops dashboard — wallet, positions, decisions, logs.

Run:
    python3 -m web.dashboard
    uvicorn web.dashboard:app --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_ROOT = Path(__file__).resolve().parent.parent
_STATIC = Path(__file__).resolve().parent / "static"
_PORT = int(os.environ.get("MERIDIAN_DASHBOARD_PORT", "8765"))
_SECRET = (os.environ.get("MERIDIAN_DASHBOARD_SECRET") or os.environ.get("DASHBOARD_SECRET") or "").strip()

try:
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import HTMLResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles
except ImportError:
    FastAPI = None  # type: ignore
    StaticFiles = None  # type: ignore


def _static_v(name: str) -> str:
    path = _STATIC / name
    try:
        return str(int(path.stat().st_mtime))
    except OSError:
        return "0"


def _read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _tail_log(path: Path, lines: int = 80) -> str:
    if not path.exists():
        return ""
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(content[-lines:])
    except OSError:
        return ""


def _find_daemon_pid() -> Optional[int]:
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "node index.js"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        pids = [int(p) for p in out.strip().splitlines() if p.strip().isdigit()]
        return pids[0] if pids else None
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


def _run_cli(args: list[str], timeout: float = 12.0) -> dict[str, Any]:
    cmd = ["node", "cli.js", *args]
    try:
        proc = subprocess.run(
            cmd,
            cwd=_ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "DRY_RUN": os.environ.get("DRY_RUN", "true")},
        )
        stdout = (proc.stdout or "").strip()
        if stdout:
            try:
                return {"ok": proc.returncode == 0, "data": json.loads(stdout)}
            except json.JSONDecodeError:
                return {"ok": proc.returncode == 0, "raw": stdout}
        return {"ok": proc.returncode == 0, "error": (proc.stderr or "").strip() or "empty output"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


def _auth_ok(request: Request) -> bool:
    if not _SECRET:
        return True
    key = request.query_params.get("key") or request.headers.get("x-dashboard-key", "")
    return key == _SECRET


def _require_auth(request: Request) -> None:
    if request.url.path in ("/health", "/favicon.ico") or request.url.path.startswith("/static/"):
        return
    if not _auth_ok(request):
        raise HTTPException(status_code=401, detail="Invalid or missing dashboard key")


def _build_status() -> dict[str, Any]:
    user_cfg = _read_json(_ROOT / "user-config.json", {})
    bridge = _read_json(_ROOT / "notes" / "BRIDGE.json", {})
    state = _read_json(_ROOT / "state.json", {})
    decisions = _read_json(_ROOT / "decision-log.json", {"decisions": []})
    pid = _find_daemon_pid()
    dry_run = os.environ.get("DRY_RUN", "").lower() == "true" or user_cfg.get("dryRun", False)
    return {
        "project": "meridian",
        "phase": bridge.get("phase") or "learning_dry_run",
        "daemon": {
            "running": pid is not None,
            "pid": pid,
        },
        "dry_run": dry_run,
        "model": user_cfg.get("llmModel") or user_cfg.get("screeningModel"),
        "wallet_hint": None,
        "intervals": {
            "screening_min": user_cfg.get("screeningIntervalMin", 30),
            "management_min": user_cfg.get("managementIntervalMin", 10),
        },
        "risk": {
            "max_positions": user_cfg.get("maxPositions", 3),
            "deploy_sol": user_cfg.get("deployAmountSol", 0.5),
        },
        "positions_tracked": len((state or {}).get("positions") or {}),
        "decisions_count": len((decisions or {}).get("decisions") or []),
        "bridge_updated": bridge.get("updated_at"),
        "latest_handoff": bridge.get("latest"),
        "ts": datetime.now(timezone.utc).isoformat(),
    }


if FastAPI is not None:
    app = FastAPI(title="Meridian Dashboard", docs_url=None, redoc_url=None)
    app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        _require_auth(request)
        return await call_next(request)

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "meridian-dashboard"}

    @app.get("/api/status")
    async def api_status():
        return _build_status()

    @app.get("/api/wallet")
    async def api_wallet():
        return _run_cli(["balance"])

    @app.get("/api/positions")
    async def api_positions():
        cli = _run_cli(["positions"], timeout=20.0)
        state = _read_json(_ROOT / "state.json", {})
        return {"cli": cli, "state": state}

    @app.get("/api/decisions")
    async def api_decisions(limit: int = 20):
        data = _read_json(_ROOT / "decision-log.json", {"decisions": []})
        decisions = (data or {}).get("decisions") or []
        return {"decisions": decisions[: max(1, min(limit, 50))]}

    @app.get("/api/config")
    async def api_config():
        cfg = _read_json(_ROOT / "user-config.json", {})
        keys = [
            "minTvl", "maxTvl", "minVolume", "minOrganic", "minHolders", "minMcap",
            "maxMcap", "minFeeActiveTvlRatio", "minTokenFeesSol", "minTokenFeesSolPer100kMcap",
            "maxTop10Pct", "rugcheckTop10MaxPct", "maxBotHoldersPct", "strategy",
            "deployAmountSol", "maxPositions", "trailingTriggerPct", "trailingDropPct",
            "stopLossPct", "partialTpEnabled", "solRegimeGateEnabled",
            "dryRun", "llmModel", "screeningModel", "managementModel",
            "screeningIntervalMin", "managementIntervalMin", "timeframe", "category",
        ]
        return {"screening": {k: cfg.get(k) for k in keys if k in cfg}}

    @app.get("/api/logs")
    async def api_logs(lines: int = 80):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        log_dir = _ROOT / "logs"
        candidates = [
            log_dir / f"agent-{today}.log",
            log_dir / "agent.log",
        ]
        for path in sorted(log_dir.glob("agent-*.log"), reverse=True):
            candidates.append(path)
        for path in candidates:
            text = _tail_log(path, max(10, min(lines, 200)))
            if text:
                return {"file": str(path.name), "lines": text}
        return {"file": None, "lines": ""}

    @app.get("/api/bridge")
    async def api_bridge():
        return _read_json(_ROOT / "notes" / "BRIDGE.json", {})

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request):
        key_q = f"?key={request.query_params.get('key')}" if request.query_params.get("key") else ""
        css_v = _static_v("dashboard.css")
        mer_v = _static_v("meridian.css")
        js_v = _static_v("meridian.js")
        html = _HTML.replace("{{KEY_QUERY}}", key_q).replace("{{CSS_V}}", css_v).replace("{{MER_V}}", mer_v).replace("{{JS_V}}", js_v)
        return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})
else:
    app = None


_HTML = """<!DOCTYPE html>
<html lang="id" class="dark">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="theme-color" content="#080c18"/>
  <title>Meridian — DLMM LP Agent</title>
  <link rel="icon" href="/static/favicon.svg"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
  <link rel="stylesheet" href="/static/dashboard.css?v={{CSS_V}}"/>
  <link rel="stylesheet" href="/static/meridian.css?v={{MER_V}}"/>
</head>
<body class="pro-site">
  <div class="bg-mesh"></div>
  <div class="wrap">
    <header class="site-header">
      <nav class="nav">
        <a class="brand" href="/">
          <div class="brand-mark">M</div>
          <div class="brand-text">
            <strong>Meridian</strong>
            <span>Meteora DLMM LP Agent</span>
            <span class="brand-built">Hermes · Grok · Claude</span>
          </div>
        </a>
        <div class="nav-right">
          <button type="button" id="theme-btn" class="icon-btn theme-btn" title="Ganti tema" aria-label="Ganti tema">☀</button>
        </div>
      </nav>
    </header>

    <section class="meridian-hero">
      <h1>Ops Dashboard</h1>
      <p>Live status daemon, wallet, posisi DLMM, keputusan screening, dan log agent.</p>
    </section>

    <div id="view-overview" class="dash-view is-active">
      <div class="stat-grid" id="stat-grid"></div>
      <article class="panel">
        <h2>Latest handoff</h2>
        <div id="handoff-box" class="mono" style="font-size:0.82rem;color:var(--muted)">—</div>
      </article>
      <article class="panel">
        <h2>Screening thresholds</h2>
        <div class="threshold-grid" id="threshold-grid"></div>
      </article>
    </div>

    <div id="view-positions" class="dash-view">
      <article class="panel">
        <h2>Open positions</h2>
        <div id="positions-box"></div>
      </article>
      <article class="panel">
        <h2>Wallet</h2>
        <div id="wallet-box" class="mono" style="font-size:0.82rem"></div>
      </article>
    </div>

    <div id="view-decisions" class="dash-view">
      <article class="panel">
        <h2>Decision log</h2>
        <div id="decisions-box"></div>
      </article>
    </div>

    <div id="view-logs" class="dash-view">
      <article class="panel">
        <h2>Agent log</h2>
        <pre class="log-pre" id="logs-box">Loading…</pre>
        <div class="refresh-note" id="refresh-note"></div>
      </article>
    </div>
  </div>

  <nav class="dash-bottom-nav" aria-label="Navigasi dashboard">
    <button type="button" class="dash-nav-btn is-active" data-view="overview">Overview</button>
    <button type="button" class="dash-nav-btn" data-view="positions">Positions</button>
    <button type="button" class="dash-nav-btn" data-view="decisions">Decisions</button>
    <button type="button" class="dash-nav-btn" data-view="logs">Logs</button>
  </nav>

  <script>window.MERIDIAN_CONFIG = { keyQuery: "{{KEY_QUERY}}" };</script>
  <script src="/static/meridian.js?v={{JS_V}}"></script>
</body>
</html>"""


def main() -> None:
    if FastAPI is None:
        raise SystemExit("Install: pip install fastapi uvicorn")
    import uvicorn

    uvicorn.run(
        "web.dashboard:app",
        host=os.environ.get("MERIDIAN_DASHBOARD_HOST", "127.0.0.1"),
        port=_PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()