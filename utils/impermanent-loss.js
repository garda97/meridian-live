// Impermanent loss estimators. Ported from CLMM-Liquidity-Provider
// (github.com/joaquinbejar/CLMM-Liquidity-Provider, crates/domain/src/metrics/impermanent_loss.rs)
// — pure math, no on-chain reads. Prices are token1/token0 (e.g. SOL per base token).

/**
 * IL for a full-range (constant product) position.
 * formula: 2*sqrt(priceRatio) / (1+priceRatio) - 1
 * Returns a negative fraction (-0.05 = 5% loss), or null on bad input.
 */
export function calculateIlConstantProduct(entryPrice, currentPrice) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || current <= 0) return null;

  const priceRatio = current / entry;
  const sqrtRatio = Math.sqrt(priceRatio);
  return (2 * sqrtRatio) / (1 + priceRatio) - 1;
}

/**
 * IL for a concentrated-liquidity position (DLMM/CLMM range), vs holding the
 * initial two-sided bundle. Compares value-if-held to value-of-LP-position,
 * both marked at currentPrice. Liquidity is normalized to 1 — it cancels out
 * of the ratio, so this needs no position size.
 */
export function calculateIlConcentrated(entryPrice, currentPrice, priceLower, priceUpper) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  const lower = Number(priceLower);
  const upper = Number(priceUpper);
  if (
    !Number.isFinite(entry) || entry <= 0 ||
    !Number.isFinite(current) || current <= 0 ||
    !Number.isFinite(lower) || lower <= 0 ||
    !Number.isFinite(upper) || upper <= 0 ||
    lower >= upper
  ) {
    return null;
  }

  const sqrtEntry = Math.sqrt(entry);
  const sqrtCurrent = Math.sqrt(current);
  const sqrtLower = Math.sqrt(lower);
  const sqrtUpper = Math.sqrt(upper);
  const liquidity = 1;

  // Token0/token1 held by a liquidity-1 position at price sqrt(p), for range [lower, upper].
  function amountsAt(sqrtP) {
    if (sqrtP < sqrtLower) {
      // Price below range: fully in token0.
      return { amount0: liquidity * (1 / sqrtLower - 1 / sqrtUpper), amount1: 0 };
    }
    if (sqrtP >= sqrtUpper) {
      // Price above range: fully in token1.
      return { amount0: 0, amount1: liquidity * (sqrtUpper - sqrtLower) };
    }
    return {
      amount0: liquidity * (1 / sqrtP - 1 / sqrtUpper),
      amount1: liquidity * (sqrtP - sqrtLower),
    };
  }

  const held = amountsAt(sqrtEntry);
  const lp = amountsAt(sqrtCurrent);

  const valueHeld = held.amount0 * current + held.amount1;
  const valueLp = lp.amount0 * current + lp.amount1;
  if (valueHeld <= 0) return 0;

  return (valueLp - valueHeld) / valueHeld;
}
