/**
 * Unit tests for the 0x1774 deploy retry ladder (pure planner, no chain).
 * The live deploy path in tools/dlmm.js calls planBinSlippageRetry per rung,
 * so this exercises the exact logic used on-chain.
 * Run: node test/test-retry-ladder.js
 */

import { planBinSlippageRetry, isBinSlippageError } from "../tools/dlmm.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const base = { strategy: "bid_ask", binsBelow: 100, binsAbove: 40, feeTvlRatio: 3, minBinsBelow: 35, spotFeeTvlMin: 2 };

// Rung 1: shift only — plan unchanged
let p = planBinSlippageRetry(1, base);
assert(p.action === "run" && p.strategy === "bid_ask" && p.binsBelow === 100 && p.binsAbove === 40, "rung 1 must only re-anchor");
assert(p.step.includes("shift"), `rung 1 step must be shift, got ${p.step}`);

// Rung 2: shrink ~15%, floor respected
p = planBinSlippageRetry(2, base);
assert(p.action === "run" && p.binsBelow === 85 && p.binsAbove === 34, `rung 2 must shrink 15% (got ${p.binsBelow}/${p.binsAbove})`);
p = planBinSlippageRetry(2, { ...base, binsBelow: 36 });
assert(p.binsBelow === 35, `rung 2 must respect minBinsBelow 35, got ${p.binsBelow}`);
p = planBinSlippageRetry(2, { ...base, binsAbove: 0 });
assert(p.binsAbove === 0, "rung 2 must keep zero upside at zero");

// Rung 3: spot fallback only when eligible
p = planBinSlippageRetry(3, base);
assert(p.action === "run" && p.strategy === "spot", "rung 3 must fall back to spot when fee/TVL clears the bar");
p = planBinSlippageRetry(3, { ...base, feeTvlRatio: 1.5 });
assert(p.action === "stop" && p.reason.includes("not eligible"), "rung 3 must stop on low fee/TVL");
p = planBinSlippageRetry(3, { ...base, strategy: "spot" });
assert(p.action === "stop", "rung 3 must stop when already spot");
p = planBinSlippageRetry(3, { ...base, feeTvlRatio: null });
assert(p.action === "stop", "rung 3 must stop on unknown fee/TVL");

// Beyond the ladder: stop
p = planBinSlippageRetry(4, base);
assert(p.action === "stop", "attempt 4 must stop");

// Full-sequence order: shift → shrink → spot
const steps = [1, 2, 3].map((a) => planBinSlippageRetry(a, base).step);
assert(steps[0].includes("shift") && steps[1].includes("shrink") && steps[2].includes("spot"), `ladder order wrong: ${steps.join(" | ")}`);

// Error classifier
assert(isBinSlippageError(new Error("custom program error: 0x1774")), "0x1774 must classify");
assert(isBinSlippageError(new Error("ExceededBinSlippageTolerance")), "named error must classify");
assert(isBinSlippageError("0x1774"), "string form must classify");
assert(!isBinSlippageError(new Error("insufficient funds")), "other errors must not classify");
assert(!isBinSlippageError(null), "null must not classify");

console.log("  retry-ladder: shift→shrink→spot order, floors, eligibility, classifier OK");
console.log("test-retry-ladder: OK");
process.exit(0);
