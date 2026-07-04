/**
 * Auto strategy selection for screening deploys.
 * Classifies market view from pool metrics + chart indicators, then maps to
 * bid_ask / spot / curve with bins and deposit side (SOL-only wallet).
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { fetchChartIndicatorsForMint, buildSignalSummary, evaluateAthEntryGate } from "./chart-indicators.js";
import { hasRecentVolatileOorClose } from "../pool-memory.js";

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

export function classifyMarketView({ pool, priceChange1h, signal }) {
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
  if (bullishBreak || (Number(priceChange1h) > 15 && isBullish)) {
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

/**
 * OOR risk 0-100: how likely the deployed range breaks before fees cover costs.
 * Components: volatility (0-30), 1h momentum magnitude (0-30), zero upside
 * cover while price is running up — the FABLE OOR pattern (0-25), narrow
 * range (0-15).
 */
export function computeOorRisk({ volatility, priceChange1h, binsBelow, binsAbove } = {}) {
  const vol = Number(volatility);
  const chg = Number(priceChange1h);
  const below = Math.max(0, Number(binsBelow) || 0);
  const above = Math.max(0, Number(binsAbove) || 0);
  const total = below + above;

  let risk = Number.isFinite(vol) ? Math.min(30, (vol / 8) * 30) : 15;
  if (Number.isFinite(chg)) risk += Math.min(30, (Math.abs(chg) / 40) * 30);
  if (Number.isFinite(chg) && chg > 0 && above === 0) risk += Math.min(25, (chg / 20) * 25);
  const width = Math.min(150, Math.max(35, total || 35));
  risk += 15 * (1 - (width - 35) / (150 - 35));

  return Math.round(Math.min(100, risk));
}

function shouldPreferSpotForHighFee(pool) {
  if (config.autoStrategy?.preferSpotHighFee === false) return false;
  const feeTvl = Number(pool?.fee_active_tvl_ratio);
  const minFee = Number(config.autoStrategy?.spotFeeTvlMin ?? 2);
  return Number.isFinite(feeTvl) && feeTvl >= minFee;
}

/** Rebuild a plan as balanced spot (50/50 around active bin) with a note. */
function convertPlanToBalancedSpot(plan, { baseBins, note }) {
  const total = clampInt(
    Math.max(baseBins, config.strategy.minBinsBelow),
    config.strategy.minBinsBelow,
    config.autoStrategy?.maxBins ?? 200,
  );
  const binsBelow = clampInt(total * 0.5, Math.ceil(config.strategy.minBinsBelow * 0.5), total);
  return {
    ...plan,
    strategy: "spot",
    deposit_side: "sol_balanced",
    bins_below: binsBelow,
    bins_above: Math.max(0, total - binsBelow),
    wide_range: total > 69,
    notes: [...(plan.notes || []), note],
  };
}

const SPOT_BIAS_VIEWS = new Set(["sideways", "flat", "retracement"]);

function applyHighFeeSpotBias(plan, { pool, baseBins, spotBelowRatio, allowSpot, view }) {
  if (!allowSpot || !shouldPreferSpotForHighFee(pool) || !plan.entry_allowed) return plan;
  if (!SPOT_BIAS_VIEWS.has(view)) return plan;
  const feeTvl = Number(pool.fee_active_tvl_ratio);
  const total = clampInt(Math.max(baseBins, config.strategy.minBinsBelow), config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
  const binsBelow = clampInt(total * spotBelowRatio, Math.ceil(config.strategy.minBinsBelow * 0.6), total);
  const binsAbove = Math.max(0, total - binsBelow);
  return {
    ...plan,
    strategy: "spot",
    deposit_side: "sol_balanced",
    bins_below: binsBelow,
    bins_above: binsAbove,
    notes: [
      ...(plan.notes || []),
      `High fee/TVL spot bias (${feeTvl.toFixed(2)} >= ${config.autoStrategy?.spotFeeTvlMin ?? 2})`,
    ],
  };
}

export function buildDeployPlan({ pool, classification, signal, fibHint }) {
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
      // Matrix: breakdown → bid_ask wide SOL below, max bins.
      strategy = "bid_ask";
      depositSide = "sol_below";
      binsBelow = fibHint?.bins ?? clampInt(config.autoStrategy?.maxBins ?? 200, config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
      binsAbove = 0;
      notes.push(fibHint ? `Fib ~${fibHint.fib} → ${binsBelow} bins` : `Max-width below range (${binsBelow} bins) for breakdown`);
      break;
    }
    case "pump": {
      // Matrix: pump → spot balanced or skip; NEVER bid_ask SOL-below.
      // FABLE lesson: SOL-below on a running pump has 0% upside cover and OORs
      // on the next leg up.
      if (allowSpot) {
        strategy = "spot";
        depositSide = "sol_balanced";
        const total = clampInt(baseBins * 1.1, config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
        binsBelow = clampInt(total * 0.5, Math.ceil(config.strategy.minBinsBelow * 0.5), total);
        binsAbove = Math.max(0, total - binsBelow);
        notes.push("Pump view: spot balanced 50/50 for upside coverage (not bid_ask below)");
      } else {
        entryAllowed = false;
        entryReason = "Pump view — bid_ask SOL-below would OOR on next leg; spot disabled, skip";
      }
      if (config.autoStrategy?.requireEntryConfirm && !classification.bullishBreak && signal?.rsi != null && signal.rsi > 85) {
        entryAllowed = false;
        entryReason = "RSI extended — wait for cooldown before deploy";
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

  const plan = {
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

  const biased = applyHighFeeSpotBias(plan, { pool, baseBins, spotBelowRatio, allowSpot, view });
  biased.wide_range = biased.bins_below + biased.bins_above > 69;
  return biased;
}

/**
 * Sets plan.upside_cover_pct (share of range above active bin) and blocks
 * pump-view deploys without meaningful upside cover — they OOR on the next leg.
 * Mutates and returns the plan.
 */
export function applyPumpUpsideCoverGate(plan) {
  const planTotalBins = (plan.bins_below || 0) + (plan.bins_above || 0);
  plan.upside_cover_pct = planTotalBins > 0
    ? Math.round(((plan.bins_above || 0) / planTotalBins) * 1000) / 10
    : 0;

  const minUpsideCover = Number(config.autoStrategy?.minUpsideCoverPctPump ?? 25);
  if (
    plan.entry_allowed &&
    plan.market_view === "pump" &&
    Number.isFinite(minUpsideCover) &&
    minUpsideCover > 0 &&
    plan.upside_cover_pct < minUpsideCover
  ) {
    plan.entry_allowed = false;
    plan.entry_reason = `Pump view with upside cover ${plan.upside_cover_pct}% < ${minUpsideCover}% — would OOR on next leg`;
  }
  return plan;
}

/**
 * TGE play override (opt-in via tgeMaxAgeHours): fresh launches get a very
 * wide range — spot balanced when allowed, else max-width bid_ask below —
 * and a tge flag that arms the max-hold close rule. Low-fee pools are skipped
 * outright: the fee tier can't cover launch volatility (TGE doctrine: 5-10%).
 * Pure; returns a new plan, does not mutate the input.
 */
export function applyTgeOverride(plan, { pool } = {}) {
  const maxAge = Number(config.autoStrategy?.tgeMaxAgeHours);
  if (!Number.isFinite(maxAge) || maxAge <= 0) return plan;
  const age = Number(pool?.token_age_hours);
  if (!Number.isFinite(age) || age >= maxAge) return plan;

  const minFee = Number(config.autoStrategy?.tgeMinFeePct ?? 5);
  const feePct = Number(pool?.fee_pct);
  if (!Number.isFinite(feePct) || feePct < minFee) {
    return {
      ...plan,
      tge: true,
      entry_allowed: false,
      entry_reason: `TGE token (${age}h old) on low-fee pool (${feePct ?? "?"}% < ${minFee}%) — fee tier can't cover launch volatility`,
      notes: [...(plan.notes || []), `TGE gate: fee ${feePct ?? "?"}% below ${minFee}% floor`],
    };
  }

  const maxBins = config.autoStrategy?.maxBins ?? 200;
  const next = { ...plan, tge: true };
  if (config.autoStrategy?.allowSpot !== false) {
    next.strategy = "spot";
    next.deposit_side = "sol_balanced";
    next.bins_below = clampInt(maxBins * 0.65, config.strategy.minBinsBelow, maxBins);
    next.bins_above = Math.max(0, maxBins - next.bins_below);
  } else {
    next.strategy = "bid_ask";
    next.deposit_side = "sol_below";
    next.bins_below = maxBins;
    next.bins_above = 0;
  }
  next.wide_range = next.bins_below + next.bins_above > 69;
  next.notes = [...(plan.notes || []), `TGE play: token ${age}h old, fee ${feePct}% — max-width range, exit clock ${config.autoStrategy?.tgeMaxHoldHours ?? 8}h`];
  return next;
}

export async function resolveDeployStrategyForCandidate({ pool, tokenInfo } = {}) {
  const mint = pool?.base?.mint || tokenInfo?.mint;
  let signal = null;
  let indicatorOk = false;
  let athGate = null;

  if (mint && config.autoStrategy?.fetchIndicators !== false) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, {
        interval: config.autoStrategy?.indicatorInterval ?? "15_MINUTE",
        candles: config.indicators.candles ?? 298,
        rsiLength: config.indicators.rsiLength ?? 2,
      });
      signal = buildSignalSummary(payload);
      indicatorOk = true;
      if (config.autoStrategy?.athEntryGateEnabled) {
        athGate = evaluateAthEntryGate(payload, signal);
      }
    } catch (error) {
      log("strategy_router", `Indicator fetch failed for ${mint?.slice(0, 8)}: ${error.message}`);
    }
  }

  const priceChange1h = tokenInfo?.stats_1h?.price_change ?? pool?.price_change_1h ?? null;
  const classification = classifyMarketView({ pool, priceChange1h, signal });
  if (signal?.supertrendBreakUp) classification.bullishBreak = true;

  const fibHint = indicatorOk ? inferFibBins(signal) : null;
  let plan = buildDeployPlan({ pool, classification, signal, fibHint });

  const maxPumpPct = Number(config.autoStrategy?.maxPumpPct1h ?? 20);
  const pump1h = Number(priceChange1h);
  if (
    Number.isFinite(maxPumpPct) &&
    maxPumpPct > 0 &&
    Number.isFinite(pump1h) &&
    pump1h > maxPumpPct &&
    plan.strategy === "bid_ask" &&
    plan.deposit_side === "sol_below"
  ) {
    plan.entry_allowed = false;
    plan.entry_reason = `1h pump +${pump1h.toFixed(1)}% > ${maxPumpPct}% cap — bid_ask below would OOR; wait retracement`;
    plan.notes = [...(plan.notes || []), `Pump gate: skip SOL-below deploy after +${pump1h.toFixed(1)}% 1h`];
  }

  // Volatile-pool recall: last close (within 24h) was a pump-above-range —
  // force balanced spot with upside cover instead of repeating the same
  // one-sided range that just broke.
  const volatileRecall = pool?.pool ? hasRecentVolatileOorClose(pool.pool) : false;
  if (volatileRecall && plan.strategy !== "spot") {
    if (config.autoStrategy?.allowSpot !== false) {
      plan = convertPlanToBalancedSpot(plan, {
        baseBins: volatilityScaledBins(pool?.volatility),
        note: "Volatile-pool recall (recent pump-OOR close) — forced balanced spot",
      });
    } else if (plan.entry_allowed) {
      plan.entry_allowed = false;
      plan.entry_reason = "Volatile-pool recall — spot redeploy required but spot is disabled; skip";
    }
  }

  plan = applyTgeOverride(plan, { pool });

  applyPumpUpsideCoverGate(plan);

  // Evil Panda ATH gate (opt-in): only enter on a fresh ATH with supertrend
  // confirmation. Fails open when indicators are unavailable (noted in plan),
  // consistent with the other indicator gates.
  if (config.autoStrategy?.athEntryGateEnabled) {
    plan.ath_gate = athGate;
    if (athGate && !athGate.pass && plan.entry_allowed) {
      plan.entry_allowed = false;
      plan.entry_reason = athGate.reason;
    } else if (!athGate) {
      plan.notes = [...(plan.notes || []), "ath_gate: indicators unavailable — gate skipped (fail-open)"];
    }
  }

  plan.oor_risk = computeOorRisk({
    volatility: pool?.volatility,
    priceChange1h,
    binsBelow: plan.bins_below,
    binsAbove: plan.bins_above,
  });
  const maxOorRisk = Number(config.autoStrategy?.maxOorRisk ?? 65);
  if (plan.entry_allowed && Number.isFinite(maxOorRisk) && maxOorRisk > 0 && plan.oor_risk > maxOorRisk) {
    plan.entry_allowed = false;
    plan.entry_reason = `OOR risk ${plan.oor_risk} > ${maxOorRisk} — range likely breaks before fees cover the cycle`;
    plan.notes = [...(plan.notes || []), `OOR risk gate: ${plan.oor_risk}/100`];
  }

  // Volatile-recall pools keep a hard 65 ceiling even if the global gate is
  // looser or disabled — this pool already proved it breaks ranges.
  if (volatileRecall && plan.entry_allowed && plan.oor_risk > 65) {
    plan.entry_allowed = false;
    plan.entry_reason = `Volatile-pool recall with OOR risk ${plan.oor_risk} > 65 — skip redeploy`;
  }

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
  if (plan.oor_risk != null) lines.push(`  oor_risk: ${plan.oor_risk}/100`);
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

  // TGE Play override (opt-in): konservatif untuk pool TGE
  if (config.management.tgePlayEnabled && plan.tge) {
    const maxHoldHours = config.management.tgeMaxHoldHours ?? 8;
    const minBinsBelow = Math.max(35, config.strategy.minBinsBelow);
    return {
      ...args,
      strategy: config.autoStrategy?.allowSpot !== false ? "spot" : "bid_ask",
      bins_below: minBinsBelow,
      bins_above: config.autoStrategy?.allowSpot !== false ? 0 : 0,
      tge: true,
      tge_max_hold_hours: maxHoldHours,
      _auto_strategy_plan: plan,
    };
  }

  const merged = { ...args };
  if (!merged.strategy && plan.strategy) merged.strategy = plan.strategy;
  if (merged.bins_below == null && plan.bins_below != null) merged.bins_below = plan.bins_below;
  if (merged.bins_above == null && plan.bins_above != null) merged.bins_above = plan.bins_above;
  if (merged.amount_x == null) merged.amount_x = plan.amount_x ?? 0;
  if (plan.volatility != null && merged.volatility == null) merged.volatility = plan.volatility;
  if (plan.oor_risk != null && merged.oor_risk == null) merged.oor_risk = plan.oor_risk;
  if (plan.tge && merged.tge == null) merged.tge = true;
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