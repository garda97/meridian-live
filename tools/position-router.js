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
import { log } from "../logger.js";
import {
  classifyMarketView,
  buildDeployPlan,
  computeOorRisk,
} from "./strategy-router.js";
import { buildSignalSummary, fetchChartIndicatorsForMint } from "./chart-indicators.js";
import { getPoolDetail } from "./screening.js";
import { getTokenInfo } from "./token.js";

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
    if (view === "breakdown" && classification.confidence === "high" && volumeAlive) {
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
  } else {
    plan = mk({ action: "hold", reason: "Position bin data unavailable — hold" });
  }

  // Entry gates from the base plan also veto a rebalance re-entry (e.g. RSI
  // extended on pump) — holding is cheaper than re-anchoring into a bad entry.
  if (plan.action === "rebalance" && base.entry_allowed === false) {
    plan = { ...plan, action: "hold", rebalance_type: null, reason: `Re-entry blocked: ${base.entry_reason}` };
  }

  // Same OOR-risk gate as entry: if the NEW range would likely break before
  // fees cover the cycle, close instead of churning rebalances.
  if (plan.action === "rebalance") {
    const totalBins = (plan.bins_below || 0) + (plan.bins_above || 0);
    plan.upside_cover_pct = totalBins > 0 ? Math.round(((plan.bins_above || 0) / totalBins) * 1000) / 10 : 0;
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

  return plan;
}

/**
 * Operational gates on top of the plan. Pure.
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

  const lastAt = tracked?.last_rebalance_attempt_at || tracked?.last_rebalance_at;
  const cooldownMin = Number(mgmt.rebalanceCooldownMinutes ?? 15);
  if (lastAt && cooldownMin > 0) {
    const elapsedMin = (nowMs - new Date(lastAt).getTime()) / 60000;
    if (elapsedMin < cooldownMin) {
      return hold(`rebalance cooldown ${elapsedMin.toFixed(1)}/${cooldownMin}m`);
    }
  }

  // OOR rebalances wait a short confirmation window (price may snap back);
  // in-range conversions (strategy drift) have no OOR clock to respect.
  if (plan.oor_direction === "up" || plan.oor_direction === "down") {
    const oorMin = Number(mgmt.rebalanceMinOorMinutes ?? 5);
    const oorFor = Number(position?.minutes_out_of_range ?? 0);
    if (oorFor < oorMin) return hold(`OOR ${oorFor}m < rebalanceMinOorMinutes ${oorMin}m — wait`);
  }

  return { action: "rebalance", reason: plan.reason, plan };
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

  const lastAt = tracked.last_rebalance_attempt_at || tracked.last_rebalance_at;
  const cooldownMin = Number(mgmt.rebalanceCooldownMinutes ?? 15);
  if (lastAt && cooldownMin > 0 && (nowMs - new Date(lastAt).getTime()) / 60000 < cooldownMin) return false;

  const dir = classifyOorDirection(position);
  if (dir === "up" || dir === "down") {
    return Number(position?.minutes_out_of_range ?? 0) >= Number(mgmt.rebalanceMinOorMinutes ?? 5);
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
