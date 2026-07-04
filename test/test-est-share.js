/**
 * Unit tests for estimateSharePct (Gap 2 — pool competitiveness metric).
 * Object-args signature: { deployAmountSol, solPriceUsd, poolTvlUsd }.
 * Run: node test/test-est-share.js
 */

import { estimateSharePct } from "../tools/screening.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const share = (deployAmountSol, solPriceUsd, poolTvlUsd) =>
  estimateSharePct({ deployAmountSol, solPriceUsd, poolTvlUsd });

// 0.5 SOL @ $80 = $40 into a $20k pool → 0.2%
assert(share(0.5, 80, 20_000) === 0.2, `expected 0.2, got ${share(0.5, 80, 20_000)}`);

// Whale case: 50 SOL @ $80 = $4000 into $20k → 20%
assert(share(50, 80, 20_000) === 20, "whale share must be 20%");

// Rounding to 2 decimals
assert(share(0.5, 81.53, 49_474) === 0.08, `expected 0.08, got ${share(0.5, 81.53, 49_474)}`);

// Missing/invalid inputs → null (metric absent, filter stays open)
assert(share(0, 80, 20_000) === null, "zero amount must be null");
assert(share(0.5, null, 20_000) === null, "missing price must be null");
assert(share(0.5, 80, 0) === null, "zero TVL must be null");
assert(share(0.5, 80, null) === null, "missing TVL must be null");
assert(share("x", 80, 20_000) === null, "garbage amount must be null");
assert(estimateSharePct({}) === null, "empty args must be null");

console.log("  est-share: math, rounding, whale case, null-on-missing OK");
console.log("test-est-share: OK");
