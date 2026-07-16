/**
 * Unit tests for the external-close sync path (no network).
 * syncOpenPositions must return a one-shot snapshot of positions that
 * vanished on-chain, skip already-closed ones, and honor the deploy grace period.
 * Run: node test/test-external-close.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { trackPosition, recordClose, syncOpenPositions, getTrackedPosition, markPositionsSeenOnChain } from "../state.js";

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

function testExternalCloseSync() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));

    const oldDeploy = new Date(Date.now() - 60 * 60_000).toISOString();
    trackPosition({ position: "EXT_POS_1", pool: "EXT_POOL_1", pool_name: "EXT-SOL", strategy: "bid_ask", amount_sol: 0.5 });
    trackPosition({ position: "FRESH_POS", pool: "FRESH_POOL", pool_name: "FRESH-SOL", strategy: "spot", amount_sol: 0.5 });
    trackPosition({ position: "PROPER_POS", pool: "P_POOL", pool_name: "P-SOL", strategy: "spot", amount_sol: 0.5 });

    // Backdate EXT_POS_1 and PROPER_POS past the grace period; FRESH_POS stays fresh
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.positions.EXT_POS_1.deployed_at = oldDeploy;
    state.positions.PROPER_POS.deployed_at = oldDeploy;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));

    // PROPER_POS closed through the normal path — must never surface as external
    recordClose("PROPER_POS", "take profit");

    // 1. Sync with none of them on-chain → only EXT_POS_1 reported
    const closed = syncOpenPositions([]);
    assert(Array.isArray(closed), "syncOpenPositions must return an array");
    assert(closed.length === 1, `expected 1 external close, got ${closed.length}`);
    assert(closed[0].position === "EXT_POS_1", `expected EXT_POS_1, got ${closed[0].position}`);
    assert(closed[0].pool === "EXT_POOL_1", "snapshot must carry the pool address");
    assert(closed[0].pool_name === "EXT-SOL", "snapshot must carry the pool name");
    assert(closed[0].closed_at != null, "snapshot must carry closed_at");
    assert(getTrackedPosition("EXT_POS_1").closed === true, "position must be marked closed in state");

    // 2. Grace period: FRESH_POS untouched
    assert(getTrackedPosition("FRESH_POS").closed !== true, "fresh position must not be auto-closed");

    // 3. One-shot: second sync returns nothing new
    const closedAgain = syncOpenPositions([]);
    assert(closedAgain.every((c) => c.position !== "EXT_POS_1"), "external close must not be reported twice");

    console.log("  external-close sync: one-shot report, proper-close skipped, grace period respected OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

function testGraceBypassAfterSeenOnChain() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));

    trackPosition({ position: "MANUAL_POS", pool: "MAN_POOL", pool_name: "MAN-SOL", strategy: "spot", amount_sol: 0.75 });
    // Fresh deploy — normally within grace period
    assert(getTrackedPosition("MANUAL_POS").closed !== true, "fresh position starts open");

    // Bot saw it on-chain, then user closed manually in Meteora UI
    markPositionsSeenOnChain(["MANUAL_POS"]);
    assert(getTrackedPosition("MANUAL_POS").last_seen_on_chain_at != null, "last_seen_on_chain_at must be stamped");

    const closed = syncOpenPositions([]);
    assert(closed.length === 1, `expected 1 grace-bypass close, got ${closed.length}`);
    assert(closed[0].position === "MANUAL_POS", `expected MANUAL_POS, got ${closed[0].position}`);
    assert(getTrackedPosition("MANUAL_POS").closed === true, "manual close must mark position closed despite grace");

    console.log("  grace bypass: fresh position closed after last_seen_on_chain_at OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

testExternalCloseSync();
testGraceBypassAfterSeenOnChain();
console.log("test-external-close: OK");
