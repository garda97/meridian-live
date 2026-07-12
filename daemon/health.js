/**
 * HTTP health-check endpoint (2026-07-12, ported concept from an external
 * Meteora DLMM bot — see notes/fees-maxi-comparison.md). Opt-in via
 * HEALTH_PORT env var — no server starts unless it's set. Built on Node's
 * built-in http module, no new dependency.
 *
 * GET / -> { ok, status, lastTickTs, staleMs } — 503 when the loop looks
 * wedged (neither cycle has ticked within staleAfterMs), 200 otherwise.
 * Meant for external uptime monitoring (UptimeRobot etc.), independent of
 * the internal busy-flag watchdog in daemon/engine.js (that one force-resets
 * a stuck flag; this one just reports state to something outside the process).
 */
import http from "http";
import { log } from "../logger.js";
import { timers } from "./runtime.js";
import { isEngineBusy, isCronStarted } from "./engine.js";

const DEFAULT_STALE_AFTER_MS = 15 * 60_000; // 15min — well past both cycles' normal intervals

export function startHealthServer(staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const port = Number(process.env.HEALTH_PORT);
  if (!Number.isFinite(port) || port <= 0) return null;

  const server = http.createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const lastTickTs = Math.max(timers.managementLastRun || 0, timers.screeningLastRun || 0);
    const staleMs = lastTickTs ? Date.now() - lastTickTs : null;
    const stale = isCronStarted() && (staleMs == null || staleMs > staleAfterMs);
    const body = {
      ok: !stale,
      status: stale ? "stale" : isEngineBusy() ? "busy" : "ok",
      lastTickTs,
      staleMs,
    };
    res.writeHead(stale ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  server.listen(port, () => {
    log("init", `Health check server listening on :${port}`);
  });
  server.on("error", (e) => {
    log("init_error", `Health server failed: ${e.message}`);
  });
  return server;
}
