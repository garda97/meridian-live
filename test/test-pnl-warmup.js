/**
 * Unit tests for the PnL warmup guard (phantom spike fix — FABLE +74% 5s
 * after deploy fired trailing TP and closed at 0% real).
 * Run: node test/test-pnl-warmup.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  isInPnlWarmup,
  canFireTakeProfit,
  trackPosition,
  confirmPeak,
  updatePnlAndCheckExits,
  getTrackedPosition,
} from "../state.js";

const STATE_PATH = repoPath("state.json");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── isInPnlWarmup (pure) ───────────────────────────────────────
const now = Date.now();
const fresh = { deployed_at: new Date(now - 60_000).toISOString() }; // 1m old
const old = { deployed_at: new Date(now - 10 * 60_000).toISOString() }; // 10m old

assert(isInPnlWarmup(fresh, 3, now), "1m-old position must be in 3m warmup");
assert(!isInPnlWarmup(old, 3, now), "10m-old position must be out of 3m warmup");
assert(!isInPnlWarmup(fresh, 0, now), "warmup 0 must be off");
assert(!isInPnlWarmup(fresh, null, now), "warmup null must be off");
assert(!isInPnlWarmup(null, 3, now), "missing position must not be in warmup");
assert(!isInPnlWarmup({}, 3, now), "position without timestamps must not be in warmup");

// Rebalance restarts the clock — new deposits, new phantom risk
const rebalanced = {
  deployed_at: new Date(now - 60 * 60_000).toISOString(), // 1h old deploy
  last_rebalance_at: new Date(now - 60_000).toISOString(), // rebalanced 1m ago
};
assert(isInPnlWarmup(rebalanced, 3, now), "recent rebalance must restart the warmup clock");

// ── canFireTakeProfit (sultan phantom-TP guard) ─────────────────
const tpMgmt = { pnlWarmupMinutes: 10, minAgeBeforeTakeProfit: 10, pnlSanityMaxDiffPct: 5 };
const youngTracked = { deployed_at: new Date(now - 3 * 60_000).toISOString() };
assert(!canFireTakeProfit({ age_minutes: 3, pnl_pct: 50, pnl_pct_diff: 63 }, youngTracked, tpMgmt), "3m-old +50% phantom must block TP");
assert(!canFireTakeProfit({ age_minutes: 8, pnl_pct: 50, pnl_pct_diff: 0.5 }, youngTracked, tpMgmt), "8m-old still inside minAgeBeforeTakeProfit=10");
const matureTracked = { deployed_at: new Date(now - 12 * 60_000).toISOString() };
assert(canFireTakeProfit({ age_minutes: 12, pnl_pct: 9, pnl_pct_diff: 1 }, matureTracked, tpMgmt), "12m-old clean tick must allow TP");

// ── confirmPeak + trailing under warmup (state round-trip) ────
const saved = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, "utf8") : null;
try {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));
  trackPosition({ position: "WARM_POS", pool: "WARM_POOL", pool_name: "WARM-SOL", strategy: "spot", amount_sol: 0.5 });
  // deployed_at is "now" → inside a 3m warmup

  // FABLE scenario: +74% phantom on two consecutive ticks during warmup
  let raised = confirmPeak("WARM_POS", 74.18, 2, 3);
  assert(!raised, "warmup tick 1 must not stage a peak");
  raised = confirmPeak("WARM_POS", 74.18, 2, 3);
  assert(!raised, "warmup tick 2 must not confirm the phantom peak");
  let pos = getTrackedPosition("WARM_POS");
  assert((pos.peak_pnl_pct ?? 0) === 0, `peak must stay 0 during warmup, got ${pos.peak_pnl_pct}`);
  assert(pos.pending_peak_pnl_pct == null, "no pending peak may survive warmup ticks");

  // Trailing must not arm during warmup even if a peak somehow exists
  const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 3, trailingDropPct: 1.5, stopLossPct: -12, outOfRangeWaitMinutes: 30, minFeePerTvl24h: 0, pnlWarmupMinutes: 3 };
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  state.positions.WARM_POS.peak_pnl_pct = 74; // simulate pre-fix contamination
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  updatePnlAndCheckExits("WARM_POS", { pnl_pct: 74, in_range: true }, mgmt);
  pos = getTrackedPosition("WARM_POS");
  assert(pos.trailing_active !== true, "trailing must not arm during warmup");

  // Stop loss must STAY LIVE during warmup (real rug protection)
  const exit = updatePnlAndCheckExits("WARM_POS", { pnl_pct: -15, in_range: true }, mgmt);
  assert(exit?.action === "STOP_LOSS", `stop loss must fire during warmup, got ${exit?.action}`);

  // After warmup expires, the same peak flow works normally
  const state2 = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  state2.positions.WARM_POS.deployed_at = new Date(Date.now() - 10 * 60_000).toISOString();
  state2.positions.WARM_POS.peak_pnl_pct = 0;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state2));
  confirmPeak("WARM_POS", 5, 2, 3);
  raised = confirmPeak("WARM_POS", 5, 2, 3);
  assert(raised, "post-warmup peak must confirm on 2 ticks");
  pos = getTrackedPosition("WARM_POS");
  assert(pos.peak_pnl_pct === 5, `post-warmup peak must be 5, got ${pos.peak_pnl_pct}`);
  updatePnlAndCheckExits("WARM_POS", { pnl_pct: 5, in_range: true }, mgmt);
  pos = getTrackedPosition("WARM_POS");
  assert(pos.trailing_active === true, "trailing must arm normally after warmup");

  console.log("  pnl-warmup: phantom peak blocked, trailing gated, SL live, rebalance clock, post-warmup normal OK");
} finally {
  if (saved == null) fs.unlinkSync(STATE_PATH);
  else fs.writeFileSync(STATE_PATH, saved);
}

console.log("test-pnl-warmup: OK");
