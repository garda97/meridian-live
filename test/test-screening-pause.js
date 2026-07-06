#!/usr/bin/env node
/**
 * Screening pause gate — maxPositions=0 + CLI reload semantics.
 */
import assert from "node:assert/strict";
import {
  isScreeningPaused,
  hasDeployCapacity,
  checkScreeningDeployGate,
  canTriggerScreening,
} from "../utils/screening-gate.js";

const baseCfg = {
  risk: { maxPositions: 1 },
  schedule: { noDeployAfterHour: null, noDeployBeforeHour: null },
};

assert.equal(isScreeningPaused({ risk: { maxPositions: 0 } }), true);
assert.equal(isScreeningPaused({ risk: { maxPositions: 1 } }), false);
assert.equal(hasDeployCapacity(0, { risk: { maxPositions: 1 } }), true);
assert.equal(hasDeployCapacity(1, { risk: { maxPositions: 1 } }), false);
assert.equal(hasDeployCapacity(0, { risk: { maxPositions: 0 } }), false);

let g = checkScreeningDeployGate({ openCount: 0, hour: 12, cfg: { risk: { maxPositions: 0 }, schedule: {} } });
assert.equal(g.allowed, false);
assert.match(g.reason, /screening_paused/);

g = checkScreeningDeployGate({ openCount: 1, hour: 12, cfg: baseCfg });
assert.equal(g.allowed, false);
assert.match(g.reason, /max_positions_reached/);

g = checkScreeningDeployGate({ openCount: 0, hour: 12, cfg: baseCfg });
assert.equal(g.allowed, true);

g = checkScreeningDeployGate({
  openCount: 0,
  hour: 18,
  cfg: { risk: { maxPositions: 1 }, schedule: { noDeployAfterHour: 18 } },
});
assert.equal(g.allowed, false);
assert.match(g.reason, /time_gate/);

assert.equal(canTriggerScreening({ risk: { maxPositions: 0 }, schedule: {} }).ok, false);
assert.equal(canTriggerScreening(baseCfg).ok, true);

console.log("test-screening-pause: OK");