import { log } from "../../logger.js";
import { config, MIN_SAFE_BINS_BELOW } from "../../config.js";
import { isWithinDeployWindow } from "../../utils/deploy-window.js";
import { executeTool } from "../../tools/executor.js";
import { appendDecision, getRecentDecisions } from "../../decision-log.js";
import { checkDailyLossGate } from "../../utils/daily-loss.js";
import { getTrackedPosition, linkRecoveryPosition } from "../../state.js";

/**
 * Recovery Strat (notes/RECOVERY_SPEC.md): when a position drops OUT OF RANGE
 * to the LOWER side (price fell below its bin range), optionally open a second
 * bid_ask position BELOW the original range to compound fees while price sits
 * lower. Off by default (config.management.autoRecovery). Deterministic —
 * no LLM — and reuses the daemon's guarded deploy path (executeTool
 * deploy_position) so amount limits, bin_step, maxPositions, and pool/token
 * cooldown all apply. The duplicate-pool/duplicate-mint guard is bypassed
 * only for this internal actor since opening a second position in the same
 * pool is the entire point.
 *
 * bid_ask deploys always pin the upper bin to the CURRENT active bin (SDK
 * constraint), so bins_below is computed from live active_bin to land the
 * LOWER edge at the same floor the spec targets (orig_min - autoRecoveryBinsBelow),
 * rather than pinning the upper edge at orig_min (not achievable for bid_ask).
 */
/**
 * Pure filter: which positions are OOR to the LOWER side (recovery candidates)?
 * No I/O — exported for unit testing (test/test-recovery-strat.js).
 */
export function filterRecoveryCandidates(positionData) {
  return positionData.filter((p) =>
    (p.minutes_out_of_range ?? 0) > 0 &&
    p.active_bin != null &&
    p.lower_bin != null &&
    p.active_bin < p.lower_bin // OOR to the LOWER side only
  );
}

/**
 * Pure bin-math: how many bins below the CURRENT active bin should the recovery
 * position span so its lower edge lands at (origMin - binsBelowTarget)? Clamped
 * to never go narrower than minBinsBelow (deploy_position's own safety floor).
 *
 * Bounded by construction: since candidates are only OOR-below (activeBin < origMin,
 * i.e. depth d = origMin - activeBin > 0), the raw value is (binsBelowTarget - d),
 * which is always < binsBelowTarget and shrinks toward the minBinsBelow floor as the
 * crash gets deeper — it can never grow past binsBelowTarget, let alone unbounded.
 * No I/O — exported for unit testing.
 */
export function computeRecoveryBinsBelow(activeBin, origMin, binsBelowTarget, configMinBinsBelow) {
  const targetFloorBin = origMin - binsBelowTarget;
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(configMinBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const binsBelow = Math.max(minBinsBelow, Math.round(activeBin - targetFloorBin));
  return { binsBelow, targetFloorBin, minBinsBelow };
}

export async function maybeAutoRecovery(positionData) {
  if (!config.management.autoRecovery) return;

  const binsBelowTarget = Number(config.management.autoRecoveryBinsBelow ?? 100);
  const candidates = filterRecoveryCandidates(positionData);
  if (candidates.length === 0) return;

  for (const p of candidates) {
    const tracked = getTrackedPosition(p.position);
    if (!tracked || tracked.closed) continue;
    if (tracked.recovery_child) continue; // already spawned a recovery for this parent
    if (tracked.recovery_of) continue; // this position IS a recovery child — no chaining

    const entryMcap = Number(tracked.entry_mcap ?? 0);
    const entryTvl = Number(tracked.entry_tvl ?? 0);
    if (!(entryMcap > 0 && entryTvl > 0)) {
      log("cron", `Recovery skipped for ${p.pair} — entry_mcap/entry_tvl not alive (total rug)`);
      continue;
    }

    // deploy_position does NOT check dailyLoss or the deploy-window — screening
    // enforces those before invoking the LLM, so recovery must check them itself.
    const dailyLoss = checkDailyLossGate({
      decisions: getRecentDecisions(100),
      limitUsd: config.management.dailyLossLimitUsd,
    });
    if (dailyLoss.blocked) {
      log("cron", `Recovery skipped for ${p.pair} — daily loss gate blocked`);
      appendDecision({
        type: "skip",
        actor: "RECOVERY",
        summary: "Recovery deploy skipped",
        reason: "daily_loss_gate",
        position: p.position,
        pool: p.pool,
      });
      continue;
    }

    const deployWindow = isWithinDeployWindow(new Date().getHours(), {
      afterHour: config.schedule.noDeployAfterHour,
      beforeHour: config.schedule.noDeployBeforeHour,
    });
    if (!deployWindow.allowed) {
      log("cron", `Recovery skipped for ${p.pair} — time gate (${deployWindow.reason})`);
      continue;
    }

    const origMin = tracked.bin_range?.min ?? p.lower_bin;
    const { binsBelow, targetFloorBin } = computeRecoveryBinsBelow(p.active_bin, origMin, binsBelowTarget, config.strategy.minBinsBelow);

    log("cron", `Recovery candidate: ${p.pair} OOR-below since ${tracked.out_of_range_since} — deploying bid_ask recovery (bins_below=${binsBelow}, target floor bin ${targetFloorBin}, orig_min ${origMin})`);

    const res = await executeTool("deploy_position", {
      pool_address: p.pool,
      pool_name: p.pair,
      base_mint: p.base_mint,
      amount_y: config.management.deployAmountSol,
      strategy: "bid_ask",
      bins_below: binsBelow,
      bins_above: 0,
      entry_mcap: tracked.entry_mcap,
      entry_tvl: tracked.entry_tvl,
    }, { actor: "RECOVERY" }).catch((e) => ({ error: e.message }));

    const ok = res?.success !== false && !res?.error && !res?.blocked && !res?.dry_run;
    if (res?.dry_run) {
      log("cron", `Recovery DRY RUN for ${p.pair}: would deploy ${JSON.stringify(res.would_deploy)}`);
      appendDecision({
        type: "deploy",
        actor: "RECOVERY",
        summary: `DRY RUN recovery deploy for ${p.pair}`,
        reason: `Parent ${p.position} OOR-below since ${tracked.out_of_range_since}`,
        pool: p.pool,
        pool_name: p.pair,
        metrics: { dry_run: true, parent_position: p.position, bins_below: binsBelow, orig_min: origMin, target_floor_bin: targetFloorBin },
      });
      continue;
    }
    if (!ok) {
      log("cron", `Recovery deploy FAILED for ${p.pair}: ${res?.error || res?.reason || "unknown"}`);
      appendDecision({
        type: "skip",
        actor: "RECOVERY",
        summary: "Recovery deploy failed",
        reason: res?.error || res?.reason || "unknown",
        position: p.position,
        pool: p.pool,
      });
      continue;
    }

    linkRecoveryPosition(p.position, res.position);
    appendDecision({
      type: "deploy",
      actor: "RECOVERY",
      summary: `Recovery position deployed below ${p.pair}`,
      reason: `Parent ${p.position} OOR-below since ${tracked.out_of_range_since}`,
      pool: p.pool,
      pool_name: p.pair,
      position: res.position,
      metrics: { parent_position: p.position, bins_below: binsBelow, orig_min: origMin, target_floor_bin: targetFloorBin },
    });
  }
}
