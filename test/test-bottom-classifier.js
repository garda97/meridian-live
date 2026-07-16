/**
 * Test for the bottom-base market view (fees-maxi trend.ts port, #3 of the
 * review): a token that already drew down ≥ bottomDrawdownPct AND whose
 * recent slope has flattened classifies as "bottom" → double-sided curve
 * entry, instead of falling through to the retracement default (bid_ask
 * SOL-below = knife-catching mid-dump, the BULLCAT entry shape). Covers:
 *  1. computeBottomSignal: deep drawdown + flat slope → isBottom.
 *  2. Deep drawdown but STILL FALLING slope → not bottom (mid-knife).
 *  3. Shallow drawdown → not bottom; insufficient candles → null.
 *  4. classifyMarketView: bottom view fires, but Supertrend break-down
 *     (breakdown view) takes precedence over it.
 *  5. buildDeployPlan: bottom → curve sol_balanced (allowCurve pinned true).
 * Run: node test/test-bottom-classifier.js
 */

import { config } from "../config.js";
import {
  computeBottomSignal,
  classifyMarketView,
  buildDeployPlan,
} from "../tools/strategy-router.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CFG = {
  bottomViewEnabled: true,
  bottomDrawdownPct: -40,
  bottomFlatSlopePct: 2,
  bottomSlopeCandles: 6,
  bottomLookbackCandles: 16,
};

/** Candle series builder: closes array → candles (low defaults to close). */
function candles(closes, lows = null) {
  return closes.map((close, i) => ({
    time: 1000 + i, open: close, high: close, close,
    low: lows?.[i] ?? close, volume: 1000,
  }));
}

// 1. Dump from 1.0 to 0.5 (-50% low), then flat around 0.55 → bottom.
const dumpThenFlat = candles([1.0, 0.9, 0.7, 0.55, 0.5, 0.52, 0.54, 0.55, 0.55, 0.548, 0.552, 0.55]);
let b = computeBottomSignal(dumpThenFlat, CFG);
assert(b?.isBottom === true, `dump-then-flat must be bottom: ${JSON.stringify(b)}`);
assert(b.drawdownPct <= -40, `drawdown must reflect the dump: ${b.drawdownPct}`);
console.log("  ✓ deep drawdown + flat slope → bottom");

// 2. Same drawdown but still falling (last 6 candles keep dropping) → NOT bottom.
const stillFalling = candles([1.0, 0.9, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.42, 0.4]);
b = computeBottomSignal(stillFalling, CFG);
assert(b?.isBottom === false, `still-falling knife must NOT be bottom: ${JSON.stringify(b)}`);
console.log("  ✓ deep drawdown but still falling → not bottom (knife)");

// 3. Shallow drawdown → not bottom; too few candles → null.
b = computeBottomSignal(candles([1.0, 0.95, 0.9, 0.88, 0.89, 0.9, 0.89, 0.9]), CFG);
assert(b?.isBottom === false, `-12% drawdown must not be bottom: ${JSON.stringify(b)}`);
assert(computeBottomSignal(candles([1.0, 0.5]), CFG) === null, "insufficient candles must return null");
assert(computeBottomSignal(dumpThenFlat, { ...CFG, bottomViewEnabled: false }) === null, "disabled flag must return null");
console.log("  ✓ shallow drawdown / few candles / disabled → no signal");

// 4. classifyMarketView precedence: bottom fires on the signal, but an active
//    Supertrend break-down wins over it.
const bottomSignal = { bottom: { isBottom: true, drawdownPct: -50, slopePct: 0.5, slopeCandles: 6 } };
let view = classifyMarketView({ pool: { volatility: 8 }, priceChange1h: -2, signal: bottomSignal });
assert(view.view === "bottom", `bottom view must fire: ${JSON.stringify(view)}`);
view = classifyMarketView({
  pool: { volatility: 8 }, priceChange1h: -2,
  signal: { ...bottomSignal, supertrendBreakDown: true },
});
assert(view.view === "breakdown", `breakdown must take precedence over bottom: ${JSON.stringify(view)}`);
console.log("  ✓ classifyMarketView: bottom fires; breakdown wins precedence");

// 5. buildDeployPlan: bottom → curve sol_balanced (pin allowCurve).
const savedAuto = { ...config.autoStrategy };
config.autoStrategy = { ...config.autoStrategy, allowCurve: true, allowSpot: true };
try {
  const plan = buildDeployPlan({
    pool: { pool: "BOTTOM_POOL", volatility: 4, fee_tvl_ratio: 3 },
    classification: { view: "bottom", confidence: "medium", reason: "test" },
    signal: bottomSignal,
    fibHint: null,
  });
  assert(plan.strategy === "curve", `bottom must plan curve: got ${plan.strategy}`);
  assert(plan.deposit_side === "sol_balanced", `bottom curve must be balanced: ${plan.deposit_side}`);
  assert(plan.bins_above > 0 && plan.bins_below > 0, "curve must have bins on both sides");
  console.log("  ✓ buildDeployPlan: bottom → centered curve, sol_balanced");
} finally {
  config.autoStrategy = savedAuto;
}

console.log("\nAll bottom-classifier tests passed ✅");
process.exit(0);
