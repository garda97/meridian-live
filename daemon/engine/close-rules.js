import { log } from "../../logger.js";
import { config } from "../../config.js";
import { getTrackedPosition, canFireTakeProfit, checkIlGapExit } from "../../state.js";

/**
 * Daemon-side deterministic close rules 1-7 (SL, TP, pumped-above, OOR,
 * low yield, TGE max-hold, IL gap). NOTE: tools/dlmm/rules.js exports a
 * DIFFERENT function with the same name (the generic ruleset used by the
 * executor/tests) — this one is the daemon's authoritative version and is
 * intentionally NOT exported.
 */
export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct >= managementConfig.takeProfitPct &&
    canFireTakeProfit(position, tracked, managementConfig)
  ) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  // TGE play max-hold clock: launch positions are a 2-8h fee harvest, not a
  // hold — close on schedule regardless of PnL (SL/trailing still fire earlier).
  const tgeMaxHoldHours = Number(config.autoStrategy?.tgeMaxHoldHours ?? 8);
  if (
    tracked?.tge === true &&
    Number.isFinite(tgeMaxHoldHours) && tgeMaxHoldHours > 0 &&
    (position.age_minutes ?? 0) >= tgeMaxHoldHours * 60
  ) {
    return { action: "CLOSE", rule: 6, reason: `TGE max hold ${tgeMaxHoldHours}h reached` };
  }
  // Rule 7 (opt-in, ilGapCloseEnabled): |IL| outran earned fees beyond the gap threshold.
  if (!pnlSuspect) {
    const ilExit = checkIlGapExit(tracked, position, managementConfig);
    if (ilExit) {
      return { action: "CLOSE", rule: 7, reason: ilExit.reason };
    }
  }
  return null;
}
