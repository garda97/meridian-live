/**
 * Pure decision logic and numeric/PnL helpers — no chain access, no I/O.
 * Everything here is unit-testable in isolation (see test/test-retry-ladder.js,
 * test/test-rebalance-safety.js).
 */
import { config } from "../../config.js";

export function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

export function roundNum(value, decimals = 2) {
  const n = parseFloat(value ?? 0);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Deterministic exit rules (no LLM).
 * Returns { action: "CLOSE", rule: string, reason: string } or null.
 */
export function getDeterministicCloseRule(position, mgmtConfig = {}) {
  const pnlPct = position.pnl_pct;
  const oorMinutes = position.minutes_out_of_range ?? 0;
  const ageMinutes = position.age_minutes ?? 0;
  const feePerTvl24h = position.fee_per_tvl_24h ?? 0;
  const unclaimedFees = position.unclaimed_fees_usd ?? 0;
  const minClaim = mgmtConfig.minClaimAmount ?? config.management.minClaimAmount;
  const oorBinsToClose = mgmtConfig.outOfRangeBinsToClose ?? config.management.outOfRangeBinsToClose;
  const oorWaitMinutes = mgmtConfig.outOfRangeWaitMinutes ?? config.management.outOfRangeWaitMinutes;
  const stopLossPct = mgmtConfig.stopLossPct ?? config.management.stopLossPct;
  const takeProfitPct = mgmtConfig.takeProfitPct ?? config.management.takeProfitPct;
  const minFeePerTvl24h = mgmtConfig.minFeePerTvl24h ?? config.management.minFeePerTvl24h;
  const minAgeBeforeYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? config.management.minAgeBeforeYieldCheck;
  const exitRule3Enabled = mgmtConfig.exitRule3ConditionsEnabled ?? config.management.exitRule3ConditionsEnabled;

  // Exit Rule 3-Kondisi (opt-in): close when ANY of the three conditions is met
  if (exitRule3Enabled) {
    if (pnlPct != null && pnlPct >= takeProfitPct) {
      return { action: "CLOSE", rule: "exit_rule_3", reason: `PnL ${pnlPct.toFixed(2)}% ≥ takeProfitPct ${takeProfitPct}%` };
    }
    if (pnlPct != null && pnlPct <= stopLossPct) {
      return { action: "CLOSE", rule: "exit_rule_3", reason: `PnL ${pnlPct.toFixed(2)}% ≤ stopLossPct ${stopLossPct}%` };
    }
    if (oorMinutes >= oorWaitMinutes) {
      return { action: "CLOSE", rule: "exit_rule_3", reason: `OOR ${oorMinutes}m ≥ ${oorWaitMinutes}m` };
    }
  }

  // Default rules (trailing TP + hard SL + OOR timeout)
  if (oorMinutes >= oorWaitMinutes && oorBinsToClose > 0) {
    return { action: "CLOSE", rule: "oor_timeout", reason: `OOR ${oorMinutes}m ≥ ${oorWaitMinutes}m` };
  }
  if (pnlPct != null && pnlPct <= stopLossPct) {
    return { action: "CLOSE", rule: "stop_loss", reason: `PnL ${pnlPct.toFixed(2)}% ≤ stopLossPct ${stopLossPct}%` };
  }
  if (unclaimedFees >= minClaim) {
    return null; // claim, not close
  }
  if (ageMinutes >= minAgeBeforeYieldCheck && feePerTvl24h < minFeePerTvl24h) {
    return { action: "CLOSE", rule: "low_yield", reason: `fee/TVL 24h ${feePerTvl24h}% < ${minFeePerTvl24h}%` };
  }
  return null;
}

/** Meteora program error 0x1774 = ExceededBinSlippageTolerance. */
export function isBinSlippageError(error) {
  return /0x1774|ExceededBinSlippage/i.test(String(error?.message ?? error));
}

/**
 * One rung of the 0x1774 retry ladder — pure and testable, no chain access.
 * attempt 1: re-anchor only (shift range to fresh active bin)
 * attempt 2: shrink bins ~15% (never below minBinsBelow)
 * attempt 3: fall back to spot, only when fee/TVL clears spotFeeTvlMin and
 *            the plan isn't already spot
 * Anything else: stop.
 */
export function planBinSlippageRetry(attempt, { strategy, binsBelow, binsAbove, feeTvlRatio, minBinsBelow, spotFeeTvlMin }) {
  if (attempt === 1) {
    return { action: "run", strategy, binsBelow, binsAbove, step: "shift range to fresh active bin" };
  }
  if (attempt === 2) {
    return {
      action: "run",
      strategy,
      binsBelow: Math.max(minBinsBelow, Math.round(binsBelow * 0.85)),
      binsAbove: binsAbove > 0 ? Math.round(binsAbove * 0.85) : 0,
      step: "shrink bins ~15%",
    };
  }
  if (attempt === 3) {
    const feeTvl = Number(feeTvlRatio);
    if (strategy === "spot" || !Number.isFinite(feeTvl) || feeTvl < spotFeeTvlMin) {
      return { action: "stop", reason: `spot fallback not eligible (fee/TVL ${feeTvlRatio ?? "?"} < ${spotFeeTvlMin})` };
    }
    return { action: "run", strategy: "spot", binsBelow, binsAbove, step: "fallback to spot" };
  }
  return { action: "stop", reason: "ladder exhausted" };
}

/** RPC settle window before reclaiming an emptied position account (partialClose uses the same). */
export const REBALANCE_SETTLE_DELAY_MS = 5000;

/** True when the planned range still fits the existing position account allocation. */
export function plannedRangeFitsAccount(minBinId, maxBinId, oldLower, oldUpper) {
  if (!Number.isFinite(minBinId) || !Number.isFinite(maxBinId)) return false;
  if (!Number.isFinite(oldLower) || !Number.isFinite(oldUpper)) return false;
  return minBinId >= oldLower && maxBinId <= oldUpper;
}

/**
 * Minimum free SOL required before a migrate rebalance (new position account + txs).
 * gasReserve must stay untouched; migrate rent + tx fees sit on top.
 */
export function minSolRequiredForRebalanceMigrate(mgmtConfig = {}, { isWide = false } = {}) {
  const gasReserve = Number(mgmtConfig.gasReserve ?? config.management.gasReserve ?? 0.2);
  const rentBuffer = Number(mgmtConfig.rebalanceMigrateRentBufferSol ?? config.management.rebalanceMigrateRentBufferSol ?? 0.1);
  const wideExtra = isWide ? Number(mgmtConfig.rebalanceMigrateWideRentExtraSol ?? config.management.rebalanceMigrateWideRentExtraSol ?? 0.05) : 0;
  const txBuffer = Number(mgmtConfig.rebalanceTxFeeBufferSol ?? config.management.rebalanceTxFeeBufferSol ?? 0.02);
  return gasReserve + rentBuffer + wideExtra + txBuffer;
}

/** Minimum free SOL for an in-place rebalance (re-add only — no new account rent). */
export function minSolRequiredForRebalanceInPlace(mgmtConfig = {}) {
  const gasReserve = Number(mgmtConfig.gasReserve ?? config.management.gasReserve ?? 0.2);
  const txBuffer = Number(mgmtConfig.rebalanceTxFeeBufferSol ?? config.management.rebalanceTxFeeBufferSol ?? 0.02);
  return gasReserve + txBuffer;
}

/**
 * Pure gate: is wallet SOL high enough for the rebalance path?
 * Returns { ok, required, path, reason }.
 */
export function checkRebalanceSolGate({ balanceSol, path, isWide, mgmtConfig } = {}) {
  const bal = Number(balanceSol);
  const p = path === "in_place" ? "in_place" : "migrate";
  const required = p === "in_place"
    ? minSolRequiredForRebalanceInPlace(mgmtConfig)
    : minSolRequiredForRebalanceMigrate(mgmtConfig, { isWide });
  if (!Number.isFinite(bal)) {
    return { ok: false, required, path: p, reason: "rebalance_skipped_insufficient_sol: balance unknown" };
  }
  if (bal < required) {
    return {
      ok: false,
      required,
      path: p,
      reason: `rebalance_skipped_insufficient_sol: have ${bal.toFixed(4)} SOL, need ${required.toFixed(4)} SOL (${p}${isWide ? ", wide" : ""})`,
    };
  }
  return { ok: true, required, path: p, reason: null };
}

// ─── Closed/open PnL derivation (Meteora API payload shapes) ──

export function getClosedPnlValue(posEntry, solMode = false) {
  return solMode
    ? maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0
    : maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
}

export function getClosedPnlPct(posEntry, solMode = false) {
  const reported = solMode
    ? maybeNum(posEntry?.pnlSolPctChange) ?? maybeNum(posEntry?.pnl?.percentNative)
    : maybeNum(posEntry?.pnlPctChange) ?? maybeNum(posEntry?.pnl?.percent);
  if (reported != null) return reported;

  const pnl = getClosedPnlValue(posEntry, solMode);
  const deposit = solMode
    ? maybeNum(posEntry?.allTimeDeposits?.total?.sol)
    : maybeNum(posEntry?.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

export function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

export function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

/** Bucket a free-text close reason into a stable exit_signal_type for the decision log. */
export function classifyExitSignal(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text || text === "agent decision") return "agent_decision";
  if (text.includes("external") || text.includes("manual")) return "manual_or_external";
  if (text.includes("stop loss")) return "stop_loss";
  if (text.includes("trailing")) return "trailing_tp";
  if (text.includes("chart exit")) return "chart_exit";
  if (text.includes("tvl dilution")) return "tvl_dilution";
  if (text.includes("low yield")) return "low_yield";
  if (text.includes("out of range") || text.includes("oor") || text.includes("pumped far above")) return "out_of_range";
  if (text.includes("take profit") || text.includes("tp")) return "take_profit";
  if (text.includes("rug") || text.includes("emergency")) return "emergency";
  return "other";
}
