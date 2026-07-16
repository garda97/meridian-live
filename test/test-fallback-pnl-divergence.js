/**
 * Regression test for the API-vs-derived divergence guard (fees-maxi
 * apiChainDivergencePct port, #2 of the review): the Meteora API-fallback
 * path (and getPositionPnl) previously acted on the API's PRECOMPUTED
 * pnl_pct, which comes from a deposit cache that is documented to go stale —
 * the same failure class as the BULLCAT 2026-07-16 partial-withdrawal
 * artifact. chooseFallbackPnlPct picks the better source instead of freezing
 * exits (gating exits on divergence is a known past incident). Covers:
 *  1. Big divergence → derived wins, divergent flagged.
 *  2. Small gap → reported wins (legacy behavior unchanged).
 *  3. Only one source present → that one, not divergent.
 *  4. Neither present → null (caller's unpriceable/suspicious path).
 *  5. maxDiff disabled (0/null) → never divergent, reported wins.
 * Run: node test/test-fallback-pnl-divergence.js
 */

import { chooseFallbackPnlPct } from "../tools/dlmm/rules.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Stale reported (-60.68) vs fresh derived (+0.06) — the BULLCAT shape.
let c = chooseFallbackPnlPct(-60.68, 0.06, 5);
assert(c.pnl_pct === 0.06, `derived must win on divergence: got ${c.pnl_pct}`);
assert(c.source === "derived" && c.divergent === true, `must flag divergent: ${JSON.stringify(c)}`);
assert(Math.abs(c.gap - 60.74) < 0.001, `gap must be reported-derived distance: ${c.gap}`);
console.log("  ✓ big divergence → derived wins, flagged");

// 2. Normal noise stays on reported.
c = chooseFallbackPnlPct(-2.1, -1.8, 5);
assert(c.pnl_pct === -2.1 && c.source === "reported" && !c.divergent,
  `small gap must keep reported: ${JSON.stringify(c)}`);
console.log("  ✓ small gap → reported (legacy behavior)");

// 3. Single-source cases.
c = chooseFallbackPnlPct(null, -3.4, 5);
assert(c.pnl_pct === -3.4 && c.source === "derived" && !c.divergent, `derived-only: ${JSON.stringify(c)}`);
c = chooseFallbackPnlPct(1.2, null, 5);
assert(c.pnl_pct === 1.2 && c.source === "reported" && !c.divergent, `reported-only: ${JSON.stringify(c)}`);
c = chooseFallbackPnlPct(NaN, undefined, 5);
assert(c.pnl_pct === null && c.source === "none", `non-finite inputs must be treated as missing: ${JSON.stringify(c)}`);
console.log("  ✓ single-source and none cases");

// 4. Threshold exactly at the gap is NOT divergent (strictly greater).
c = chooseFallbackPnlPct(0, 5, 5);
assert(c.pnl_pct === 0 && !c.divergent, `gap == maxDiff must not flag: ${JSON.stringify(c)}`);
console.log("  ✓ boundary gap == maxDiff stays on reported");

// 5. Disabled threshold never flags.
c = chooseFallbackPnlPct(-60, 0, 0);
assert(c.pnl_pct === -60 && !c.divergent, `maxDiff 0 must disable the guard: ${JSON.stringify(c)}`);
console.log("  ✓ maxDiff 0/disabled → guard off");

console.log("\nAll fallback-pnl-divergence tests passed ✅");
process.exit(0);
