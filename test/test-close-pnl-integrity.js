/**
 * Regression test for the 2026-07-12 incident: a 16s-held position recorded
 * closedOutcomes[].pnl_pct = 973.74% from a phantom RPC tick, while
 * lessons.json (computed separately by close.js after settlement) showed
 * 0% — two disagreeing numbers for the same close event, and the phantom
 * value corrupted the learning data. Covers:
 *  1. recordClose's pnl_pct override always wins over pos.pnl_pct.
 *  2. updatePnlAndCheckExits suppresses a positive phantom spike during
 *     pnlWarmupMinutes (the actual mechanism that let 973.74% get stamped
 *     into pos.pnl_pct in the first place).
 *  3. A real loss (stop-loss-shaped) is NEVER suppressed during warmup —
 *     "stop loss stays live" must keep working.
 * Run: node test/test-close-pnl-integrity.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { trackPosition, recordClose, updatePnlAndCheckExits, getTrackedPosition } from "../state.js";

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
function readState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function testRecordCloseOverrideWinsOverStalePnl() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));
    trackPosition({
      position: "PNLFIX_POS_1", pool: "PNLFIX_POOL_1", pool_name: "PNLFIXTEST-SOL",
      strategy: "bid_ask", amount_sol: 2,
    });
    // Simulate the exact incident: a phantom tick stamps pos.pnl_pct to an
    // absurd value (bypassing warmup here to isolate recordClose's own
    // override behavior from the separate warmup-suppression mechanism
    // tested below).
    updatePnlAndCheckExits("PNLFIX_POS_1", { pnl_pct: 973.74, active_bin: 5, lower_bin: -10, upper_bin: 10 }, { pnlWarmupMinutes: 0 });
    assert(getTrackedPosition("PNLFIX_POS_1").pnl_pct === 973.74, "setup: pos.pnl_pct should be the phantom value before recordClose");

    // close.js computed a real, settled PnL of 0.13% — pass it as the override.
    recordClose("PNLFIX_POS_1", "Out of range for 2m (limit: 2m)", { pnl_pct: 0.13 });

    const state = readState();
    const outcome = state.closedOutcomes.find((o) => o.position === "PNLFIX_POS_1");
    assert(outcome, "closedOutcomes must contain the closed position");
    assert(outcome.pnl_pct === 0.13, `override must win over stale pos.pnl_pct: expected 0.13, got ${outcome.pnl_pct}`);

    console.log("  recordClose: pnl_pct override wins over stale/phantom pos.pnl_pct OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

function testRecordCloseNoOverrideFallsBackToPosPnl() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));
    trackPosition({ position: "PNLFIX_POS_2", pool: "PNLFIX_POOL_2", pool_name: "PNLFIXTEST2-SOL", strategy: "spot", amount_sol: 0.5 });
    updatePnlAndCheckExits("PNLFIX_POS_2", { pnl_pct: 4.2, active_bin: 5, lower_bin: -10, upper_bin: 10 }, { pnlWarmupMinutes: 0 });

    // No override passed (matches syncOpenPositions' external-close path, which
    // has no close.js-computed number available) — must still work exactly as
    // before this fix.
    recordClose("PNLFIX_POS_2", "external close");

    const outcome = readState().closedOutcomes.find((o) => o.position === "PNLFIX_POS_2");
    assert(outcome.pnl_pct === 4.2, `no override given: must fall back to pos.pnl_pct, got ${outcome.pnl_pct}`);

    console.log("  recordClose: omitted override falls back to pos.pnl_pct (backward compatible) OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

function testPhantomPositiveSpikeSuppressedDuringWarmup() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));
    trackPosition({ position: "PNLFIX_POS_3", pool: "PNLFIX_POOL_3", pool_name: "PNLFIXTEST3-SOL", strategy: "bid_ask", amount_sol: 2 });

    // Position was deployed "now" (trackPosition stamps deployed_at) — still
    // inside a 3-minute warmup window. A phantom +973.74% tick arrives.
    updatePnlAndCheckExits("PNLFIX_POS_3", { pnl_pct: 973.74, active_bin: 5, lower_bin: -10, upper_bin: 10 }, { pnlWarmupMinutes: 3 });

    const pos = getTrackedPosition("PNLFIX_POS_3");
    assert(pos.pnl_pct !== 973.74, `phantom positive spike must be suppressed during warmup, but pos.pnl_pct = ${pos.pnl_pct}`);
    assert(pos.pnl_pct === 0 || pos.pnl_pct == null, `expected pnl_pct to stay at its initial value (0) during warmup, got ${pos.pnl_pct}`);

    console.log("  updatePnlAndCheckExits: positive phantom spike suppressed during pnlWarmupMinutes OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

function testRealLossNeverSuppressedDuringWarmup() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));
    trackPosition({ position: "PNLFIX_POS_4", pool: "PNLFIX_POOL_4", pool_name: "PNLFIXTEST4-SOL", strategy: "bid_ask", amount_sol: 2 });

    // Still inside warmup, but this time a REAL loss (stop-loss-shaped) tick
    // arrives — "stop loss stays live during warmup" must keep working.
    const exit = updatePnlAndCheckExits("PNLFIX_POS_4", { pnl_pct: -57.41, active_bin: 5, lower_bin: -10, upper_bin: 10 }, { pnlWarmupMinutes: 3, stopLossPct: -12 });

    const pos = getTrackedPosition("PNLFIX_POS_4");
    assert(pos.pnl_pct === -57.41, `a real loss must NOT be suppressed during warmup, got pos.pnl_pct = ${pos.pnl_pct}`);
    assert(exit?.action === "STOP_LOSS", `stop loss must still fire during warmup, got ${JSON.stringify(exit)}`);

    console.log("  updatePnlAndCheckExits: real loss (stop-loss) still passes through during warmup OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

testRecordCloseOverrideWinsOverStalePnl();
testRecordCloseNoOverrideFallsBackToPosPnl();
testPhantomPositiveSpikeSuppressedDuringWarmup();
testRealLossNeverSuppressedDuringWarmup();
console.log("test-close-pnl-integrity: OK");
