/**
 * Regression test for the cross-rebalance stop-loss hole (ported from
 * fees-maxi risk.ts): a migrate rebalance re-keys the on-chain position
 * account, so the per-account pnl_pct resets its basis to the migrated
 * deposit. Before this fix each rebalance could eat up to stopLossPct again
 * without any single account tripping it. Covers:
 *  1. Migrated position: per-account tick says -3% but cumulative vs the
 *     ORIGINAL entry is -15% → STOP_LOSS fires (would NOT fire before).
 *  2. Never-rebalanced position: lifecycle math not applied, per-account
 *     tick governs exactly as before (backward compat).
 *  3. Lifecycle value includes lifecycle claimed fees + unclaimed fees —
 *     a position down in value but fee-cushioned above SL must NOT close.
 *  4. confirmPeakFromTick feeds the lifecycle candidate so peaks keep
 *     rising after a migrate (per-account tick would under-report).
 * Run: node test/test-cumulative-sl.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  trackPosition,
  recordRebalance,
  updatePnlAndCheckExits,
  computeLifecyclePnlPct,
  confirmPeakFromTick,
  getTrackedPosition,
} from "../state.js";

const STATE_PATH = repoPath("state.json");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function backup(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
}
function restore(path, data) {
  if (data == null) {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } else {
    fs.writeFileSync(path, data);
  }
}

// Pinned mgmt config (repo gotcha #1: never read live user-config in tests).
const MGMT = {
  stopLossPct: -12,
  takeProfitPct: 6,
  trailingTakeProfit: true,
  trailingTriggerPct: 2,
  trailingDropPct: 1,
  pnlWarmupMinutes: 0,
  outOfRangeWaitMinutes: 10,
};

function trackAt(id, initialUsd) {
  trackPosition({
    position: id, pool: `POOL_${id}`, pool_name: `CUMSL-SOL`,
    strategy: "bid_ask", amount_sol: 1, initial_value_usd: initialUsd,
  });
}

function migrate(oldId, newId) {
  return recordRebalance(oldId, {
    plan: { rebalance_type: "migrate", strategy: "bid_ask", reason: "test migrate" },
    new_position: newId,
  });
}

const saved = backup(STATE_PATH);
try {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));

  // 1. The hole: original entry $100, two migrates, per-account tick -3%
  //    but the position is now worth $85 → cumulative -15% ≤ SL -12.
  trackAt("CUMSL_1", 100);
  migrate("CUMSL_1", "CUMSL_1B");
  migrate("CUMSL_1B", "CUMSL_1C");
  const exit1 = updatePnlAndCheckExits("CUMSL_1C", {
    pnl_pct: -3, total_value_true_usd: 85, unclaimed_fees_true_usd: 0,
    in_range: true,
  }, MGMT);
  assert(exit1?.action === "STOP_LOSS", `migrated position must stop-loss on cumulative -15%: got ${JSON.stringify(exit1)}`);
  assert(/-15\.00%/.test(exit1.reason), `reason must carry the lifecycle pct: ${exit1.reason}`);
  console.log("  ✓ cumulative SL fires across migrates (per-account -3%, lifecycle -15%)");

  // 2. Never-rebalanced: same tick values must NOT stop-loss (per-account -3%
  //    governs; total_value fields are ignored without a rebalance).
  trackAt("CUMSL_2", 100);
  const exit2 = updatePnlAndCheckExits("CUMSL_2", {
    pnl_pct: -3, total_value_true_usd: 85, unclaimed_fees_true_usd: 0,
    in_range: true,
  }, MGMT);
  assert(exit2 == null, `non-rebalanced position must follow per-account tick: got ${JSON.stringify(exit2)}`);
  console.log("  ✓ never-rebalanced position unaffected (backward compat)");

  // 3. Fee cushion: value $85 but $4 unclaimed + $6 lifecycle-claimed fees →
  //    cumulative -5% > SL → no close. (claimed fees survive the migrate on
  //    the tracked record.)
  trackAt("CUMSL_3", 100);
  migrate("CUMSL_3", "CUMSL_3B");
  const st = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  st.positions["CUMSL_3B"].total_fees_claimed_usd = 6;
  fs.writeFileSync(STATE_PATH, JSON.stringify(st));
  const exit3 = updatePnlAndCheckExits("CUMSL_3B", {
    pnl_pct: -1, total_value_true_usd: 85, unclaimed_fees_true_usd: 4,
    in_range: true,
  }, MGMT);
  assert(exit3 == null, `fee-cushioned migrate must not stop-loss: got ${JSON.stringify(exit3)}`);
  const cum3 = computeLifecyclePnlPct(getTrackedPosition("CUMSL_3B"), {
    total_value_true_usd: 85, unclaimed_fees_true_usd: 4,
  });
  assert(Math.abs(cum3 - -5) < 0.001, `lifecycle math must include fees: expected -5, got ${cum3}`);
  console.log("  ✓ lifecycle PnL includes unclaimed + lifecycle-claimed fees");

  // 4. Peaks keep rising post-migrate: per-account tick +1% would never beat
  //    an old +3% peak, but lifecycle +5% must.
  trackAt("CUMSL_4", 100);
  migrate("CUMSL_4", "CUMSL_4B");
  const raised = confirmPeakFromTick("CUMSL_4B", {
    pnl_pct: 1, total_value_true_usd: 105, unclaimed_fees_true_usd: 0,
  }, 1, 0);
  assert(raised === true, "confirmPeakFromTick must raise the peak from the lifecycle value");
  assert(getTrackedPosition("CUMSL_4B").peak_pnl_pct === 5,
    `peak must be lifecycle +5%: got ${getTrackedPosition("CUMSL_4B").peak_pnl_pct}`);
  console.log("  ✓ peaks track the lifecycle series after a migrate");

  console.log("\nAll cumulative-SL tests passed ✅");
} finally {
  restore(STATE_PATH, saved);
}
process.exit(0);
