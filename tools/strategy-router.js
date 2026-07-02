/**
 * Auto strategy selection for screening deploys.
 * Classifies market view from pool metrics + chart indicators, then maps to
 * bid_ask / spot / curve with bins and deposit side (SOL-only wallet).
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { fetchChartIndicatorsForMint, buildSignalSummary } from "./chart-indicators.js";

const pendingPlans = new Map();

export function clearPendingDeployPlans() {
  pendingPlans.clear();
}

export function setPendingDeployPlan(poolAddress, plan) {
  if (poolAddress && plan) pendingPlans.set(poolAddress, plan);
}

export function getPendingDeployPlan(poolAddress) {
  return pendingPlans.get(poolAddress) ?? null;
}

export function consumePendingDeployPlan(poolAddress) {
  const plan = pendingPlans.get(poolAddress) ?? null;
  if (plan) pendingPlans.delete(poolAddress);
  return plan;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function volatilityScaledBins(volatility, { min, max } = {}) {
  const lo = min ?? config.strategy.minBinsBelow;
  const hi = max ?? config.strategy.maxBinsBelow;
  const vol = Number(volatility);
  if (!Number.isFinite(vol) || vol <= 0) return clampInt(config.strategy.defaultBinsBelow, lo, hi);
  return clampInt(lo + (vol / 5) * (hi - lo), lo, hi);
}

function inferFibBins(signal) {
  const close = signal?.close;
  if (close == null) return null;
  const fib786 = signal.fib786;
  const fib618 = signal.fib618;
  const fib50 = signal.fib50;
  const maxBins = config.autoStrategy?.maxBins ?? 200;

  if (fib786 != null && close <= fib786) return { fib: 0.786, bins: clampInt(200, 35, maxBins) };
  if (fib618 != null && close <= fib618) return { fib: 0.618, bins: clampInt(200, 35, maxBins) };
  if (fib50 != null && close <= fib50) return { fib: 0.5, bins: clampInt(125, 35, maxBins) };
  return { fib: 0.51, bins: clampInt(100, 35, maxBins) };
}

function classifyMarketView({ pool, priceChange1h, signal }) {
  const vol = Number(pool?.volatility);
  const absChange = Math.abs(Number(priceChange1h ?? 0));
  const bullishBreak = !!signal?.supertrendBreakUp;
  const bearishBreak = !!signal?.supertrendBreakDown;
  const isBullish = signal?.supertrendDirection === "bullish";
  const isBearish = signal?.supertrendDirection === "bearish";
  const rsi = signal?.rsi;

  if (bearishBreak || (isBearish && signal?.close != null && signal?.supertrendValue != null && signal.close <= signal.supertrendValue)) {
    return { view: "breakdown", confidence: "high", reason: "Supertrend bearish / support break" };
  }
  if (bullishBreak || (Number(priceChange1h) > 25 && isBullish)) {
    return { view: "pump", confidence: "high", reason: `Strong upside momentum (${priceChange1h ?? "?"}% 1h, ST bullish)` };
  }
  if (Number.isFinite(vol) && vol < 2 && absChange < 8) {
    return { view: "flat", confidence: "medium", reason: "Low volatility and tight price range" };
  }
  if (absChange < 12 && Number.isFinite(vol) && vol >= 2 && vol <= 6) {
    return { view: "sideways", confidence: "medium", reason: "Moderate vol with muted 1h price change" };
  }
  if (Number(priceChange1h) < -15) {
    return { view: "retracement", confidence: "high", reason: `Active pullback (${priceChange1h}% 1h)` };
  }
  return { view: "retracement", confidence: "medium", reason: "Default retracement fee play for trending meme" };
}

function buildDeployPlan({ pool, classification, signal, fibHint }) {
  const vol = Number(pool?.volatility);
  const baseBins = volatilityScaledBins(vol);
  const spotBelowRatio = config.autoStrategy?.spotRatioBelow ?? 0.75;
  const allowCurve = config.autoStrategy?.allowCurve !== false;
  const allowSpot = config.autoStrategy?.allowSpot !== false;
  const { view, reason: viewReason } = classification;

  let strategy = config.strategy.strategy || "bid_ask";
  let binsBelow = baseBins;
  let binsAbove = 0;
  let depositSide = "sol_below";
  let entryAllowed = true;
  let entryReason = "Screening passed; deploy plan ready";
  const notes = [];

  switch (view) {
    case "breakdown": {
      strategy = "bid_ask";
      depositSide = "sol_below";
      binsBelow = fibHint?.bins ?? clampInt(baseBins * 1.4, config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
      binsAbove = 0;
      notes.push(fibHint ? `Fib ~${fibHint.fib} → ${binsBelow} bins` : "Wide below range for breakdown");
      break;
    }
    case "pump": {
      strategy = "bid_ask";
      depositSide = "sol_below";
      binsBelow = fibHint?.bins ?? clampInt(baseBins * 1.25, config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
      binsAbove = 0;
      notes.push("Post-pump: SOL below to catch dump fees");
      if (config.autoStrategy?.requireEntryConfirm && !classification.bullishBreak && signal?.rsi != null && signal.rsi > 85) {
        entryAllowed = false;
        entryReason = "RSI extended — wait for cooldown before wide below deploy";
      }
      break;
    }
    case "sideways": {
      if (allowSpot) {
        strategy = "spot";
        depositSide = "sol_balanced";
        const total = baseBins;
        binsBelow = clampInt(total * spotBelowRatio, Math.ceil(config.strategy.minBinsBelow * 0.6), total);
        binsAbove = Math.max(0, total - binsBelow);
        if (binsBelow + binsAbove < config.strategy.minBinsBelow) {
          binsBelow = config.strategy.minBinsBelow;
          binsAbove = 0;
          strategy = "bid_ask";
          depositSide = "sol_below";
        } else {
          notes.push(`Spot ratio ~${Math.round(spotBelowRatio * 100)}% SOL below / ${Math.round((1 - spotBelowRatio) * 100)}% above`);
        }
      } else {
        strategy = "bid_ask";
        depositSide = "sol_below";
        binsBelow = baseBins;
      }
      if (signal?.supertrendBreakDown) {
        entryAllowed = false;
        entryReason = "Sideways spot blocked while Supertrend breaking down";
      }
      break;
    }
    case "flat": {
      if (allowCurve) {
        strategy = "curve";
        depositSide = "sol_balanced";
        const half = clampInt(baseBins / 2, 18, 100);
        binsBelow = half;
        binsAbove = half;
        notes.push("Curve centered for range-bound fee capture");
      } else if (allowSpot) {
        strategy = "spot";
        depositSide = "sol_balanced";
        binsBelow = clampInt(baseBins * 0.55, 20, baseBins);
        binsAbove = Math.max(0, baseBins - binsBelow);
      } else {
        strategy = "bid_ask";
        depositSide = "sol_below";
        binsBelow = baseBins;
      }
      break;
    }
    case "retracement":
    default: {
      strategy = "bid_ask";
      depositSide = "sol_below";
      binsBelow = fibHint?.bins ?? baseBins;
      binsAbove = 0;
      if (fibHint) notes.push(`Fib ~${fibHint.fib} depth → ${binsBelow} bins`);
      break;
    }
  }

  if (strategy === "bid_ask" && depositSide === "sol_below") {
    binsAbove = 0;
  }

  const totalBins = binsBelow + binsAbove;
  if (totalBins < config.strategy.minBinsBelow) {
    binsBelow = config.strategy.minBinsBelow;
    if (strategy === "bid_ask") binsAbove = 0;
  }

  return {
    market_view: view,
    view_reason: viewReason,
    strategy,
    deposit_side: depositSide,
    bins_below: binsBelow,
    bins_above: binsAbove,
    amount_x: 0,
    amount_y: null,
    entry_allowed: entryAllowed,
    entry_reason: entryReason,
    notes,
    signal_summary: signal ?? null,
    wide_range: binsBelow + binsAbove > 69,
  };
}

export async function resolveDeployStrategyForCandidate({ pool, tokenInfo } = {}) {
  const mint = pool?.base?.mint || tokenInfo?.mint;
  let signal = null;
  let indicatorOk = false;

  if (mint && config.autoStrategy?.fetchIndicators !== false) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, {
        interval: config.autoStrategy?.indicatorInterval ?? "15_MINUTE",
        candles: config.indicators.candles ?? 298,
        rsiLength: config.indicators.rsiLength ?? 2,
      });
      signal = buildSignalSummary(payload);
      indicatorOk = true;
    } catch (error) {
      log("strategy_router", `Indicator fetch failed for ${mint?.slice(0, 8)}: ${error.message}`);
    }
  }

  const priceChange1h = tokenInfo?.stats_1h?.price_change ?? pool?.price_change_1h ?? null;
  const classification = classifyMarketView({ pool, priceChange1h, signal });
  if (signal?.supertrendBreakUp) classification.bullishBreak = true;

  const fibHint = indicatorOk ? inferFibBins(signal) : null;
  const plan = buildDeployPlan({ pool, classification, signal, fibHint });
  plan.pool = pool?.pool ?? null;
  plan.pool_name = pool?.name ?? null;
  plan.volatility = pool?.volatility ?? null;
  plan.indicator_ok = indicatorOk;

  return plan;
}

export async function resolveDeployPlansForCandidates(candidates) {
  clearPendingDeployPlans();
  const plans = await Promise.all(
    candidates.map(async (entry) => {
      const plan = await resolveDeployStrategyForCandidate({
        pool: entry.pool,
        tokenInfo: entry.ti,
      });
      if (entry.pool?.pool) setPendingDeployPlan(entry.pool.pool, plan);
      return { entry, plan };
    }),
  );
  return plans;
}

export function formatDeployPlanBlock(plan) {
  if (!plan) return "";
  const lines = [
    `  auto_strategy: ${plan.strategy} | market_view: ${plan.market_view} (${plan.view_reason})`,
    `  deploy_plan: SOL-only | bins_below=${plan.bins_below} bins_above=${plan.bins_above}${plan.wide_range ? " WIDE" : ""}`,
    `  entry_gate: ${plan.entry_allowed ? "ALLOW" : "BLOCK"} — ${plan.entry_reason}`,
  ];
  if (plan.notes?.length) lines.push(`  strategy_notes: ${plan.notes.join("; ")}`);
  if (plan.signal_summary?.supertrendDirection) {
    lines.push(`  chart_15m: ST=${plan.signal_summary.supertrendDirection} RSI=${plan.signal_summary.rsi ?? "?"}`);
  }
  return lines.join("\n");
}

export function applyPendingPlanToDeployArgs(args) {
  if (!config.autoStrategy?.enabled || !args?.pool_address) return args;
  const plan = getPendingDeployPlan(args.pool_address);
  if (!plan) return args;

  const merged = { ...args };
  if (!merged.strategy && plan.strategy) merged.strategy = plan.strategy;
  if (merged.bins_below == null && plan.bins_below != null) merged.bins_below = plan.bins_below;
  if (merged.bins_above == null && plan.bins_above != null) merged.bins_above = plan.bins_above;
  if (merged.amount_x == null) merged.amount_x = plan.amount_x ?? 0;
  if (plan.volatility != null && merged.volatility == null) merged.volatility = plan.volatility;
  merged._auto_strategy_plan = plan;
  return merged;
}

export function validateDeployPlanGate(plan) {
  if (!plan) return { pass: true };
  if (!plan.entry_allowed) {
    return { pass: false, reason: plan.entry_reason || "Auto strategy entry gate blocked deploy" };
  }
  return { pass: true };
}