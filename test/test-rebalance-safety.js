/**
 * Rebalance migrate safety gates — pure, no chain.
 * Run: node test/test-rebalance-safety.js
 */

import {
  plannedRangeFitsAccount,
  minSolRequiredForRebalanceMigrate,
  minSolRequiredForRebalanceInPlace,
  checkRebalanceSolGate,
  REBALANCE_SETTLE_DELAY_MS,
} from "../tools/dlmm.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const MGMT = {
  gasReserve: 0.25,
  rebalanceMigrateRentBufferSol: 0.1,
  rebalanceMigrateWideRentExtraSol: 0.05,
  rebalanceTxFeeBufferSol: 0.02,
};

// plannedRangeFitsAccount
assert(plannedRangeFitsAccount(110, 190, 100, 200), "range inside account must fit");
assert(!plannedRangeFitsAccount(90, 190, 100, 200), "min below old lower must not fit");
assert(!plannedRangeFitsAccount(110, 210, 100, 200), "max above old upper must not fit");
assert(!plannedRangeFitsAccount(110, 190, null, 200), "missing old lower must not fit");

// migrate SOL math
assert(minSolRequiredForRebalanceInPlace(MGMT) === 0.27, "in_place = gasReserve + tx buffer");
assert(minSolRequiredForRebalanceMigrate(MGMT) === 0.37, "migrate standard = 0.25+0.1+0.02");
assert(minSolRequiredForRebalanceMigrate(MGMT, { isWide: true }) === 0.42, "migrate wide adds 0.05");

// checkRebalanceSolGate
let g = checkRebalanceSolGate({ balanceSol: 1.38, path: "migrate", isWide: false, mgmtConfig: MGMT });
assert(g.ok && g.path === "migrate", "1.38 SOL must pass standard migrate gate");

g = checkRebalanceSolGate({ balanceSol: 0.30, path: "migrate", isWide: false, mgmtConfig: MGMT });
assert(!g.ok && g.reason.includes("rebalance_skipped_insufficient_sol"), "0.30 SOL must block migrate");

g = checkRebalanceSolGate({ balanceSol: 0.28, path: "in_place", mgmtConfig: MGMT });
assert(g.ok, "0.28 SOL must pass in_place gate");

g = checkRebalanceSolGate({ balanceSol: 0.20, path: "in_place", mgmtConfig: MGMT });
assert(!g.ok, "0.20 SOL must block in_place");

assert(REBALANCE_SETTLE_DELAY_MS === 5000, "settle delay must match partialClose");

console.log("test-rebalance-safety: OK");