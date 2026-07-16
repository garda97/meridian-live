/**
 * Regression test for the maxxing-SOL 2026-07-09 incident: a position entered
 * as bid_ask (spot fee floor correctly blocked spot at entry — fee/TVL 0.23)
 * was converted to spot MID-HOLD via the reshape/strategy-drift rebalance
 * path, which reused buildDeployPlan bins but skipped applySpotFeeFloor and
 * applySpotDumpGate entirely → low-fee two-sided spot ate -83.4% / -$32.64.
 * applySpotRebalanceGates (tools/position-router.js) closes that bypass:
 *  1. convert_to_spot into a low-fee pool → hold (fee floor).
 *  2. convert_to_spot during an active dump → hold (dump gate).
 *  3. convert_to_spot into a fee-hot, stable pool → allowed unchanged.
 *  4. widen_spot is gated the same way; reshape/flip_to_curve/close/hold and
 *     non-rebalance plans pass through untouched (recenter isn't a conversion).
 * Run: node test/test-spot-rebalance-gates.js
 */

import { config } from "../config.js";
import { applySpotRebalanceGates } from "../tools/position-router.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mkPlan(overrides = {}) {
  return {
    action: "rebalance",
    rebalance_type: "convert_to_spot",
    reason: "Strategy drift: deployed bid_ask but market went sideways — convert to spot",
    market_view: "sideways",
    deposit_side: "sol_balanced",
    bins_below: 60,
    bins_above: 40,
    notes: [],
    ...overrides,
  };
}

// Pin the gate thresholds (live config drifts — see repo test gotcha #1).
const savedAutoStrategy = { ...config.autoStrategy };
config.autoStrategy = { ...config.autoStrategy, spotFeeTvlMin: 1 };

try {
  // 1. Low-fee pool: the exact maxxing regime (fee/TVL 0.23) must be blocked.
  const lowFee = applySpotRebalanceGates(mkPlan(), {
    pool: { pool: "MAXXING_POOL", fee_tvl_ratio: 0.23 },
    priceChange1h: 2,
  });
  assert(lowFee.action === "hold", `low-fee convert_to_spot must hold, got ${lowFee.action}`);
  assert(lowFee.rebalance_type === null, "blocked plan must clear rebalance_type");
  assert(/Spot rebalance blocked/.test(lowFee.reason), `reason must say blocked: ${lowFee.reason}`);
  console.log("  ✓ low-fee convert_to_spot blocked (maxxing fixture)");

  // 2. Active dump: two-sided spot exposure into a dump must be blocked.
  const dumping = applySpotRebalanceGates(mkPlan(), {
    pool: { pool: "HOT_POOL", fee_tvl_ratio: 5 },
    priceChange1h: -25,
  });
  assert(dumping.action === "hold", `dumping convert_to_spot must hold, got ${dumping.action}`);
  console.log("  ✓ convert_to_spot during active dump blocked");

  // 3. Fee-hot + stable: conversion allowed, plan untouched apart from notes.
  const allowed = applySpotRebalanceGates(mkPlan(), {
    pool: { pool: "HOT_POOL", fee_tvl_ratio: 5 },
    priceChange1h: 2,
  });
  assert(allowed.action === "rebalance" && allowed.rebalance_type === "convert_to_spot",
    `fee-hot convert_to_spot must pass, got ${allowed.action}/${allowed.rebalance_type}`);
  assert(allowed.bins_below === 60 && allowed.bins_above === 40, "passing plan must keep its bins");
  console.log("  ✓ fee-hot stable convert_to_spot allowed");

  // 4a. widen_spot gated the same way.
  const widen = applySpotRebalanceGates(mkPlan({ rebalance_type: "widen_spot" }), {
    pool: { pool: "MAXXING_POOL", fee_tvl_ratio: 0.23 },
    priceChange1h: 2,
  });
  assert(widen.action === "hold", `low-fee widen_spot must hold, got ${widen.action}`);
  console.log("  ✓ widen_spot gated identically");

  // 4b. Same-shape recenter (reshape) and non-spot types pass through untouched
  //     even in the worst pool — a recenter is not a shape conversion.
  for (const type of ["reshape", "flip_to_curve"]) {
    const through = applySpotRebalanceGates(mkPlan({ rebalance_type: type }), {
      pool: { pool: "MAXXING_POOL", fee_tvl_ratio: 0.1 },
      priceChange1h: -30,
    });
    assert(through.action === "rebalance" && through.rebalance_type === type,
      `${type} must pass through untouched, got ${through.action}/${through.rebalance_type}`);
  }
  const holdPlan = applySpotRebalanceGates({ action: "hold", reason: "x" }, {
    pool: { pool: "MAXXING_POOL", fee_tvl_ratio: 0.1 },
    priceChange1h: -30,
  });
  assert(holdPlan.action === "hold", "non-rebalance plans must pass through");
  console.log("  ✓ reshape/flip_to_curve/hold pass through untouched");

  console.log("\nAll spot-rebalance-gate tests passed ✅");
} finally {
  config.autoStrategy = savedAutoStrategy;
}
process.exit(0);
