/**
 * Cross-process close-in-flight guard — sync must not external-close while daemon closes.
 * Run: node test/test-close-in-flight.js
 */
import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  trackPosition,
  markPositionClosing,
  unmarkPositionClosing,
  isPositionClosingInFlight,
  syncOpenPositions,
  getTrackedPosition,
} from "../state.js";

const STATE_PATH = repoPath("state.json");

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

const saved = backup(STATE_PATH);
try {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));
  const oldDeploy = new Date(Date.now() - 60 * 60_000).toISOString();

  trackPosition({ position: "INFLIGHT_POS", pool: "POOL1", pool_name: "TEST-SOL", strategy: "bid_ask", amount_sol: 0.5 });
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  state.positions.INFLIGHT_POS.deployed_at = oldDeploy;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));

  markPositionClosing("INFLIGHT_POS");
  if (!isPositionClosingInFlight("INFLIGHT_POS")) throw new Error("expected in-flight after mark");

  const closed = syncOpenPositions([]);
  if (closed.length !== 0) throw new Error(`expected 0 external close while in-flight, got ${closed.length}`);
  if (getTrackedPosition("INFLIGHT_POS").closed === true) throw new Error("position must stay open while close in flight");

  unmarkPositionClosing("INFLIGHT_POS");
  const closedAfter = syncOpenPositions([]);
  if (closedAfter.length !== 1) throw new Error(`expected 1 external close after unmark, got ${closedAfter.length}`);

  console.log("test-close-in-flight: OK");
} finally {
  restore(STATE_PATH, saved);
}