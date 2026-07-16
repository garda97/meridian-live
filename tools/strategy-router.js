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
  // Also index by base mint so deploy_position works even if the LLM picks a
  // different pool variant of the same token (one token can have several pools).
  const mint = plan?.base_mint || plan?.pool_base_mint;
  if (mint && plan) pendingPlans.set(mint, plan);
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
    // C — Bid-Ask Chill (LP Army 2-4): token mapan/stable.
    if (config.autoStrategy?.bidAskChillEnabled) {
      const tvl = Number(pool?.tvl ?? pool?.tvl_usd ?? 0);
      const createdRaw = Number(pool?.base?.created_at ?? pool?.created_at ?? 0);
      // created_at from Meteora API is in MILLISECONDS; normalize to seconds.
      const created = createdRaw > 1e12 ? createdRaw / 1000 : createdRaw;
      const ageHours = created > 0 ? (Date.now() / 1000 - created) / 3600 : 0;
      if (
        tvl >= (config.autoStrategy.chillMinTvl ?? 100000) &&
        ageHours >= (config.autoStrategy.chillMinAgeHours ?? 168) &&
        vol < (config.autoStrategy.chillMaxVolatility ?? 2)
      ) {
        return {
          view: "chill",
          confidence: "high",
          reason: `Bid-Ask Chill: stable token (TVL $${Math.round(tvl).toLocaleString()}, age ${Math.round(ageHours / 24)}d, vol ${vol.toFixed(2)})`,
        };
      }
    }
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

/**
 * Vladimir-style bid_ask downside target (% below active price).
 * Young token or wild 1h pump → 90%; established → 65%.
 */
export function resolveBidAskDownsidePct(pool, priceChange1h) {
  const cfg = config.autoStrategy;
  if (!cfg?.bidAskWideRangeEnabled) return null;
  const youngAge = Number(cfg.bidAskYoungMaxAgeHours ?? 48);
  const youngPump = Number(cfg.bidAskYoungPumpPct1h ?? 80);
  const age = Number(pool?.token_age_hours);
  const pump1h = Number(priceChange1h ?? pool?.price_change_1h);
  const isYoung = Number.isFinite(youngAge) && youngAge > 0 && Number.isFinite(age) && age < youngAge;
  const isWildPump = Number.isFinite(youngPump) && youngPump > 0 && Number.isFinite(pump1h) && pump1h >= youngPump;
  return (isYoung || isWildPump)
    ? Number(cfg.bidAskDownsidePctYoung ?? 90)
    : Number(cfg.bidAskDownsidePctMature ?? 65);
}

/** Apply % downside range to SOL-below bid_ask plans (spot/curve untouched). */
export function applyBidAskWideRange(plan, { pool, priceChange1h } = {}) {
  if (!plan || plan.strategy !== "bid_ask") return plan;
  if ((plan.bins_above ?? 0) > 0 || plan.deposit_side === "sol_balanced") return plan;
  const downside_pct = resolveBidAskDownsidePct(pool, priceChange1h);
  if (downside_pct == null) return plan;
  const youngAge = Number(config.autoStrategy?.bidAskYoungMaxAgeHours ?? 48);
  const youngPump = Number(config.autoStrategy?.bidAskYoungPumpPct1h ?? 80);
  const age = Number(pool?.token_age_hours);
  const pump1h = Number(priceChange1h ?? pool?.price_change_1h);
  let tier = "mature";
  if (Number.isFinite(age) && age < youngAge) tier = "young";
  else if (Number.isFinite(pump1h) && pump1h >= youngPump) tier = "pump";
  return {
    ...plan,
    downside_pct,
    upside_pct: 0,
    bins_below: undefined,
    bins_above: 0,
    wide_range: true,
    notes: [
      ...(plan.notes || []),
      `Bid-ask wide range (${tier}): ${downside_pct}% downside target`,
    ],
  };
}

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
  const notes = [];
  let baseBins = volatilityScaledBins(vol);
  // A — Supertrend dynamic range (Bid Ask and Chill): range from current price
  // down to 10% below the supertrend level, instead of fixed volatility scaling.
  if (config.autoStrategy?.supertrendRange && signal?.close != null && signal?.supertrendValue != null) {
    const close = signal.close;
    const lowerTarget = signal.supertrendValue * 0.9;
    const width = close - lowerTarget;
    const binStep = Number(pool?.dlmm_bin_step ?? pool?.bin_step);
    if (width > 0 && binStep > 0) {
      const binWidth = close * (Math.pow(1.0001, binStep) - 1);
      if (binWidth > 0) {
        const stBins = clampInt(Math.round(width / binWidth), config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
        if (stBins >= config.strategy.minBinsBelow) {
          baseBins = stBins;
          notes.push(`supertrendRange: ${stBins} bins (close ${close.toFixed(6)} → 10% below ST ${lowerTarget.toFixed(6)})`);
        }
      }
    }
  }
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
    case "chill": {
      // C — Bid-Ask Chill (LP Army 2-4): mapan/stable → wide range bid_ask balanced,
      // ambil fee + DCA (jual di atas, beli di bawah). Pakai max width.
      if (allowSpot) {
        strategy = "bid_ask";
        depositSide = "sol_balanced";
        const total = clampInt(config.autoStrategy?.maxBins ?? 200, config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
        binsBelow = clampInt(total * 0.5, Math.ceil(config.strategy.minBinsBelow * 0.5), total);
        binsAbove = Math.max(0, total - binsBelow);
        notes.push("Bid-Ask Chill: wide balanced range, fee capture + DCA on stable token");
      } else {
        strategy = "bid_ask";
        depositSide = "sol_below";
        binsBelow = clampInt(config.autoStrategy?.maxBins ?? 200, config.strategy.minBinsBelow, config.autoStrategy?.maxBins ?? 200);
        binsAbove = 0;
        notes.push("Bid-Ask Chill: wide SOL-below range (spot disabled)");
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

/**
 * maxPumpPct1h cap for ALL strategies (FABLE lesson): the cap used to fire
 * only on bid_ask sol_below plans, so pump-view spot top-ticked a +34% 1h run.
 * Chasing is chasing regardless of shape — bid_ask below OORs on the next leg,
 * spot eats the retrace as IL. Pure; returns a new plan.
 */
export function applyPumpChaseCap(plan, { priceChange1h } = {}) {
  if (!plan.entry_allowed) return plan;
  const maxPumpPct = Number(config.autoStrategy?.maxPumpPct1h ?? 20);
  const pump1h = Number(priceChange1h);
  if (!Number.isFinite(maxPumpPct) || maxPumpPct <= 0) return plan;
  if (!Number.isFinite(pump1h) || pump1h <= maxPumpPct) return plan;
  return {
    ...plan,
    entry_allowed: false,
    entry_reason: `1h pump +${pump1h.toFixed(1)}% > ${maxPumpPct}% cap — chasing (${plan.strategy}); wait retracement`,
    notes: [...(plan.notes || []), `Pump gate: +${pump1h.toFixed(1)}% 1h > ${maxPumpPct}% cap (${plan.strategy})`],
  };
}

/**
 * Universal fee floor for spot deploys (SEMAN/FABLE lesson): spot takes
 * immediate token exposure, so the fee tier must pay for the retrace risk —
 * the spotFeeTvlMin doctrine used to be checked only on the high-fee bias
 * path, letting pump/sideways/flat native-spot plans through at any fee.
 * Below the floor: pump-view and volatile-recall plans are blocked (their
 * matrices forbid bid_ask sol_below), other views fall back to bid_ask below.
 * TGE plans keep their own tgeMinFeePct gate. Missing fee data fails open,
 * consistent with the other indicator gates. Pure; returns a new plan.
 */
export function applySpotFeeFloor(plan, { pool, volatileRecall = false } = {}) {
  if (plan.strategy !== "spot" || plan.tge || !plan.entry_allowed) return plan;
  const minFee = Number(config.autoStrategy?.spotFeeTvlMin ?? 2);
  if (!Number.isFinite(minFee) || minFee <= 0) return plan;
  const feeTvl = Number(pool?.fee_active_tvl_ratio ?? pool?.fee_tvl_ratio);
  if (!Number.isFinite(feeTvl)) {
    return { ...plan, notes: [...(plan.notes || []), "Spot fee floor: fee/TVL unknown — floor skipped (fail-open)"] };
  }
  if (feeTvl >= minFee) return plan;
  if (plan.market_view === "pump" || volatileRecall) {
    return {
      ...plan,
      entry_allowed: false,
      entry_reason: `Spot fee floor: fee/TVL ${feeTvl.toFixed(2)} < ${minFee} — fee tier can't pay for token exposure (${volatileRecall ? "volatile recall" : plan.market_view}); skip`,
      notes: [...(plan.notes || []), `Spot fee floor: ${feeTvl.toFixed(2)} < ${minFee} — blocked`],
    };
  }
  const binsBelow = volatilityScaledBins(pool?.volatility);
  return {
    ...plan,
    strategy: "bid_ask",
    deposit_side: "sol_below",
    bins_below: binsBelow,
    bins_above: 0,
    wide_range: binsBelow > 69,
    notes: [...(plan.notes || []), `Spot fee floor: fee/TVL ${feeTvl.toFixed(2)} < ${minFee} — fell back to bid_ask below`],
  };
}

/**
 * Dump gate for spot deploys (SEMAN lesson, P1c — SPOT_LOSS_ANALYSIS.md):
 * spot takes immediate two-sided token exposure, so entering while the token
 * is actively dumping eats the drop as real loss from the moment of deploy.
 * bid_ask-below (ladder buy) is unaffected — accumulating below an active
 * dump is its intended use case; only spot's immediate exposure is blocked.
 * Symmetric to applyPumpChaseCap (P1a), same cap, opposite direction.
 * Pure; returns a new plan.
 */
export function applySpotDumpGate(plan, { priceChange1h } = {}) {
  if (plan.strategy !== "spot" || !plan.entry_allowed) return plan;
  const maxPumpPct = Number(config.autoStrategy?.maxPumpPct1h ?? 20);
  const pump1h = Number(priceChange1h);
  if (!Number.isFinite(maxPumpPct) || maxPumpPct <= 0) return plan;
  if (!Number.isFinite(pump1h) || pump1h >= -maxPumpPct) return plan;
  return {
    ...plan,
    entry_allowed: false,
    entry_reason: `1h dump ${pump1h.toFixed(1)}% < -${maxPumpPct}% cap — spot avoided (active dump, two-sided exposure); wait for stabilization`,
    notes: [...(plan.notes || []), `Dump gate: ${pump1h.toFixed(1)}% 1h < -${maxPumpPct}% cap — spot blocked`],
  };
}

/**
 * B — Drop-entry gate (Drop and bidask): only enter when price has pulled
 * back into the dip zone (config.autoStrategy.dropEntryMin..dropEntryMax, 1h).
 * Defaults if unset: -50%..-30%. Live Meridian often uses sideway-friendly
 * -15%..+10%. Blocks FOMO pumps and too-deep dumps. Fail-closed on unknown chg.
 */
export function applyDropEntryGate(plan, { priceChange1h } = {}) {
  if (!config.autoStrategy?.dropEntryGate || !plan.entry_allowed) return plan;
  const chg = Number(priceChange1h);
  if (!Number.isFinite(chg)) {
    return { ...plan, entry_allowed: false, entry_reason: "Drop-entry gate: price change unavailable — fail-closed (skip)", notes: [...(plan.notes || []), "Drop-entry gate: no 1h change — blocked"] };
  }
  const minDrop = Number(config.autoStrategy?.dropEntryMin ?? -50);
  const maxDrop = Number(config.autoStrategy?.dropEntryMax ?? -30);
  if (chg > maxDrop) {
    return { ...plan, entry_allowed: false, entry_reason: `Drop-entry gate: ${chg.toFixed(1)}% not in dip zone [${minDrop}%, ${maxDrop}%] (FOMO guard)`, notes: [...(plan.notes || []), `Drop-entry: ${chg.toFixed(1)}% > ${maxDrop}% — blocked (not a dip)`] };
  }
  if (chg < minDrop) {
    return { ...plan, entry_allowed: false, entry_reason: `Drop-entry gate: already dropped ${chg.toFixed(1)}% (< ${minDrop}%, possible dump/dead)`, notes: [...(plan.notes || []), `Drop-entry: ${chg.toFixed(1)}% < ${minDrop}% — blocked (too deep)`] };
  }
  return { ...plan, notes: [...(plan.notes || []), `Drop-entry: in dip zone ${chg.toFixed(1)}% [${minDrop}%, ${maxDrop}%] — allowed`] };
}

/**
 * Pure: what should the ATH gate do given the evaluated result (or null if
 * indicators were unavailable this call) and the configured fail mode?
 * "open" (default): unavailable indicators skip the gate, deploy proceeds.
 * "closed": unavailable indicators block the deploy instead (P2a, SPOT_LOSS_ANALYSIS.md).
 * Exported for unit testing.
 */
export function resolveAthGateOutcome(athGate, failMode) {
  if (athGate) {
    return athGate.pass
      ? { blocked: false }
      : { blocked: true, reason: athGate.reason };
  }
  if (failMode === "closed") {
    return { blocked: true, reason: "ath_gate: indicators unavailable — fail-closed (athGateFailMode=closed)" };
  }
  return { blocked: false, note: "ath_gate: indicators unavailable — gate skipped (fail-open)" };
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

  plan = applyPumpChaseCap(plan, { priceChange1h });

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

  plan = applySpotFeeFloor(plan, { pool, volatileRecall });

  plan = applySpotDumpGate(plan, { priceChange1h });
  plan = applyDropEntryGate(plan, { priceChange1h });

  applyPumpUpsideCoverGate(plan);

  plan = applyBidAskWideRange(plan, { pool, priceChange1h });

  // Evil Panda ATH gate (opt-in): only enter on a fresh ATH with supertrend
  // confirmation. See resolveAthGateOutcome for the fail-open/fail-closed split.
  if (config.autoStrategy?.athEntryGateEnabled) {
    plan.ath_gate = athGate;
    const athOutcome = resolveAthGateOutcome(athGate, config.autoStrategy?.athGateFailMode);
    if (athOutcome.blocked && plan.entry_allowed) {
      plan.entry_allowed = false;
      plan.entry_reason = athOutcome.reason;
    } else if (athOutcome.note) {
      plan.notes = [...(plan.notes || []), athOutcome.note];
    }
  }

  const oorBinsBelow = plan.downside_pct != null
    ? (config.autoStrategy?.maxBins ?? 200)
    : plan.bins_below;
  plan.oor_risk = computeOorRisk({
    volatility: pool?.volatility,
    priceChange1h,
    binsBelow: oorBinsBelow,
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
//  clearPendingDeployPlans(); // Hermes: Removed - plans should persist until consumed by deploy_position
  const plans = await Promise.all(
    candidates.map(async (entry) => {
      const plan = await resolveDeployStrategyForCandidate({
        pool: entry.pool,
        tokenInfo: entry.ti,
      });
      if (entry.pool?.pool) {
        plan.base_mint = plan.base_mint || entry.pool.base?.mint || entry.pool.base_mint || null;
        setPendingDeployPlan(entry.pool.pool, plan);
      }
      return { entry, plan };
    }),
  );
  return plans;
}

export function formatDeployPlanBlock(plan) {
  if (!plan) return "";
  const lines = [
    `  auto_strategy: ${plan.strategy} | market_view: ${plan.market_view} (${plan.view_reason})`,
    plan.downside_pct != null
      ? `  deploy_plan: SOL-only bid_ask | downside=${plan.downside_pct}% upside=0%${plan.wide_range ? " WIDE" : ""}`
      : `  deploy_plan: SOL-only | bins_below=${plan.bins_below} bins_above=${plan.bins_above}${plan.wide_range ? " WIDE" : ""}`,
    plan.downside_pct != null
      ? `  FINAL_RANGE_OK: use downside_pct=${plan.downside_pct} (do not recompute bins from volatility)`
      : `  FINAL_BINS_OK: ${plan.bins_below + plan.bins_above} total bins (min 60 satisfied) — USE THESE EXACT NUMBERS, do not recompute`,
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
  let plan = getPendingDeployPlan(args.pool_address);
  // Fallback: the LLM may pass a different pool variant of the same token, or
  // a base mint directly. Look up by base_mint so the router plan still applies.
  if (!plan && args.base_mint) plan = getPendingDeployPlan(args.base_mint);
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
  // FORCE mode: when autoStrategy is enabled, the router's resolved plan is the
  // source of truth. The LLM occasionally hallucinates bin counts (e.g. reads
  // bin_step and invents "26 bins" < minBinsBelow) and then refuses to deploy a
  // perfectly valid plan. Override the LLM's bins/strategy with the router's
  // authoritative values instead of only filling when null.
  if (plan.strategy) merged.strategy = plan.strategy;
  if (plan.strategy === "bid_ask" && plan.downside_pct != null && config.autoStrategy?.bidAskWideRangeEnabled) {
    merged.downside_pct = plan.downside_pct;
    merged.upside_pct = plan.upside_pct ?? 0;
    delete merged.bins_below;
    delete merged.bins_above;
  } else {
    if (plan.bins_below != null) merged.bins_below = plan.bins_below;
    if (plan.bins_above != null) merged.bins_above = plan.bins_above;
    // The router plans use bins_below/bins_above directly. If the LLM also passed
    // downside_pct/upside_pct, deployPosition (dlmm.js) would RE-DERIVE bins from
    // those percentages and collapse to 0 bins when pct≈0. Strip them so dlmm.js
    // honors the router's exact bin counts instead of recomputing from pct.
    if (plan.bins_below != null || plan.bins_above != null) {
      delete merged.downside_pct;
      delete merged.upside_pct;
    }
  }
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