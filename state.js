/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { atomicWriteFileSync } from "./utils/atomic-write.js";
import { calculateIlConcentrated } from "./utils/impermanent-loss.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_CLOSED_OUTCOMES = 1000; // machine-readable outcome history for lp-outcome analysis; capped so state.json can't grow unbounded
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], closedOutcomes: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  tge = false,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    tge: tge === true,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Compact, machine-readable close record for lp-outcome analysis (Fase 2
 * bot learning). pnl_pct is best-effort from the last tracked tick (pos.pnl_pct,
 * falling back to peak_pnl_pct) since no call site threads a definitive
 * close-time PnL through recordClose/syncOpenPositions today.
 */
function buildClosedOutcome(pos, reason, overrides = {}) {
  return {
    position: pos.position,
    pool: pos.pool,
    pool_name: pos.pool_name || null,
    strategy: pos.strategy || null,
    // Prefer the caller's authoritative, fully-settled PnL (close.js computes
    // this from the Meteora closed-positions API / wallet-delta fallback,
    // AFTER the tx confirms) over pos.pnl_pct — the last live-tick value,
    // which can be a phantom RPC spike shortly after deploy (see pnlWarmupMinutes)
    // and previously leaked into closedOutcomes[] uncorrected (2026-07-12 incident:
    // a 16s-held position recorded pnl_pct=973.74% from exactly this).
    pnl_pct: overrides.pnl_pct ?? pos.pnl_pct ?? pos.peak_pnl_pct ?? null,
    il_pct: pos.il_pct ?? null,
    fee_vs_il_gap_pct: pos.fee_vs_il_gap_pct ?? null,
    entry_mcap: pos.entry_mcap ?? null,
    entry_tvl: pos.entry_tvl ?? null,
    entry_volume: pos.entry_volume ?? null,
    entry_holders: pos.entry_holders ?? null,
    organic_score: pos.organic_score ?? null,
    fee_tvl_ratio: pos.fee_tvl_ratio ?? null,
    initial_fee_tvl_24h: pos.initial_fee_tvl_24h ?? null,
    volatility: pos.volatility ?? null,
    amount_sol: pos.amount_sol ?? null,
    deployed_at: pos.deployed_at || null,
    closed_at: pos.closed_at || new Date().toISOString(),
    close_reason: reason || "unknown",
    total_fees_claimed_usd: pos.total_fees_claimed_usd ?? null,
  };
}

/** Append to the bounded closedOutcomes[] history. Dedupes by position id so
 *  recordClose + syncOpenPositions (or double close calls) can't double-count
 *  the same position in learning stats.
 */
function pushClosedOutcome(state, pos, reason, overrides = {}) {
  if (!state.closedOutcomes) state.closedOutcomes = [];
  const posId = pos?.position;
  if (posId && state.closedOutcomes.some((o) => o && o.position === posId)) {
    log("state", `closedOutcomes dedupe: skip second outcome for ${String(posId).slice(0, 8)}… (${reason})`);
    return;
  }
  state.closedOutcomes.push(buildClosedOutcome(pos, reason, overrides));
  if (state.closedOutcomes.length > MAX_CLOSED_OUTCOMES) {
    state.closedOutcomes = state.closedOutcomes.slice(-MAX_CLOSED_OUTCOMES);
  }
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed. Idempotent — second call is a no-op (no double outcomes).
 * @param {object} [overrides] - optional authoritative final numbers (currently
 *   just { pnl_pct }) computed by the caller AFTER on-chain settlement — pass
 *   these when available so closedOutcomes[] never relies on a possibly-stale
 *   live-tick pos.pnl_pct. Omit for the external-close / no-settled-data path.
 */
export function recordClose(position_address, reason, overrides = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.closed) {
    log("state", `Position ${position_address} already closed — skip duplicate recordClose (${reason})`);
    return;
  }
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  pushClosedOutcome(state, pos, reason, overrides);
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
/**
 * PnL warmup window: right after a deploy (or a rebalance — new/changed
 * deposits) the RPC PnL computation can return garbage spikes while deposits
 * settle (FABLE: +74% phantom 5s after deploy → trailing TP fired → closed at
 * 0% real). During warmup, PnL-driven *profit* signals are untrusted: peaks
 * aren't raised, trailing can't arm, take-profit can't fire. Stop loss stays
 * live — missing a real instant rug is worse than a spurious 0% close.
 */
export function isInPnlWarmup(pos, warmupMinutes, nowMs = Date.now()) {
  const warmup = Number(warmupMinutes);
  if (!Number.isFinite(warmup) || warmup <= 0) return false;
  if (!pos) return false;
  const refs = [pos.deployed_at, pos.last_rebalance_at]
    .map((t) => (t ? new Date(t).getTime() : NaN))
    .filter(Number.isFinite);
  if (refs.length === 0) return false;
  return nowMs - Math.max(...refs) < warmup * 60_000;
}

/**
 * Whether deterministic take-profit may fire this tick.
 * Stop loss / OOR / low-yield are unaffected. Blocks:
 * - PnL warmup window (phantom spikes right after deploy/rebalance)
 * - minAgeBeforeTakeProfit (deposits still settling)
 * - reported-vs-derived divergence during the early window (sultan: +50% phantom → 0.1% real)
 */
export function canFireTakeProfit(position = {}, tracked, mgmtConfig = {}) {
  if (isInPnlWarmup(tracked, mgmtConfig.pnlWarmupMinutes)) return false;
  const minAge = Number(mgmtConfig.minAgeBeforeTakeProfit ?? mgmtConfig.pnlWarmupMinutes ?? 10);
  const age = position.age_minutes;
  if (Number.isFinite(minAge) && minAge > 0 && age != null && age < minAge) return false;
  const earlyWindow = Math.max(
    Number(mgmtConfig.pnlWarmupMinutes) || 0,
    Number.isFinite(minAge) ? minAge : 0,
  );
  const maxDiff = Number(mgmtConfig.pnlSanityMaxDiffPct ?? 5);
  const diff = position.pnl_pct_diff;
  if (earlyWindow > 0 && age != null && age < earlyWindow && Number.isFinite(diff) && diff > maxDiff) {
    return false;
  }
  return true;
}

export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2, warmupMinutes = 0) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  // Warmup: don't stage or raise peaks from untrusted early ticks.
  if (isInPnlWarmup(pos, warmupMinutes)) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Link a recovery child position to its parent (Recovery Strat). Marks the
 * parent so it isn't re-proposed for recovery again, and the child so it's
 * never itself treated as a recovery candidate (no recovery-of-recovery chains).
 */
export function linkRecoveryPosition(parentPositionAddress, childPositionAddress) {
  const state = load();
  const parent = state.positions[parentPositionAddress];
  const child = state.positions[childPositionAddress];
  if (parent) parent.recovery_child = childPositionAddress;
  if (child) child.recovery_of = parentPositionAddress;
  save(state);
  log("state", `Linked recovery position ${childPositionAddress} to parent ${parentPositionAddress}`);
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

// ─── Impermanent-loss tracking ─────────────────────────────────

// DLMM bin price = (1 + bin_step/10000)^binId — same curve as the SDK's
// getPriceOfBinByBinId. Only price *ratios* feed the IL formula, so token
// decimal scaling cancels out and no on-chain read is needed.
function binPrice(binId, binStep) {
  return Math.pow(1 + binStep / 10000, binId);
}

/**
 * Theoretical price-only IL for a tracked position, plus the gap to real PnL.
 * il_pct is negative (loss vs holding the entry bundle). fee_vs_il_gap_pct =
 * pnl_pct - il_pct ≈ how much fee income (and directional move) is offsetting
 * the IL — same convention as debug_il.js.
 * @param {object} tracked - state entry: bin_step, active_bin_at_deploy
 * @param {object} positionData - live fields: active_bin, lower_bin, upper_bin, pnl_pct
 * Returns { il_pct, fee_vs_il_gap_pct } (2-decimal) or null when bin data is missing.
 */
export function computeIlMetrics(tracked, positionData = {}) {
  const binStep = Number(tracked?.bin_step);
  const entryBin = tracked?.active_bin_at_deploy;
  const { active_bin, lower_bin, upper_bin, pnl_pct } = positionData;
  if (!Number.isFinite(binStep) || binStep <= 0) return null;
  if (entryBin == null || active_bin == null || lower_bin == null || upper_bin == null) return null;

  const il = calculateIlConcentrated(
    binPrice(entryBin, binStep),
    binPrice(active_bin, binStep),
    binPrice(lower_bin, binStep),
    binPrice(upper_bin, binStep),
  );
  if (il == null) return null;

  const il_pct = Math.round(il * 10000) / 100;
  const pnl = Number(pnl_pct);
  const fee_vs_il_gap_pct = pnl_pct != null && Number.isFinite(pnl)
    ? Math.round((pnl - il_pct) * 100) / 100
    : null;
  return { il_pct, fee_vs_il_gap_pct };
}

/**
 * Opt-in IL-gap exit: fire when |IL| has outrun earned fees by more than
 * ilGapCloseThresholdPct (fee_vs_il_gap_pct < -threshold). Pure — used by
 * getDeterministicCloseRule in index.js. Returns { il_pct, gap_pct, reason } or null.
 */
export function checkIlGapExit(tracked, positionData, mgmtConfig) {
  if (!mgmtConfig?.ilGapCloseEnabled) return null;
  if (positionData?.pnl_pct_suspicious) return null;
  const metrics = computeIlMetrics(tracked, positionData);
  if (metrics?.fee_vs_il_gap_pct == null) return null;
  const threshold = Number(mgmtConfig.ilGapCloseThresholdPct ?? 15);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  if (metrics.fee_vs_il_gap_pct >= -threshold) return null;
  return {
    il_pct: metrics.il_pct,
    gap_pct: metrics.fee_vs_il_gap_pct,
    reason: `IL gap: PnL trails IL by ${Math.abs(metrics.fee_vs_il_gap_pct).toFixed(1)}% (IL ${metrics.il_pct.toFixed(1)}%, threshold -${threshold}%)`,
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Real-time IL tracking (persisted so debug_il/cli/history can read it back)
  const ilMetrics = computeIlMetrics(pos, positionData);
  if (ilMetrics && (pos.il_pct !== ilMetrics.il_pct || pos.fee_vs_il_gap_pct !== ilMetrics.fee_vs_il_gap_pct)) {
    pos.il_pct = ilMetrics.il_pct;
    pos.fee_vs_il_gap_pct = ilMetrics.fee_vs_il_gap_pct;
    changed = true;
  }

  // Persist the last-known live PnL so recordClose/syncOpenPositions has a real
  // exit-time value for closedOutcomes[] instead of falling back to peak_pnl_pct
  // (which would misrepresent a stop-loss exit as a profit).
  // Phantom-spike guard (2026-07-12 incident): a garbage RPC tick shortly after
  // deploy/rebalance can report an absurd POSITIVE pnl_pct (observed: 973.74%
  // on a position held 16s) — pnlWarmupMinutes already protects peak-raising/
  // trailing/take-profit from this, but this raw field wasn't guarded and the
  // phantom value leaked into closedOutcomes[] via recordClose. Suppress only
  // positive spikes during warmup; a real negative (stop-loss) must still pass
  // through unconditionally — "stop loss stays live" during warmup is the
  // existing, intentional design (missing a real instant rug is worse than a
  // spurious 0% close).
  const suppressPhantomGain = currentPnlPct > 0 && isInPnlWarmup(pos, mgmtConfig.pnlWarmupMinutes);
  if (!pnl_pct_suspicious && !suppressPhantomGain && Number.isFinite(currentPnlPct) && pos.pnl_pct !== currentPnlPct) {
    pos.pnl_pct = currentPnlPct;
    changed = true;
  }

  // Activate trailing TP once trigger threshold is reached (never during PnL warmup)
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && !isInPnlWarmup(pos, mgmtConfig.pnlWarmupMinutes) && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Partial Take-Profit (DCA-out) ─────────────────────────────

const PARTIAL_TP_RETRY_COOLDOWN_MS = 10 * 60_000;

/**
 * Pure check: should this position take a one-time partial profit (DCA-out)?
 * Fires at most once per position — removes partialTpClosePct% of liquidity while
 * the position account stays open under the existing SL/trailing management.
 * Requires the CONFIRMED peak (confirmPeak ticks) at/above the trigger too, so a
 * single noisy PnL tick can't fire it.
 * @param {object} pos - tracked position from state (getTrackedPosition)
 * @param {object} positionData - live fields from getMyPositions: pnl_pct, pnl_pct_suspicious, in_range, total_value_usd
 * @param {object} mgmtConfig
 * Returns { close_pct, reason } or null.
 */
export function shouldPartialTakeProfit(pos, positionData, mgmtConfig) {
  if (!mgmtConfig?.partialTpEnabled) return null;
  if (!pos || pos.closed || pos.partial_tp_done) return null;
  const { pnl_pct, pnl_pct_suspicious, in_range, total_value_usd } = positionData || {};
  if (pnl_pct_suspicious || pnl_pct == null) return null;
  if (in_range === false) return null; // OOR — the OOR/trailing exit rules own this position
  const trigger = mgmtConfig.partialTpTriggerPct ?? 5;
  if (pnl_pct < trigger || (pos.peak_pnl_pct ?? 0) < trigger) return null;
  const closePct = Math.min(Math.max(Number(mgmtConfig.partialTpClosePct ?? 50), 1), 99);
  const minRemain = mgmtConfig.partialTpMinRemainUsd ?? 10;
  const remainValue = (total_value_usd ?? 0) * (1 - closePct / 100);
  if (!(remainValue >= minRemain)) return null; // remainder too small to keep running
  // Back off after a failed attempt so a broken tx doesn't retry every poll tick
  if (pos.partial_tp_last_attempt_at && Date.now() - new Date(pos.partial_tp_last_attempt_at).getTime() < PARTIAL_TP_RETRY_COOLDOWN_MS) return null;
  return {
    close_pct: closePct,
    reason: `Partial TP: PnL ${pnl_pct.toFixed(2)}% >= ${trigger}% — removing ${closePct}% liquidity (remaining ~${remainValue.toFixed(2)})`,
  };
}

/**
 * Record a partial-TP attempt timestamp (retry backoff, set before sending txs).
 */
export function recordPartialTpAttempt(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.partial_tp_last_attempt_at = new Date().toISOString();
  save(state);
}

/**
 * Mark a position's one-time partial TP as done.
 */
export function markPartialTpDone(position_address, summary) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.partial_tp_done = true;
  pos.partial_tp_at = new Date().toISOString();
  pos.notes.push(`Partial TP at ${pos.partial_tp_at}: ${summary}`);
  pushEvent(state, { action: "partial_tp", position: position_address, pool_name: pos.pool_name || pos.pool, reason: summary });
  save(state);
  log("state", `Position ${position_address} partial TP done: ${summary}`);
}

// ─── Rebalance tracking ────────────────────────────────────────

/**
 * Stamp a rebalance attempt (success or failure) — drives the cooldown so a
 * failing rebalance can't be retried every poller tick.
 */
export function recordRebalanceAttempt(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_rebalance_attempt_at = new Date().toISOString();
  save(state);
}

/**
 * Record a completed rebalance. When the position account had to be migrated
 * (new range outside the old account's bin allocation), `new_position`
 * re-keys the tracked entry so management keeps following the live account.
 */
export function recordRebalance(position_address, { plan, tx_hashes = [], new_position = null } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return null;

  pos.rebalance_count = (pos.rebalance_count || 0) + 1;
  pos.last_rebalance_at = new Date().toISOString();
  pos.last_rebalance_attempt_at = pos.last_rebalance_at;
  if (plan?.strategy) pos.strategy = plan.strategy;
  if (plan) {
    pos.bin_range = {
      min: plan.min_bin ?? pos.bin_range?.min,
      max: plan.max_bin ?? pos.bin_range?.max,
      bins_below: plan.bins_below ?? pos.bin_range?.bins_below,
      bins_above: plan.bins_above ?? pos.bin_range?.bins_above,
    };
    pos.market_view_last = plan.market_view ?? pos.market_view_last ?? null;
  }
  // Fresh range at the fresh active bin — OOR clock restarts
  pos.out_of_range_since = null;
  pos.notes.push(`Rebalanced (${plan?.rebalance_type || "?"}) at ${pos.last_rebalance_at}: ${sanitizeStoredText(plan?.reason) || "no reason"}`);

  if (new_position && new_position !== position_address) {
    // Migrate the tracked entry to the new account, keep history on the entry
    const migrated = { ...pos, position: new_position };
    state.positions[new_position] = migrated;
    delete state.positions[position_address];
    pushEvent(state, { action: "rebalance", position: new_position, pool_name: pos.pool_name || pos.pool, reason: `migrated from ${position_address.slice(0, 8)} (${plan?.rebalance_type || "?"})` });
    save(state);
    log("state", `Position ${position_address} rebalanced → migrated to ${new_position} (count ${migrated.rebalance_count})`);
    return migrated;
  }

  pushEvent(state, { action: "rebalance", position: position_address, pool_name: pos.pool_name || pos.pool, reason: plan?.rebalance_type || "rebalance" });
  save(state);
  log("state", `Position ${position_address} rebalanced in place (count ${pos.rebalance_count})`);
  return pos;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 * Returns a snapshot of the positions it just auto-closed so the caller can
 * record the external close (final PnL, decision log, pool memory). Positions
 * closed through the normal close path never appear here — recordClose already
 * set `closed` with a proper reason before the next sync runs.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

// Positions with an in-flight close_position tx (our own tool). During the
// ~5-10s an on-chain close takes, the position is already gone on-chain but
// recordClose hasn't marked it closed yet — without this guard syncOpenPositions
// would flag it as an EXTERNAL close and fire a SECOND notifyClose card on top of
// the one executor.js sends when the tool returns (double Telegram notification).
// executor.js marks/unmarks around the close_position fn call.
const _closingInFlight = new Set();
export function markPositionClosing(posId) { if (posId) _closingInFlight.add(posId); }
export function unmarkPositionClosing(posId) { if (posId) _closingInFlight.delete(posId); }

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;
  const externallyClosed = [];

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;
    // Our own close_position tx is settling — let the tool path record + notify it,
    // don't double-fire an external-close notification for the same position.
    if (_closingInFlight.has(posId)) {
      log("state", `Position ${posId} missing on-chain but close in flight — deferring to tool close (no external-close)`);
      continue;
    }

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
    pushClosedOutcome(state, pos, "external_close_sync_missing");
    externallyClosed.push({
      position: posId,
      pool: pos.pool || null,
      pool_name: pos.pool_name || null,
      strategy: pos.strategy || null,
      volatility: pos.volatility ?? null,
      il_pct: pos.il_pct ?? null,
      amount_sol: pos.amount_sol ?? null,
      deployed_at: pos.deployed_at || null,
      closed_at: pos.closed_at,
      total_fees_claimed_usd: pos.total_fees_claimed_usd || 0,
    });
  }

  if (changed) save(state);
  return externallyClosed;
}
