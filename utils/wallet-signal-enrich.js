/**
 * Infer LP strategy hints from on-chain position shape + Meteora deposit history.
 * Used by wallet signalling watcher — reference only, NOT for mirror/copytrade.
 */

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function classifyRangeStyle(widthBins) {
  if (widthBins == null) return null;
  if (widthBins <= 50) return "tight";
  if (widthBins <= 100) return "medium";
  return "wide";
}

function inferStrategy({ depositSide, lowerBin, upperBin, activeBin }) {
  if (depositSide === "sol_only") {
    return { inferred_strategy: "bid_ask", strategy_confidence: "high" };
  }
  if (depositSide === "token_only") {
    return { inferred_strategy: "bid_ask", strategy_confidence: "medium" };
  }
  if (depositSide === "dual") {
    if (lowerBin != null && upperBin != null && activeBin != null && upperBin > lowerBin) {
      const pct = (activeBin - lowerBin) / (upperBin - lowerBin);
      if (pct >= 0.35 && pct <= 0.65) {
        return { inferred_strategy: "spot", strategy_confidence: "medium" };
      }
      return { inferred_strategy: "curve", strategy_confidence: "low" };
    }
    return { inferred_strategy: "spot", strategy_confidence: "low" };
  }
  return { inferred_strategy: "unknown", strategy_confidence: "low" };
}

function classifyDepositSide(pnlRaw) {
  const depX = safeNum(pnlRaw?.allTimeDeposits?.tokenX?.amount);
  const depY = safeNum(pnlRaw?.allTimeDeposits?.tokenY?.amount);
  if (depX > 0 && depY > 0) return "dual";
  if (depY > 0 && depX === 0) return "sol_only";
  if (depX > 0 && depY === 0) return "token_only";
  return "unknown";
}

/**
 * @param {object} opts
 * @param {string} opts.wallet_name
 * @param {string} opts.wallet_address
 * @param {object} opts.position - getWalletPositions row
 * @param {object|null} opts.pnlRaw - Meteora /pnl row for this position
 */
export function buildWalletSignal({ wallet_name, wallet_address, position, pnlRaw = null }) {
  const lowerBin = position?.lower_bin ?? pnlRaw?.lowerBinId ?? null;
  const upperBin = position?.upper_bin ?? pnlRaw?.upperBinId ?? null;
  const activeBin = position?.active_bin ?? pnlRaw?.poolActiveBinId ?? null;
  const widthBins = lowerBin != null && upperBin != null ? upperBin - lowerBin : null;
  const depositSide = classifyDepositSide(pnlRaw);
  const { inferred_strategy, strategy_confidence } = inferStrategy({
    depositSide,
    lowerBin,
    upperBin,
    activeBin,
  });

  const depXUsd = safeNum(pnlRaw?.allTimeDeposits?.tokenX?.usd);
  const depYUsd = safeNum(pnlRaw?.allTimeDeposits?.tokenY?.usd);
  const depSol = safeNum(pnlRaw?.allTimeDeposits?.tokenY?.amount);

  let active_position_in_range = null;
  if (widthBins > 0 && activeBin != null && lowerBin != null) {
    active_position_in_range = `${Math.round(((activeBin - lowerBin) / widthBins) * 100)}% from lower`;
  }

  return {
    wallet_name,
    wallet_address,
    position_address: position?.position ?? null,
    pool_address: position?.pool ?? null,
    lower_bin: lowerBin,
    upper_bin: upperBin,
    active_bin: activeBin,
    width_bins: widthBins,
    range_style: classifyRangeStyle(widthBins),
    in_range: position?.in_range ?? (pnlRaw ? !pnlRaw.isOutOfRange : null),
    deposit_side: depositSide,
    deposit_sol: depSol > 0 ? round(depSol, 4) : null,
    deposit_usd: round(depXUsd + depYUsd, 2),
    total_value_usd: position?.total_value_usd ?? null,
    age_minutes: position?.age_minutes ?? null,
    unclaimed_fees_usd: position?.unclaimed_fees_usd ?? null,
    inferred_strategy,
    strategy_confidence,
    active_position_in_range,
  };
}

/** True when on-chain shape + deposit side are complete enough to log as a trade. */
export function isWalletSignalComplete(signal) {
  if (!signal) return false;
  if (signal.lower_bin == null || signal.upper_bin == null) return false;
  if (signal.width_bins == null || signal.width_bins <= 0) return false;
  if (signal.deposit_side === "unknown") return false;
  if (signal.inferred_strategy === "unknown") return false;
  return true;
}

export function formatWalletSignalNote(signal) {
  if (!signal) return null;
  const parts = [
    signal.inferred_strategy !== "unknown" ? signal.inferred_strategy : null,
    signal.range_style,
    signal.width_bins != null ? `${signal.width_bins} bins` : null,
    signal.deposit_side !== "unknown" ? `deposit=${signal.deposit_side}` : null,
    signal.deposit_sol != null ? `${signal.deposit_sol} SOL` : null,
    signal.active_position_in_range,
  ].filter(Boolean);
  return parts.join(", ");
}