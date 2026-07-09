import assert from "node:assert/strict";
import {
  computeChangePctFromSnapshots,
  evaluateRelativeStrength,
  evaluateSolRegimeFromSnapshots,
} from "../tools/sol-regime.js";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const H = 60 * 60 * 1000;

function testComputeChangePctBasic() {
  const snaps = [{ ts: NOW - H, price: 100 }];
  const r = computeChangePctFromSnapshots(snaps, 95, NOW);
  assert.equal(r.changePct, -5);
}

function testComputeChangePctNoHistory() {
  const r = computeChangePctFromSnapshots([], 95, NOW);
  assert.equal(r, null);
}

function testComputeChangePctNoPrice() {
  const r = computeChangePctFromSnapshots([{ ts: NOW - H, price: 100 }], 0, NOW);
  assert.equal(r, null);
}

function testRelativeStrengthSolOutperforms() {
  // SOL -2%, BTC -6% → SOL relatively strong by 4pp
  const r = evaluateRelativeStrength(-2, -6, 3);
  assert.equal(r.relativeStrengthPct, 4);
  assert.equal(r.isRelativelyStrong, true);
}

function testRelativeStrengthBelowThreshold() {
  // SOL -4%, BTC -5% → only 1pp outperform, below the 3pp bar
  const r = evaluateRelativeStrength(-4, -5, 3);
  assert.equal(r.relativeStrengthPct, 1);
  assert.equal(r.isRelativelyStrong, false);
}

function testRelativeStrengthSolWeaker() {
  // SOL -8%, BTC -2% → SOL underperforming, negative relative strength
  const r = evaluateRelativeStrength(-8, -2, 3);
  assert.equal(r.relativeStrengthPct, -6);
  assert.equal(r.isRelativelyStrong, false);
}

function testRelativeStrengthMissingData() {
  const r = evaluateRelativeStrength(null, -5, 3);
  assert.equal(r.isRelativelyStrong, false);
  assert.equal(r.relativeStrengthPct, null);
}

// Sanity check: the softened-threshold path still uses the plain SOL gate
// underneath (checkSolRegimeGate does the softening, this just confirms the
// underlying gate itself treats any explicit threshold consistently).
function testSoftenedThresholdStillBlocksBeyondIt() {
  const snaps = [{ ts: NOW - H, price: 100 }];
  // SOL down 6%, softened threshold -5% (base -3, softened by 2) → still blocked
  const r = evaluateSolRegimeFromSnapshots(snaps, 94, -5, NOW);
  assert.equal(r.blocked, true);
  assert.equal(r.changePct, -6);
}

function testSoftenedThresholdAllowsWithinBand() {
  const snaps = [{ ts: NOW - H, price: 100 }];
  // SOL down 4%, base threshold -3 would block, softened -5 does not
  const rBase = evaluateSolRegimeFromSnapshots(snaps, 96, -3, NOW);
  const rSoftened = evaluateSolRegimeFromSnapshots(snaps, 96, -5, NOW);
  assert.equal(rBase.blocked, true);
  assert.equal(rSoftened.blocked, false);
}

testComputeChangePctBasic();
testComputeChangePctNoHistory();
testComputeChangePctNoPrice();
testRelativeStrengthSolOutperforms();
testRelativeStrengthBelowThreshold();
testRelativeStrengthSolWeaker();
testRelativeStrengthMissingData();
testSoftenedThresholdStillBlocksBeyondIt();
testSoftenedThresholdAllowsWithinBand();
console.log("test-sol-btc-relative-strength: OK");
