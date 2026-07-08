/**
 * Unit tests for the impermanent-loss estimators (ported from
 * CLMM-Liquidity-Provider's Rust test suite — same fixtures, same expected
 * values, so results should match to 4 decimals).
 * Run: node test/test-impermanent-loss.js
 */

import { calculateIlConstantProduct, calculateIlConcentrated } from "../utils/impermanent-loss.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function close(a, b, eps = 0.0001) {
  return Math.abs(a - b) < eps;
}

// ── calculateIlConstantProduct ──────────────────────────────────
// Price doubles: 100 -> 200. Ratio = 2. IL = 2*sqrt(2)/3 - 1 ≈ -0.05719
{
  const il = calculateIlConstantProduct(100, 200);
  assert(close(il, -0.05719), `constant-product IL on 2x move should be ~-5.72%, got ${il}`);
}
assert(calculateIlConstantProduct(0, 100) === null, "zero entry price must return null");
assert(calculateIlConstantProduct(100, -5) === null, "negative current price must return null");

// ── calculateIlConcentrated ──────────────────────────────────────
// Range 90-110, entry 100, current 100 → no movement, IL should be ~0.
{
  const il = calculateIlConcentrated(100, 100, 90, 110);
  assert(close(il, 0, 1e-6), `IL at entry price with no movement should be 0, got ${il}`);
}

// Price moves up within range (100 -> 105): LP sold some of the appreciating
// token into the depreciating one, so IL must be negative.
{
  const il = calculateIlConcentrated(100, 105, 90, 110);
  assert(il < 0, `IL should be negative when price moves within range, got ${il}`);
}

// Price exits above the range: position converts fully to token1, so it
// misses further upside relative to holding — IL should be negative and
// larger in magnitude than a smaller in-range move.
{
  const ilInRange = calculateIlConcentrated(100, 105, 90, 110);
  const ilOutOfRange = calculateIlConcentrated(100, 130, 90, 110);
  assert(ilOutOfRange < 0, `IL should be negative once price exits above range, got ${ilOutOfRange}`);
  assert(ilOutOfRange < ilInRange, "IL magnitude should grow once price exits the range");
}

// Invalid ranges fail closed.
assert(calculateIlConcentrated(100, 100, 110, 90) === null, "inverted range (lower >= upper) must return null");
assert(calculateIlConcentrated(100, 100, 0, 110) === null, "zero lower bound must return null");

console.log("test-impermanent-loss: all assertions passed");
