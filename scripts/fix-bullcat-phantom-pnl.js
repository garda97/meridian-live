#!/usr/bin/env node
/**
 * One-shot correction for BULLCAT Gzn6qbn phantom -60% close (Meteora API race).
 * Run: node scripts/fix-bullcat-phantom-pnl.js
 */
import fs from "fs";
import { repoPath } from "../repo-root.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";

const POS = "Gzn6qbnZPekXKSRkUBRMjsgrYX8cmjSYz4eEH1s7fQ7m";
const POOL = "3smCBC81NpS4MVzbMkZEpn8pwS9sN8jsM3SS43qLBC4f";

const FIX = {
  pnl_usd: 0.0338,
  pnl_pct: 0.058,
  final_value_usd: 58.126,
  initial_value_usd: 58.129273140339734,
};

function loadJson(name) {
  const p = repoPath(name);
  return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
}

function saveJson(path, data) {
  atomicWriteFileSync(path, JSON.stringify(data, null, 2));
}

// lessons.json
{
  const { path, data } = loadJson("lessons.json");
  const lesson = data.lessons?.find((l) => l.id === 1784157767685);
  if (lesson) {
    lesson.rule = lesson.rule
      .replace("FAILED:", "NEUTRAL:")
      .replace("PnL -60.68%", "PnL +0.06% (corrected from phantom -60.68% API race)");
    lesson.outcome = "neutral";
    lesson.tags = ["breakeven", "low_yield"];
    lesson.pnl_pct = FIX.pnl_pct;
  }
  const perf = data.performance?.find((p) => p.position === POS);
  if (perf) {
    Object.assign(perf, {
      pnl_usd: FIX.pnl_usd,
      pnl_pct: FIX.pnl_pct,
      final_value_usd: FIX.final_value_usd,
      initial_value_usd: FIX.initial_value_usd,
    });
  }
  saveJson(path, data);
  console.log("lessons.json: corrected");
}

// decision-log.json
{
  const { path, data } = loadJson("decision-log.json");
  for (const d of data.decisions || []) {
    if (d.type === "close" && d.position === POS) {
      d.summary = `Closed at +${FIX.pnl_pct.toFixed(2)}% (corrected from phantom -60.68%)`;
      d.metrics.pnl_usd = FIX.pnl_usd;
      d.metrics.pnl_pct = FIX.pnl_pct;
    }
  }
  saveJson(path, data);
  console.log("decision-log.json: corrected close entry");
}

// state.json
{
  const { path, data } = loadJson("state.json");
  const outcome = data.closedOutcomes?.find((o) => o.position === POS);
  if (outcome) outcome.pnl_pct = FIX.pnl_pct;
  saveJson(path, data);
  console.log("state.json: corrected closedOutcomes");
}

// pool-memory.json
{
  const { path, data } = loadJson("pool-memory.json");
  const pool = data[POOL];
  if (pool) {
    const dep = pool.deploys?.find((d) => d.closed_at === "2026-07-15T23:22:47.685Z");
    if (dep) {
      dep.pnl_usd = FIX.pnl_usd;
      dep.pnl_pct = FIX.pnl_pct;
    }
    const pnls = (pool.deploys || []).map((d) => Number(d.pnl_pct)).filter(Number.isFinite);
    pool.avg_pnl_pct = pnls.length ? Math.round((pnls.reduce((a, b) => a + b, 0) / pnls.length) * 100) / 100 : 0;
    pool.win_rate = pnls.length ? pnls.filter((p) => p > 0).length / pnls.length : 0;
    pool.last_outcome = FIX.pnl_pct >= 0 ? "breakeven" : "loss";
    // Low-yield cooldown stays; remove erroneous loss cooldown from phantom -60%
    pool.cooldown_until = "2026-07-16T03:22:47.704Z";
    pool.cooldown_reason = "low yield close";
    delete pool.base_mint_cooldown_until;
    delete pool.base_mint_cooldown_reason;
  }
  saveJson(path, data);
  console.log("pool-memory.json: corrected deploy + stats + cooldowns");
}

console.log("Done. Daily loss gate should unblock (phantom -$35 removed).");