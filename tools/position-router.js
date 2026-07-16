/**
 * Position router — POWER MODE rebalance decision engine.
 *
 * Re-analyzes open positions every management tick and decides
 * hold / rebalance / close, mirroring the entry-side strategy-router matrix
 * (classifyMarketView + buildDeployPlan are reused, not duplicated).
 *
 * All decision functions are pure and testable; only
 * resolveRebalancePlanForPosition touches the network.
 */

import { config } from "../config.js";
import { computeTokenValueShare } from "./dlmm/rules.js";
import { log } from "../logger.js";
import {
  classifyMarketView,
  buildDeployPlan,
  computeOorRisk,
  applySpotFeeFloor,
  applySpotDumpGate,
} from "./strategy-router.js";
import { hasRecentVolatileOorClose } from "../pool-memory.js";
import { buildSignalSummary, fetchChartIndicatorsForMint } from "./chart-indicators.js";
import { getPoolDetail } from "./screening.js";
import { getTokenInfo } from "./token.js";

/**
 * Volatility-scaled rebalance timing (mirrors volatilityScaledBins' vol/5
 * pivot in strategy-router.js): higher volatility shrinks the wait windows
 * (faster reaction), lower volatility stretches them. The factor is clamped
 * to 0.3-2x of base so a noisy volatility feed can never zero-out or freeze
 * the timers. Invalid/missing volatility returns the flat base values.
 */
export function volatilityScaledRebalanceTiming(volatility, { baseOorMinutes, baseCooldownMinutes } = {}) {
  const oorBase = Number(baseOorMinutes);
  const cooldownBase = Number(baseCooldownMinutes);
  const vol = Number(volatility);
  if (!Number.isFinite(vol) || vol <= 0) {
    return { oorMinutes: oorBase, cooldownMinutes: cooldownBase };
  }
  const factor = Math.max(0.3, Math.min(2, 2 - (vol / 5) * 1.7));
  const scale = (base) => (Number.isFinite(base) ? Math.round(base * factor * 10) / 10 : base);
  return { oorMinutes: scale(oorBase), cooldownMinutes: scale(cooldownBase) };
}

const SPOT_REBALANCE_TYPES = new Set(["convert_to_spot", "widen_spot"]);

/**
 * Entry-side spot gates also apply when a rebalance switches shape to spot
 * (FABLE/maxxing lesson): convert_to_spot and widen_spot reused buildDeployPlan
 * bins but skipped applySpotFeeFloor / applySpotDumpGate — low-fee spot mid-hold
 * ate -83% IL. Pump-chase is intentionally omitted here: widen_spot is the
 * in-flight fix for an already-OOR pump leg, not a fresh chase entry.
 */
export function applySpotRebalanceGates(plan, { pool, priceChange1h } = {}) {
  if (plan?.action !== "rebalance" || !SPOT_REBALANCE_TYPES.has(plan.rebalance_type)) {
    return plan;
  }

  const volatileRecall = pool?.pool ? hasRecentVolatileOorClose(pool.pool) : false;
  let gatePlan = {
    strategy: "spot",
    market_view: plan.market_view,
    entry_allowed: true,
    entry_reason: plan.reason || "spot rebalance",
    bins_below: plan.bins_below,
    bins_above: plan.bins_above,
    deposit_side: plan.deposit_side,
    notes: [],
    tge: false,
  };

  gatePlan = applySpotFeeFloor(gatePlan, { pool, volatileRecall });
  gatePlan = applySpotDumpGate(gatePlan, { priceChange1h });

  const mergedNotes = [...(plan.notes || []), ...(gatePlan.notes || [])];

  if (!gatePlan.entry_allowed) {
    return {
      ...plan,
      action: "hold",
      rebalance_type: null,
      reason: `Spot rebalance blocked: ${gatePlan.entry_reason}`,
      notes: mergedNotes,
    };
  }

  if (gatePlan.strategy !== "spot") {
    const feeNote = gatePlan.notes?.find((n) => n.includes("Spot fee floor")) || "fee floor — keep current shape";
    return {
      ...plan,
      action: "hold",
      rebalance_type: null,
      reason: `Spot rebalance blocked: ${feeNote}`,
      notes: mergedNotes,
    };
  }

  return {
    ...plan,
    strategy: gatePlan.strategy,
    deposit_side: gatePlan.deposit_side,
    bins_below: gatePlan.bins_below,
    bins_above: gatePlan.bins_above,
    wide_range: (gatePlan.bins_below || 0) + (gatePlan.bins_above || 0) > 69,
    notes: mergedNotes,
  };
}

/** Which side of its range a position sits on. */
export function classifyOorDirection(position = {}) {
  const active = Number(position.active_bin);
  const lower = Number(position.lower_bin);
  const upper = Number(position.upper_bin);
  if (!Number.isFinite(active) || !Number.isFinite(lower) || !Number.isFinite(upper)) return "unknown";
  if (active > upper) return "up";
  if (active < lower) return "down";
  return "in";
}

/**
 * Build a rebalance plan from live pool + position context. Pure.
 * Returns { action: "hold"|"rebalance"|"close", rebalance_type, market_view,
 *   view_reason, strategy, bins_below, bins_above, deposit_side, oor_risk,
 *   upside_cover_pct, reason, notes[] }.
 */
export function buildRebalancePlan({ pool, position, tracked, signal, priceChange1h, mgmtConfig }) {
  const mgmt = mgmtConfig || config.management;
  const volume = Number(pool?.volume ?? pool?.volume_window ?? 0);
  const minVolume = Number(mgmt.minVolumeToRebalance ?? 1000);
  const volumeAlive = Number.isFinite(volume) && volume >= minVolume;
  const oorDirection = classifyOorDirection(position);
  const currentStrategy = tracked?.strategy || position?.strategy || null;

  const classification = classifyMarketView({ pool, priceChange1h, signal });
  const base = buildDeployPlan({ pool, classification, signal, fibHint: null });
  const view = classification.view;

  const mk = (overrides) => ({
    action: "hold",
    rebalance_type: null,
    market_view: view,
    view_reason: classification.reason,
    oor_direction: oorDirection,
    strategy: base.strategy,
    deposit_side: base.deposit_side,
    bins_below: base.bins_below,
    bins_above: base.bins_above,
    wide_range: base.bins_below + base.bins_above > 69,
    oor_risk: null,
    upside_cover_pct: null,
    volume,
    // Threaded through so shouldRebalance can scale its timers without a
    // second network fetch (pool detail is only available here).
    volatility: Number(pool?.volatility) || null,
    reason: "",
    notes: [...(base.notes || [])],
    ...overrides,
  });

  let plan;
  if (oorDirection === "up") {
    if (!volumeAlive) {
      plan = mk({ action: "close", reason: `OOR upside + volume $${volume} < $${minVolume} — pump exhausted, close` });
    } else if (view === "pump") {
      // FABLE fix mid-flight: price ran above a one-sided range — re-anchor as
      // balanced spot so the next leg up still earns.
      plan = mk({
        action: "rebalance",
        rebalance_type: "widen_spot",
        reason: "OOR upside on active pump — re-anchor balanced spot with upside cover",
      });
    } else {
      plan = mk({
        action: "rebalance",
        rebalance_type: "shift_up",
        reason: `OOR upside (${view}) — shift range up to fresh active bin`,
      });
    }
  } else if (oorDirection === "down") {
    if (!volumeAlive) {
      plan = mk({ action: "close", reason: `OOR downside + volume $${volume} < $${minVolume} — token dead, close` });
    } else {
      plan = mk({
        action: "rebalance",
        rebalance_type: "reseed_below",
        reason: `OOR downside with live volume ($${volume}) — reseed below fresh active bin`,
      });
    }
  } else if (oorDirection === "in") {
    const flipCheck = shouldFlipToCurve({ position, tracked, cfg: config });
    if (flipCheck.flip) {
      plan = mk({
        action: "rebalance",
        rebalance_type: "flip_to_curve",
        strategy: "curve",
        reason: flipCheck.reason,
        token_value_share: flipCheck.token_value_share,
      });
    } else {
      const reshapeCheck = shouldReshape({ position, tracked, activeBin: position?.active_bin, cfg: config });
      if (reshapeCheck.reshape) {
        plan = mk({
          action: "rebalance",
          rebalance_type: "reshape",
          strategy: tracked?.strategy || "curve",
          reason: reshapeCheck.reason,
          active_bin: reshapeCheck.active_bin,
        });
      } else if (view === "breakdown" && classification.confidence === "high" && volumeAlive) {
      plan = mk({
        action: "rebalance",
        rebalance_type: "reseed_below",
        reason: "Supertrend breakdown while in range — reseed wide below before the leg down",
      });
    } else if (
      mgmt.rebalanceOnStrategyDrift !== false &&
      view === "sideways" &&
      currentStrategy === "bid_ask" &&
      base.strategy === "spot"
    ) {
      plan = mk({
        action: "rebalance",
        rebalance_type: "convert_to_spot",
        reason: "Strategy drift: deployed bid_ask but market went sideways — convert to spot",
      });
    } else {
      plan = mk({ action: "hold", reason: `In range, ${view} view — hold` });
    }
    }
  } else {
    plan = mk({ action: "hold", reason: "Position bin data unavailable — hold" });
  }

  // Entry gates from the base plan also veto a rebalance re-entry (e.g. RSI
  // extended on pump) — holding is cheaper than re-anchoring into a bad entry.
  if (plan.action === "rebalance" && base.entry_allowed === false) {
    plan = { ...plan, action: "hold", rebalance_type: null, reason: `Re-entry blocked: ${base.entry_reason}` };
  }

  plan = applySpotRebalanceGates(plan, { pool, priceChange1h });

  // Same OOR-risk gate as entry: if the NEW range would likely break before
  // fees cover the cycle, close instead of churning rebalances.
  if (plan.action === "rebalance") {
    const skipOorRisk = plan.rebalance_type === "reshape" || plan.rebalance_type === "flip_to_curve";
    const totalBins = (plan.bins_below || 0) + (plan.bins_above || 0);
    plan.upside_cover_pct = totalBins > 0 ? Math.round(((plan.bins_above || 0) / totalBins) * 1000) / 10 : 0;
    if (!skipOorRisk) {
    plan.oor_risk = computeOorRisk({
      volatility: pool?.volatility,
      priceChange1h,
      binsBelow: plan.bins_below,
      binsAbove: plan.bins_above,
    });
    const maxOorRisk = Number(config.autoStrategy?.maxOorRisk ?? 65);
    if (Number.isFinite(maxOorRisk) && maxOorRisk > 0 && plan.oor_risk > maxOorRisk) {
      plan = {
        ...plan,
        action: "close",
        rebalance_type: null,
        reason: `Re-plan OOR risk ${plan.oor_risk} > ${maxOorRisk} — new range would likely break too; close`,
      };
    }
    }
  }

  return plan;
}

/**
 * Age of the position in minutes for rebalance gates.
  * Prefers live poller age_minutes; falls back to tracked.deployed_at.
  * null = unknown (do not block — avoids stranding untracked edge cases).
  */
export function positionAgeMinutes(position, tracked, nowMs = Date.now()) {
   const a = Number(position?.age_minutes);
   if (Number.isFinite(a) && a >= 0) return a;
   const t = tracked?.deployed_at || tracked?.opened_at || position?.deployed_at;
   if (t) {
     const ms = nowMs - new Date(t).getTime();
     if (Number.isFinite(ms) && ms >= 0) return ms / 60000;
   }
   return null;
 }

 /**
  * Post-open quiet window: block rebalance (esp. in-range supertrend reseed)
  * until the position is old enough. Confirmed OOR (minutes_out_of_range >=
  * rebalanceMinOorMinutes) may bypass — real range break, not thrash.
  */
export function isWithinRebalanceMinAge({ position, tracked, mgmtConfig, nowMs = Date.now() }) {
   const mgmt = mgmtConfig || config.management;
   const minAge = Number(mgmt.rebalanceMinAgeMinutes ?? 0);
   if (!(minAge > 0)) return false;
   const age = positionAgeMinutes(position, tracked, nowMs);
   // Unknown age: treat as young. Brand-new positions often hit the 3s PnL
   // poll before age_minutes / deployed_at are populated — allowing rebalance
   // then caused supertrend reseed thrash ~16–30s after open (ok-SOL / pendu).
   if (age != null && age >= minAge) return false;
   const dir = classifyOorDirection(position);
   const oorFor = Number(position?.minutes_out_of_range ?? 0);
   const oorMin = Number(mgmt.rebalanceMinOorMinutes ?? 5);
   if ((dir === "up" || dir === "down") && Number.isFinite(oorFor) && oorFor >= oorMin) {
     return false; // confirmed OOR — allow
   }
   return true; // still in quiet window (or age unknown)
 }

 /**
  * Returns { action: "rebalance"|"close"|"hold", reason, plan }.
  * "close" here only ever DOWNGRADES a wanted rebalance (dead volume, max
  * count, deep PnL, risky re-plan) — it never invents a close for a healthy
  * hold, so existing exit rules stay the only close authority otherwise.
  */
export function shouldRebalance({ plan, position, tracked, mgmtConfig, nowMs = Date.now() }) {
   const mgmt = mgmtConfig || config.management;
   const hold = (reason) => ({ action: "hold", reason, plan });

   if (!plan) return hold("no plan");
   if (mgmt.autoRebalanceEnabled === false) return hold("autoRebalanceEnabled=false");
   if (tracked?.closed) return hold("position already closed");
   if (position?.pnl_pct_suspicious) return hold("PnL suspicious this tick — skip");

   if (plan.action === "close") return { action: "close", reason: plan.reason, plan };
   if (plan.action !== "rebalance") return hold(plan.reason || "plan says hold");

   const pnl = Number(position?.pnl_pct);
   const minPnl = Number(mgmt.rebalanceMinPnlPct ?? -8);
   if (Number.isFinite(pnl) && Number.isFinite(minPnl) && pnl <= minPnl) {
     return {
       action: "close",
       reason: `PnL ${pnl}% <= rebalance floor ${minPnl}% — close, don't rebalance into the knife`,
       plan,
     };
   }

   const count = Number(tracked?.rebalance_count ?? 0);
   const maxCount = Number(mgmt.rebalanceMaxPerPosition ?? 3);
   if (count >= maxCount) {
     return {
       action: "close",
       reason: `Rebalance budget spent (${count}/${maxCount}) — range keeps breaking, close`,
       plan,
     };
   }

   // Post-open quiet window (in-range reseed/drift thrash). Confirmed OOR bypasses.
   if (isWithinRebalanceMinAge({ position, tracked, mgmtConfig: mgmt, nowMs })) {
     const age = positionAgeMinutes(position, tracked, nowMs);
     const minAge = Number(mgmt.rebalanceMinAgeMinutes ?? 0);
     return hold(`post-open quiet ${age?.toFixed?.(1) ?? age}/${minAge}m — no rebalance thrash`);
   }

   // Opt-in volatility scaling; falls back to the flat config minutes when the
   // flag is off or the plan carries no usable volatility.
   const scaledTiming = mgmt.rebalanceVolatilityScalingEnabled === true
     ? volatilityScaledRebalanceTiming(plan.volatility, {
         baseOorMinutes: Number(mgmt.rebalanceMinOorMinutes ?? 5),
         baseCooldownMinutes: Number(mgmt.rebalanceCooldownMinutes ?? 15),
       })
     : null;

   const lastAt = tracked?.last_rebalance_attempt_at || tracked?.last_rebalance_at;
   const cooldownMin = scaledTiming ? scaledTiming.cooldownMinutes : Number(mgmt.rebalanceCooldownMinutes ?? 15);
   if (lastAt && cooldownMin > 0) {
     const elapsedMin = (nowMs - new Date(lastAt).getTime()) / 60000;
     if (elapsedMin < cooldownMin) {
       return hold(`rebalance cooldown ${elapsedMin.toFixed(1)}/${cooldownMin}m`);
     }
   }

   // OOR rebalances wait a short confirmation window (price may snap back);
   // in-range conversions (strategy drift) have no OOR clock to respect.
   if (plan.oor_direction === "up" || plan.oor_direction === "down") {
     const oorMin = scaledTiming ? scaledTiming.oorMinutes : Number(mgmt.rebalanceMinOorMinutes ?? 5);
     const oorFor = Number(position?.minutes_out_of_range ?? 0);
     if (oorFor < oorMin) return hold(`OOR ${oorFor}m < rebalanceMinOorMinutes ${oorMin}m — wait`);
   }

   return { action: "rebalance", reason: plan.reason, plan };
   }

   /**
   * In-range re-center for curve/spot (ported from fees-maxi reshape).
   */
   export function shouldReshape({ position, tracked, activeBin, cfg = config }) {
   const reshapeCfg = cfg.reshape || {};
   if (!reshapeCfg.enabled) return { reshape: false, reason: "reshape_disabled" };

   const strategy = String(tracked?.strategy || "").toLowerCase();
   if (strategy !== "curve" && strategy !== "spot") {
     return { reshape: false, reason: "reshape_not_curve_or_spot" };
   }
   if (!position?.in_range) return { reshape: false, reason: "out_of_range" };

   const active = Number(activeBin ?? position?.active_bin);
   const lastBin = Number(tracked?.last_reshape_bin);
   if (!Number.isFinite(active)) return { reshape: false, reason: "active_bin_unknown" };

   const trigger = Math.max(1, Number(reshapeCfg.binTrigger) || 3);
   const drift = Number.isFinite(lastBin) ? Math.abs(active - lastBin) : trigger;
   if (drift < trigger) {
     return { reshape: false, reason: `bin_drift_${drift}_lt_${trigger}` };
   }

   const minMs = Math.max(0, Number(reshapeCfg.minIntervalMs) || 10_000);
   if (tracked?.last_reshape_at) {
     const elapsed = Date.now() - new Date(tracked.last_reshape_at).getTime();
     if (elapsed < minMs) {
       return { reshape: false, reason: `reshape_cooldown_${Math.round(elapsed / 1000)}s` };
     }
   }

   return {
     reshape: true,
     reason: `bin_drift_${drift}_gte_${trigger}_active_${active}`,
     active_bin: active,
   };
   }

   /**
   * bid_ask → curve when token value share settles ~50:50 (no swap).
   */
   export function shouldFlipToCurve({ position, tracked, cfg = config }) {
   const flipCfg = cfg.flip || {};
   if (!flipCfg.enabled) return { flip: false, reason: "flip_disabled" };

   const strategy = String(tracked?.strategy || "").toLowerCase();
   if (strategy !== "bid_ask") return { flip: false, reason: "not_bid_ask" };
   if (!position?.in_range) return { flip: false, reason: "out_of_range" };

   const solMode = !!cfg.management?.solMode;
   const share = computeTokenValueShare(position, solMode);
   if (share == null) return { flip: false, reason: "token_share_unknown" };

   const low = Number(flipCfg.ratioLow) || 0.4;
   const high = Number(flipCfg.ratioHigh) || 0.6;
   if (share < low || share > high) {
     return { flip: false, reason: `token_share_${share.toFixed(3)}_outside_${low}_${high}` };
   }

   return {
     flip: true,
     reason: `token_share_${share.toFixed(3)}_in_band`,
     token_value_share: share,
   };
   }

   // ─── TVL dilution exit (Gap 3) ─────────────────────────────────

/**
 * Share + growth math for the dilution check. Pure; nulls when inputs missing.
 */
export function computeTvlDilution({ positionValueUsd, poolTvlUsd, entryTvlUsd }) {
  const value = Number(positionValueUsd);
  const tvl = Number(poolTvlUsd);
  const entry = Number(entryTvlUsd);
  const share = Number.isFinite(value) && value > 0 && Number.isFinite(tvl) && tvl > 0
    ? Math.round((value / tvl) * 10000) / 100
    : null;
  const growth = Number.isFinite(tvl) && tvl > 0 && Number.isFinite(entry) && entry > 0
    ? Math.round((tvl / entry) * 100) / 100
    : null;
  return { position_share_pct: share, tvl_growth_x: growth };
}

/**
 * Post-deploy dilution exit: fires only when ALL three hold —
 * our share collapsed (< shareExitMinPct), the pool's TVL actually exploded
 * since entry (> shareExitTvlGrowthMin ×), and the yield is already below the
 * low-yield floor. A small share alone is healthy (fees stay proportional);
 * TVL growth alone can mean the pool is hot. Opt-in via shareExitEnabled.
 * Returns { action: "TVL_DILUTION", reason } or null.
 */
export function checkTvlDilutionExit(dilution, positionData, mgmtConfig) {
  const mgmt = mgmtConfig || config.management;
  if (mgmt.shareExitEnabled !== true) return null;
  const { position_share_pct: share, tvl_growth_x: growth } = dilution || {};
  if (share == null || growth == null) return null;
  if (positionData?.pnl_pct_suspicious) return null;

  const minShare = Number(mgmt.shareExitMinPct ?? 2);
  const minGrowth = Number(mgmt.shareExitTvlGrowthMin ?? 3);
  const yieldFloor = Number(mgmt.minFeePerTvl24h ?? 7);
  const feePerTvl = Number(positionData?.fee_per_tvl_24h);

  if (share >= minShare) return null;
  if (growth <= minGrowth) return null;
  if (!Number.isFinite(feePerTvl) || feePerTvl >= yieldFloor) return null;

  return {
    action: "TVL_DILUTION",
    reason: `TVL dilution: share ${share}% < ${minShare}%, pool TVL grew ${growth}x since entry, yield ${feePerTvl}% < ${yieldFloor}%`,
  };
}

/**
 * Cheap pre-gate (no network): is this position even worth resolving a plan
 * for right now? Keeps the 3s poller from hammering APIs.
 */
export function isRebalanceCandidate({ position, tracked, mgmtConfig, nowMs = Date.now() }) {
  const mgmt = mgmtConfig || config.management;
  if (mgmt.autoRebalanceEnabled === false) return false;
  if (!tracked || tracked.closed) return false;
  if (Number(tracked.rebalance_count ?? 0) >= Number(mgmt.rebalanceMaxPerPosition ?? 3)) return false;

  // Cheap pre-gate: skip network resolve during post-open quiet window
  // (except confirmed OOR — handled inside isWithinRebalanceMinAge).
  if (isWithinRebalanceMinAge({ position, tracked, mgmtConfig: mgmt, nowMs })) return false;

  const lastAt = tracked.last_rebalance_attempt_at || tracked.last_rebalance_at;
  const cooldownMin = Number(mgmt.rebalanceCooldownMinutes ?? 15);
  if (lastAt && cooldownMin > 0 && (nowMs - new Date(lastAt).getTime()) / 60000 < cooldownMin) return false;

  const dir = classifyOorDirection(position);
  if (dir === "up" || dir === "down") {
    return Number(position?.minutes_out_of_range ?? 0) >= Number(mgmt.rebalanceMinOorMinutes ?? 5);
  }
  const strat = String(tracked.strategy || "").toLowerCase();
  if (dir === "in") {
    if (config.flip?.enabled && strat === "bid_ask") return true;
    if (config.reshape?.enabled && (strat === "curve" || strat === "spot")) return true;
  }
  // In-range: only worth a look for strategy drift, on the slow cycle.
  return mgmt.rebalanceOnStrategyDrift !== false && (tracked.strategy || null) === "bid_ask";
}

/**
 * Fetch live pool + indicator context and build the plan. Network path —
 * call only after isRebalanceCandidate passes.
 */
export async function resolveRebalancePlanForPosition({ position, tracked }) {
  const poolAddress = position?.pool || tracked?.pool;
  if (!poolAddress) return null;

  let pool = null;
  try {
    const raw = await getPoolDetail({ pool_address: poolAddress, timeframe: config.screening?.timeframe || "5m" });
    pool = {
      pool: raw.pool_address ?? poolAddress,
      volatility: Number(raw.volatility) || null,
      fee_active_tvl_ratio: Number(raw.fee_active_tvl_ratio) || null,
      volume: Number(raw.volume) || 0,
      price_change_1h: raw.price_change_1h ?? null,
      base_mint: raw.token_x?.address ?? null,
    };
  } catch (e) {
    log("position_router", `Pool detail fetch failed for ${String(poolAddress).slice(0, 8)}: ${e.message}`);
    return null; // fail-open: no plan → existing close rules own the position
  }

  const mint = pool.base_mint || position?.base_mint || null;
  let signal = null;
  if (mint && config.autoStrategy?.fetchIndicators !== false) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, {
        interval: config.autoStrategy?.indicatorInterval ?? "15_MINUTE",
        candles: config.indicators.candles ?? 298,
        rsiLength: config.indicators.rsiLength ?? 2,
      });
      signal = buildSignalSummary(payload);
    } catch (e) {
      log("position_router", `Indicator fetch failed for ${mint.slice(0, 8)}: ${e.message}`);
    }
  }

  let priceChange1h = pool.price_change_1h;
  if (priceChange1h == null && mint) {
    try {
      const ti = await getTokenInfo({ query: mint });
      priceChange1h = ti?.stats_1h?.price_change ?? null;
    } catch { /* optional enrichment */ }
  }

  return buildRebalancePlan({ pool, position, tracked, signal, priceChange1h });
}
