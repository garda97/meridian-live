import assert from "node:assert/strict";
import { evaluateSolRegimeFromSnapshots } from "../tools/sol-regime.js";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const H = 60 * 60 * 1000;

function testBlocksOnDump() {
  const snaps = [{ ts: NOW - H, price: 100 }];
  const r = evaluateSolRegimeFromSnapshots(snaps, 96, -3, NOW);
  assert.equal(r.blocked, true);
  assert.equal(r.changePct, -4);
}

function testAllowsRise() {
  const snaps = [{ ts: NOW - H, price: 100 }];
  const r = evaluateSolRegimeFromSnapshots(snaps, 102, -3, NOW);
  assert.equal(r.blocked, false);
  assert.equal(r.changePct, 2);
}

function testInsufficientHistory() {
  const snaps = [{ ts: NOW - 10 * 60 * 1000, price: 100 }];
  const r = evaluateSolRegimeFromSnapshots(snaps, 95, -3, NOW);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, "insufficient_history");
}

testBlocksOnDump();
testAllowsRise();
testInsufficientHistory();
console.log("test-sol-regime: OK");