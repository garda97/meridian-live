/**
 * Unit tests for state.closedOutcomes[] (Fase 2 bot learning: machine-readable
 * close history for lp-outcome analysis, replacing the LESSONS_LEARNED.md-only
 * source). Covers both close paths: recordClose (normal) and
 * syncOpenPositions (external/missing-on-chain).
 * Run: node test/test-closed-outcomes.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { trackPosition, recordClose, syncOpenPositions, updatePnlAndCheckExits } from "../state.js";

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

function testRecordCloseAppendsOutcome() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));
    trackPosition({
      position: "CO_POS_1",
      pool: "CO_POOL_1",
      pool_name: "COTEST-SOL",
      strategy: "bid_ask",
      amount_sol: 0.3,
      organic_score: 72,
      fee_tvl_ratio: 1.4,
      entry_mcap: 900_000,
    });
    // Simulate a management tick setting pnl_pct before close.
    updatePnlAndCheckExits("CO_POS_1", { pnl_pct: 4.2, active_bin: 5, lower_bin: -10, upper_bin: 10 }, {});
    recordClose("CO_POS_1", "take_profit");

    const state = readState();
    assert(Array.isArray(state.closedOutcomes), "closedOutcomes must be an array");
    assert(state.closedOutcomes.length === 1, `expected 1 outcome, got ${state.closedOutcomes.length}`);
    const o = state.closedOutcomes[0];
    assert(o.position === "CO_POS_1", "outcome must reference the closed position");
    assert(o.close_reason === "take_profit", `close_reason must be preserved, got ${o.close_reason}`);
    assert(o.strategy === "bid_ask", "strategy must be carried over");
    assert(o.organic_score === 72, "organic_score must be carried over");
    assert(o.entry_mcap === 900_000, "entry_mcap must be carried over");
    assert(o.pnl_pct === 4.2, `pnl_pct must reflect the last tracked tick, got ${o.pnl_pct}`);

    console.log("  recordClose: pushes a closedOutcomes entry with pnl_pct/strategy/reason carried over OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

function testExternalCloseAppendsOutcome() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: [] }));
    trackPosition({ position: "CO_POS_2", pool: "CO_POOL_2", pool_name: "COTEST2-SOL", strategy: "spot", amount_sol: 0.4 });

    const state = readState();
    state.positions.CO_POS_2.deployed_at = new Date(Date.now() - 60 * 60_000).toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));

    const closed = syncOpenPositions([]);
    assert(closed.length === 1 && closed[0].position === "CO_POS_2", "syncOpenPositions must return the externally-closed snapshot");

    const after = readState();
    assert(after.closedOutcomes.length === 1, `expected 1 outcome after external close, got ${after.closedOutcomes.length}`);
    assert(after.closedOutcomes[0].close_reason === "external_close_sync_missing", `unexpected close_reason: ${after.closedOutcomes[0].close_reason}`);

    console.log("  syncOpenPositions: external close also pushes a closedOutcomes entry OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

function testClosedOutcomesCapped() {
  const saved = backup(STATE_PATH);
  try {
    // Pre-fill 1000 fake outcomes, then close one more real position — array must stay capped, oldest dropped.
    const filler = Array.from({ length: 1000 }, (_, i) => ({ position: `FILLER_${i}`, close_reason: "filler" }));
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {}, closedOutcomes: filler }));
    trackPosition({ position: "CO_POS_3", pool: "CO_POOL_3", pool_name: "COTEST3-SOL", strategy: "bid_ask", amount_sol: 0.2 });
    recordClose("CO_POS_3", "stop_loss");

    const state = readState();
    assert(state.closedOutcomes.length === 1000, `cap must hold at 1000, got ${state.closedOutcomes.length}`);
    assert(state.closedOutcomes.at(-1).position === "CO_POS_3", "newest outcome must survive the cap");
    assert(state.closedOutcomes[0].position === "FILLER_1", "oldest outcome (FILLER_0) must be dropped once over cap");

    console.log("  closedOutcomes: bounded at 1000, oldest dropped first OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

testRecordCloseAppendsOutcome();
testExternalCloseAppendsOutcome();
testClosedOutcomesCapped();
console.log("test-closed-outcomes: OK");
