/**
 * The autonomous engine: management + screening cycles, deterministic close
 * rules, recovery strat, cron schedules, and the fast PnL / opportunity
 * pollers. Everything that acts WITHOUT a human lives here; the Telegram
 * handler and REPL only trigger it.
 *
 * Busy flags are module-private — external callers use isEngineBusy().
 */
import cron from "node-cron";
import { agentLoop } from "../agent.js";
import { log } from "../logger.js";
import { getMyPositions, partialClosePosition, rebalancePosition, getActiveBin } from "../tools/dlmm.js";
import { isRebalanceCandidate, resolveRebalancePlanForPosition, shouldRebalance, computeTvlDilution, checkTvlDilutionExit } from "../tools/position-router.js";
import { getWalletBalances } from "../tools/wallet.js";
import { checkSolRegimeGate } from "../tools/sol-regime.js";
import { isWithinDeployWindow } from "../utils/deploy-window.js";
import { getTopCandidates, degenScore, estimateSharePct, getPoolDetail } from "../tools/screening.js";
import { checkPositionChartExit } from "../tools/chart-indicators.js";
import { config, reloadUserConfigFromDisk, computeDeployAmount, minTokenFeesSolForMcap, MIN_SAFE_BINS_BELOW } from "../config.js";
import { canTriggerScreening, checkScreeningDeployGate } from "../utils/screening-gate.js";
import { observeOpenPosition } from "../lessons.js";
import { recordScreeningOutcome } from "../filter-autotune.js";
import { executeTool, registerCronRestarter, swapBaseToSolWithRetry } from "../tools/executor.js";
import {
  sendMessage,
  sendHTML,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "../telegram.js";
import {
  TG,
  TG_TITLES,
  localizeTelegramReport,
  formatNoCandidatesReport,
  formatNoDeployReport,
} from "../utils/telegram-id.js";
import { generateBriefing } from "../briefing.js";
import {
  getLastBriefingDate,
  setLastBriefingDate,
  getTrackedPosition,
  getTrackedPositions,
  updatePnlAndCheckExits,
  confirmPeak,
  registerExitSignal,
  shouldPartialTakeProfit,
  canFireTakeProfit,
  linkRecoveryPosition,
  checkIlGapExit,
} from "../state.js";
import { getActiveStrategy } from "../strategy-library.js";
import { recordPositionSnapshot, recallForPool } from "../pool-memory.js";
import { checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "../tools/token.js";
import { getGmgnTokenTopHolders, computeHolderRatios } from "../tools/gmgn.js";
import { stageSignals } from "../signal-tracker.js";
import { resolveDeployPlansForCandidates, formatDeployPlanBlock } from "../tools/strategy-router.js";
import { getWeightsSummary } from "../signal-weights.js";
import { appendDecision, enrichDecisionEntry, getRecentDecisions } from "../decision-log.js";
import { checkDailyLossGate } from "../utils/daily-loss.js";
import { timers, stripThink, sanitizeUntrustedPromptText } from "./runtime.js";

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _cronStarted = false;
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
// Exit/peak confirmation is done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** True while a management or screening cycle holds the engine. */
export function isEngineBusy() {
  return _managementBusy || _screeningBusy;
}

export function isCronStarted() {
  return _cronStarted;
}

/**
 * Start the autonomous cycles once: seeds the countdown timers and flips the
 * started flag that the cron-restarter (interval config changes) checks.
 * Returns true when this call actually started them, false if already running.
 */
export function ensureCronStarted() {
  if (_cronStarted) return false;
  _cronStarted = true;
  timers.managementLastRun = Date.now();
  timers.screeningLastRun = Date.now();
  startCronJobs();
  return true;
}

export function pauseCronJobs() {
  stopCronJobs();
  _cronStarted = false;
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
export async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

export function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  _cronTasks = [];
}

/**
 * POWER MODE: cheap-gate, resolve, and decide a rebalance for one position.
 * Returns an actionMap-shaped entry: REBALANCE (with plan), CLOSE (downgrade:
 * dead volume / max count / deep PnL / risky re-plan), or null (hold — fall
 * through to the existing deterministic rules).
 */
async function maybeResolveRebalance(p) {
  const tracked = getTrackedPosition(p.position);
  if (!isRebalanceCandidate({ position: p, tracked })) return null;
  const plan = await resolveRebalancePlanForPosition({ position: p, tracked }).catch((e) => {
    log("cron_error", `Rebalance plan resolution failed for ${p.pair}: ${e.message}`);
    return null;
  });
  if (!plan) return null;
  const decision = shouldRebalance({ plan, position: p, tracked });
  if (decision.action === "rebalance") return { action: "REBALANCE", plan, reason: decision.reason };
  if (decision.action === "close") return { action: "CLOSE", rule: "rebalance", reason: decision.reason };
  return null;
}

/**
 * Execute the actions decided by the deterministic rules. CLOSE/CLAIM run directly
 * via executeTool (no LLM) — preserving all post-effects (notify, auto-swap,
 * recordPerformance, decision-log, HiveMind). Only INSTRUCTION positions, whose
 * free-text condition JS can't parse, are handed to the MANAGER LLM. Returns a
 * one-line-per-position result string.
 */
async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
  const lines = [];
  const instructionPositions = [];

  const mechanical = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");
  if (mechanical.length) {
    log("cron", `Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (act.action === "INSTRUCTION") { instructionPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      await liveMessage?.toolStart("close_position");
      const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok);
      lines.push(`${p.pair}: ${ok ? `closed (${reason})` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "REBALANCE") {
      await liveMessage?.toolStart("rebalance_position");
      const res = await rebalancePosition({ position_address: p.position, plan: act.plan, reason: act.reason }).catch(e => ({ error: e.message }));
      const ok = res?.success === true;
      await liveMessage?.toolFinish("rebalance_position", res, ok);
      lines.push(`${p.pair}: ${ok
        ? `rebalanced (${act.plan?.rebalance_type}, ${res.rebalance_path}) → bins ${res.bin_range?.min}→${res.bin_range?.max}`
        : res?.blocked
          ? `rebalance SKIPPED — ${res?.error || "blocked"}`
          : `rebalance FAILED — ${res?.error || "unknown"}${res?.position_closed ? " (position closed, funds in wallet)" : ""}`}`);
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  // INSTRUCTION positions need the LLM to evaluate the free-text condition.
  if (instructionPositions.length > 0) {
    log("cron", `Management: ${instructionPositions.length} instruction position(s) — invoking LLM [model: ${config.llm.managementModel}]`);
    const actionBlocks = instructionPositions.map((p) => [
      `POSITION: ${p.pair} (${p.position})`,
      `  pool: ${p.pool}`,
      `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
      `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
      `  instruction: "${p.instruction}"`,
    ].join("\n")).join("\n\n");

    const { content } = await agentLoop(`
INSTRUCTION EVALUATION — ${instructionPositions.length} position(s)

${actionBlocks}

For each position, evaluate the instruction condition against the live data:
- If the condition is MET → call close_position (it claims fees internally; do NOT call claim_fees first).
- If NOT met → HOLD, do nothing.

After evaluating, write a brief one-line result per position.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}

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

async function maybeAutoRecovery(positionData) {
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

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    reloadUserConfigFromDisk();
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage(TG_TITLES.management, TG_TITLES.managementEval);
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      const trigger = canTriggerScreening(config);
      if (!trigger.ok) {
        log("cron", `No open positions — screening not triggered (${trigger.reason})`);
        mgmtReport = `Tidak ada posisi terbuka. Screening dijeda: ${trigger.reason}.`;
        return mgmtReport;
      }
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "Tidak ada posisi terbuka. Memulai siklus screening.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory. Dilution context (share of live pool TVL +
    // TVL growth since entry) rides along: one pool-detail fetch per position
    // per cycle, fail-soft to nulls — trend accumulates in pool-memory even
    // while the shareExit rule itself is off.
    const positionData = await Promise.all(positions.map(async (p) => {
      let dilution = { position_share_pct: null, tvl_growth_x: null };
      try {
        const detail = await getPoolDetail({ pool_address: p.pool, timeframe: config.screening?.timeframe || "5m" });
        dilution = computeTvlDilution({
          positionValueUsd: p.total_value_usd,
          poolTvlUsd: detail?.tvl ?? detail?.active_tvl,
          entryTvlUsd: getTrackedPosition(p.position)?.entry_tvl,
        });
      } catch (e) {
        log("cron", `Dilution fetch failed for ${p.pair}: ${e.message}`);
      }
      const enriched = { ...p, ...dilution };
      recordPositionSnapshot(p.pool, enriched);
      return { ...enriched, recall: recallForPool(p.pool) };
    }));

    // JS exit checks. Management is the slow cron backstop: raise peak immediately
    // (confirmTicks=1) and act on detected exits directly. Real-time 2-tick
    // confirmation lives in the fast 3s poller below.
    const exitMap = new Map();
    await Promise.all(positionData.map(async (p) => {
      confirmPeak(p.position, p.pnl_pct, 1, config.management.pnlWarmupMinutes);
      let exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (!exit) {
        exit = await checkPositionChartExit(p).catch(() => null);
      }
      if (!exit) {
        exit = checkTvlDilutionExit(
          { position_share_pct: p.position_share_pct, tvl_growth_x: p.tvl_growth_x },
          p,
          config.management,
        );
      }
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }));

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // ── Self-learning: observe every open position each cycle (telemetry only) ──
      observeOpenPosition({
        position: p.position,
        pool: p.pool,
        pool_name: p.pair,
        strategy: p.strategy,
        amount_sol: p.amount_sol,
        pnl_pct: p.pnl_pct,
        in_range: p.in_range,
        minutes_out_of_range: p.minutes_out_of_range,
        age_minutes: p.age_minutes,
        total_value_usd: p.total_value_usd,
        unclaimed_fees_usd: p.unclaimed_fees_usd,
        fee_per_tvl_24h: p.fee_per_tvl_24h,
        volatility: p.volatility,
        fee_tvl_ratio: p.fee_tvl_ratio,
        organic_score: p.organic_score,
      });
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // POWER MODE: re-analyze + reposition BEFORE the OOR close rule gets a
      // chance to burn the position. Hold falls through to the rules below.
      if (config.management.autoRebalanceEnabled !== false) {
        const reb = await maybeResolveRebalance(p);
        if (reb) {
          actionMap.set(p.position, reb);
          continue;
        }
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      const execReport = await executeManagementActions(actionPositions, actionMap, { liveMessage, cur });
      if (execReport) mgmtReport += `\n\n${execReport}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // Recovery Strat — deterministic, no LLM. Off by default (config.management.autoRecovery).
    await maybeAutoRecovery(positionData).catch((e) => log("cron_error", `Recovery cycle failed: ${e.message}`));

    // Trigger screening after management
    reloadUserConfigFromDisk();
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    const postTrigger = canTriggerScreening(config);
    if (
      postTrigger.ok &&
      afterCount < config.risk.maxPositions &&
      Date.now() - _screeningLastTriggered > screeningCooldownMs
    ) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    } else if (!postTrigger.ok && afterCount === 0) {
      log("cron", `Post-management: screening not triggered (${postTrigger.reason})`);
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Siklus manajemen gagal: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        const mgmtOut = localizeTelegramReport(stripThink(mgmtReport));
        if (liveMessage) await liveMessage.finalize(mgmtOut).catch(() => {});
        else sendMessage(TG.managementCycle(mgmtOut)).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  let deploySucceeded = false;
  const outcome = { executed: false, deployed: false, skipped: false };

  try {
    reloadUserConfigFromDisk();
    // Hard guards — don't even run the agent if preconditions aren't met
    try {
      [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
      const deployGate = checkScreeningDeployGate({
        openCount: prePositions.total_positions,
        cfg: config,
      });
      if (!deployGate.allowed) {
        log("cron", `Screening skipped — ${deployGate.reason}`);
        screenReport = `Screening dilewati — ${deployGate.reason}.`;
        outcome.skipped = true;
        appendDecision({
          type: "skip",
          actor: "SCREENER",
          summary: "Screening skipped",
          reason: deployGate.reason,
        });
        return screenReport;
      }
      const minRequired = config.management.deployAmountSol + config.management.gasReserve;
      const isDryRun = process.env.DRY_RUN === "true";
      if (!isDryRun && preBalance.sol < minRequired) {
        log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
        screenReport = `Screening dilewati — SOL tidak cukup (${preBalance.sol.toFixed(3)} < ${minRequired} diperlukan untuk deploy + gas).`;
        outcome.skipped = true;
        appendDecision({
          type: "skip",
          actor: "SCREENER",
          summary: "Screening skipped",
          reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
        });
        return screenReport;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${e.message}`);
      screenReport = `Pre-check screening gagal: ${e.message}`;
      outcome.skipped = true;
      return screenReport;
    }

    const dailyLoss = checkDailyLossGate({
      decisions: getRecentDecisions(100),
      limitUsd: config.management.dailyLossLimitUsd,
    });
    if (dailyLoss.blocked) {
      const reason = `Daily loss gate: realized ${dailyLoss.realizedPnlUsd} USD today <= -${dailyLoss.limitUsd} USD limit`;
      log("cron", `Screening skipped — ${reason} (existing positions still managed)`);
      screenReport = `Screening dilewati — ${reason}. Deploy baru dijeda sampai tengah malam WIB.`;
      outcome.skipped = true;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: "daily_loss_gate",
        metrics: {
          realized_pnl_usd_today: dailyLoss.realizedPnlUsd,
          daily_loss_limit_usd: dailyLoss.limitUsd,
          day_start: dailyLoss.dayStartIso,
        },
      });
      return screenReport;
    }

    const deployWindow = isWithinDeployWindow(new Date().getHours(), {
      afterHour: config.schedule.noDeployAfterHour,
      beforeHour: config.schedule.noDeployBeforeHour,
    });
    if (!deployWindow.allowed) {
      const reason = `Time gate: ${deployWindow.reason} (server-local)`;
      log("cron", `Screening skipped — ${reason}`);
      screenReport = `Screening dilewati — ${reason}.`;
      outcome.skipped = true;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: "time_gate",
        metrics: {
          local_hour: new Date().getHours(),
          no_deploy_after_hour: config.schedule.noDeployAfterHour,
          no_deploy_before_hour: config.schedule.noDeployBeforeHour,
        },
      });
      return screenReport;
    }

    let btcPriceUsd = null;
    if (config.screening?.solRelativeStrengthEnabled) {
      const { getBtcPriceUsd } = await import("../tools/btc-price.js");
      btcPriceUsd = await getBtcPriceUsd();
    }
    const regime = checkSolRegimeGate(preBalance?.sol_price, { btcPriceUsd });
    if (regime.blocked) {
      const reason = `SOL regime gate: 1h change ${regime.changePct}% <= ${regime.thresholdPct}%`;
      log("cron", `Screening skipped — ${reason}`);
      screenReport = `Screening dilewati — ${reason}.`;
      outcome.skipped = true;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: "sol_regime_gate",
        metrics: {
          sol_change_1h_pct: regime.changePct,
          sol_threshold_pct: regime.thresholdPct,
          sol_price: regime.currentPrice,
          sol_price_1h_ago: regime.pastPrice,
        },
      });
      return screenReport;
    }

    outcome.executed = true;
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage(TG_TITLES.screening, TG_TITLES.screeningScan);
    }
    timers.screeningLastRun = Date.now();
    log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const deployStrategy = config.strategy.strategy;
    const strategyBlock = config.autoStrategy?.enabled
      ? `AUTO STRATEGY MODE: ON — each candidate has deploy_plan (bid_ask/spot/curve + bins from chart 15m + market view). Follow deploy_plan exactly. deposit: SOL only (amount_y, amount_x=0)`
        + (activeStrategy ? `\nSTRATEGY LIBRARY CONTEXT: ${activeStrategy.name} — ${activeStrategy.best_for}` : "")
      : `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
        + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      const gmgnTop10 = ti?.audit?.gmgn_top10_pct ?? ti?.gmgn_security?.top_10_holder_pct;
      const maxTop10Pct = config.screening.maxTop10Pct;
      // B — Spray mode: allow higher top10 concentration (up to sprayMaxTop10Pct)
      // for tokens that pass CPO (renounced+lp_burned+SM). CPO is the safety net.
      const top10Ceiling = (config.management?.sprayModeEnabled)
        ? Math.max(maxTop10Pct, config.management.sprayMaxTop10Pct ?? 70)
        : maxTop10Pct;
      if (gmgnTop10 != null && top10Ceiling != null && Number(gmgnTop10) > top10Ceiling) {
        log("screening", `GMGN top10 filter: dropped ${pool.name} — top10 ${gmgnTop10}% > ${maxTop10Pct}%`);
        filteredOut.push({ name: pool.name, reason: `GMGN top10 ${gmgnTop10}% > ${maxTop10Pct}%` });
        return false;
      }
      return true;
    });

    const gmgnHolderStatsByMint = new Map();
    for (const { pool, ti } of passing) {
      const mint = pool.base?.mint || ti?.mint;
      if (!mint) continue;
      const stats = await getGmgnTokenTopHolders(mint, { limit: 100 }).catch(() => null);
      if (stats) gmgnHolderStatsByMint.set(mint, stats);
    }

    const maxBundlerTop100Pct = config.gmgn?.maxBundlerTop100Pct;
    const maxFreshWalletHolderPct = config.gmgn?.maxFreshWalletHolderPct;
    const maxBundledWalletHolderPct = config.gmgn?.maxBundledWalletHolderPct;
    const passingAfterGmgn = passing.filter(({ pool, ti }) => {
      const mint = pool.base?.mint || ti?.mint;
      const stats = mint ? gmgnHolderStatsByMint.get(mint) : null;
      const bundlerPct = stats?.bundlers_pct_in_top_100;
      if (bundlerPct != null && maxBundlerTop100Pct != null && bundlerPct > maxBundlerTop100Pct) {
        log("screening", `GMGN bundler filter: dropped ${pool.name} — bundlers ${bundlerPct}% > ${maxBundlerTop100Pct}%`);
        filteredOut.push({ name: pool.name, reason: `GMGN bundlers ${bundlerPct}% > ${maxBundlerTop100Pct}%` });
        return false;
      }
      // Tagged-wallet ratios vs total holders (off unless configured)
      const ratios = computeHolderRatios(stats, ti?.holders ?? pool.base_token_holders);
      if (ratios.fresh_wallet_holder_pct != null && maxFreshWalletHolderPct != null && ratios.fresh_wallet_holder_pct > maxFreshWalletHolderPct) {
        log("screening", `GMGN fresh-wallet filter: dropped ${pool.name} — fresh ${ratios.fresh_wallet_holder_pct}% of holders > ${maxFreshWalletHolderPct}%`);
        filteredOut.push({ name: pool.name, reason: `GMGN fresh wallets ${ratios.fresh_wallet_holder_pct}% of holders > ${maxFreshWalletHolderPct}%` });
        return false;
      }
      if (ratios.bundled_wallet_holder_pct != null && maxBundledWalletHolderPct != null && ratios.bundled_wallet_holder_pct > maxBundledWalletHolderPct) {
        log("screening", `GMGN bundled-wallet filter: dropped ${pool.name} — bundled ${ratios.bundled_wallet_holder_pct}% of holders > ${maxBundledWalletHolderPct}%`);
        filteredOut.push({ name: pool.name, reason: `GMGN bundled wallets ${ratios.bundled_wallet_holder_pct}% of holders > ${maxBundledWalletHolderPct}%` });
        return false;
      }
      return true;
    });

    if (passingAfterGmgn.length === 0 && passing.length > 0) {
      const combinedExamples = filteredOut.slice(-3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = formatNoCandidatesReport(
        combinedExamples,
        combinedExamples ? "" : "semua difilter aturan kualitas holder GMGN",
      );
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered by GMGN holder metrics",
        rejected: filteredOut.slice(-5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    // Optional competitiveness floor (web3probe): drop pools where our deploy
    // would be a negligible TVL share. Off by default — see estimateSharePct.
    const minSharePct = Number(config.screening.minEstimatedSharePct);
    const finalPassing = Number.isFinite(minSharePct) && minSharePct > 0
      ? passingAfterGmgn.filter(({ pool }) => {
          const share = estimateSharePct({ deployAmountSol: deployAmount, solPriceUsd: currentBalance.sol_price, poolTvlUsd: pool.tvl ?? pool.active_tvl });
          if (share == null || share >= minSharePct) return true;
          log("screening", `Share filter: dropped ${pool.name} — est share ${share}% < ${minSharePct}%`);
          filteredOut.push({ name: pool.name, reason: `est share ${share}% < min ${minSharePct}%` });
          return false;
        })
      : passingAfterGmgn;

    if (finalPassing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = formatNoCandidatesReport(
        combinedExamples,
        combinedExamples ? "" : "semua difilter launchpad / kualitas holder",
      );
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (finalPassing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(finalPassing[0], gmgnHolderStatsByMint);
      if (skipReason) {
        const candidateName = finalPassing[0].pool?.name || "unknown";
        screenReport = formatNoDeployReport({
          candidateName,
          skipReason: `Hanya satu kandidat lolos filter, tapi tidak layak deploy: ${skipReason}.`,
          rejectedLine: `- ${candidateName}: ${skipReason}`,
        });
        appendDecision(enrichDecisionEntry({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: finalPassing[0].pool?.pool,
          pool_name: candidateName,
        }, screenReport));
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      finalPassing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    const deployPlanResults = config.autoStrategy?.enabled
      ? await resolveDeployPlansForCandidates(finalPassing)
      : finalPassing.map((entry) => ({ entry, plan: null }));

    // Build compact candidate blocks
    const candidateBlocks = finalPassing.map(({ pool, sw, n, ti, mem }, i) => {
      const plan = deployPlanResults[i]?.plan ?? null;
      const mint = pool.base?.mint || ti?.mint;
      const gmgnStats = mint ? gmgnHolderStatsByMint.get(mint) : null;
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.gmgn_top10_pct ?? ti?.audit?.top_holders_pct ?? "?";
      const bundlerPct = gmgnStats?.bundlers_pct_in_top_100;
      const smartDegen = gmgnStats?.smart_degen_count;
      const holderRatios = computeHolderRatios(gmgnStats, ti?.holders ?? pool.base_token_holders);
      const estSharePct = estimateSharePct({ deployAmountSol: deployAmount, solPriceUsd: currentBalance.sol_price, poolTvlUsd: pool.tvl ?? pool.active_tvl });
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}${estSharePct != null ? `, est_share=${estSharePct}% of TVL` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${bundlerPct != null ? `, gmgn_bundlers=${bundlerPct}%` : ""}${smartDegen != null ? `, gmgn_sm=${smartDegen}` : ""}${holderRatios.fresh_wallet_holder_pct != null ? `, fresh_holders=${holderRatios.fresh_wallet_holder_pct}%` : ""}${holderRatios.bundled_wallet_holder_pct != null ? `, bundled_holders=${holderRatios.bundled_wallet_holder_pct}%` : ""}${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        plan ? formatDeployPlanBlock(plan) : null,
      ].filter(Boolean).join("\n");

      // Stage signals — Darwinian weighting + holder-audit snapshot for the
      // deploy decision log. Always staged (not just darwin) so the deploy
      // decision can record top10/bundler/bot context even with darwin off.
      {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        const auditNum = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
          top10_pct:             auditNum(top10Pct),
          bot_pct:               auditNum(botPct),
          bundler_pct:           auditNum(bundlerPct),
          smart_degen_count:     auditNum(smartDegen),
          fresh_wallet_holder_pct:   holderRatios.fresh_wallet_holder_pct,
          bundled_wallet_holder_pct: holderRatios.bundled_wallet_holder_pct,
          estimated_share_pct:       estSharePct,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted = false;
    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${finalPassing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, pool metrics, and auto_strategy fit. Skip candidates with entry_gate: BLOCK.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
${config.autoStrategy?.enabled ? `   Use the winner's deploy_plan EXACTLY: strategy, bins_below, bins_above from its candidate block.
   DO NOT recompute or guess bin counts from bin_step, volatility, or any other number — the deploy_plan block is authoritative. If the block says bins_below=100, deploy with bins_below=100 (it already satisfies the min 60 floor). Passing a different bin count than the block states is a critical error.
   pass deploy_position.volatility = candidate volatility.
   amount_y = deploy amount from goal, amount_x = 0.` : `   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.`}
4. Laporan HARUS dalam Bahasa Indonesia. Format jika deploy sukses (tanpa tabel):
   🚀 DEPLOY

   <nama pool>
   <alamat pool>

   ◎ <jumlah deploy> SOL | <strategi> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Cakupan range: <downside %> downside | <upside %> upside | <total width %> total

   PENTING:
   - Jangan hitung persentase range sendiri.
   - Pakai hasil deploy_position: range_coverage.downside_pct, upside_pct, width_pct

   PASAR
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatilitas: <x>
   Organik: <x>
   Mcap: $<x>
   Umur: <x>j

   AUDIT
   Top10: <x>%
   Bot: <x>%
   Fee dibayar: <x> SOL
   Smart wallet: <nama atau tidak ada>

   ALASAN MENANG
   <2-4 kalimat singkat kenapa pool ini menang, risiko utama, dan kenapa lebih baik dari alternatif>
5. Jika tidak ada pool yang layak, format ini:
   ⛔ TIDAK DEPLOY

   Siklus selesai tanpa entry valid.

   KANDIDAT TERBAIK
   <nama atau tidak ada>

   ALASAN DILEWATI
   <2-4 kalimat singkat kenapa tidak ada yang cukup bagus>

   DITOLAK
   <daftar singkat nama kandidat + alasan ditolak>
PENTING:
- Laporan ringkas dan mudah discan di Telegram. Semua teks Bahasa Indonesia.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    screenReport = content;
    if (/⛔\s*(NO DEPLOY|TIDAK DEPLOY)/i.test(content)) {
      appendDecision(enrichDecisionEntry({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      }, content));
    } else if (!deploySucceeded) {
      appendDecision(enrichDecisionEntry({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      }, content));
    }
    outcome.deployed = deploySucceeded;
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Siklus screening gagal: ${error.message}`;
  } finally {
    _screeningBusy = false;
    try {
      const autotune = recordScreeningOutcome(outcome, config);
      if (autotune?.relaxed && autotune.changes) {
        const relaxedSummary = Object.entries(autotune.changes).map(([k, v]) => `${k}=${v}`).join(", ");
        const note = `\n\n🔧 Filter autotune: dilonggarkan — ${relaxedSummary}`;
        screenReport = screenReport ? `${screenReport}${note}` : `🔧 Filter autotune: dilonggarkan — ${relaxedSummary}`;
      }
    } catch (e) {
      log("config_warn", `Filter autotune failed: ${e.message}`);
    }
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        const screenOut = localizeTelegramReport(stripThink(screenReport));
        if (liveMessage) await liveMessage.finalize(screenOut).catch(() => {});
        else sendMessage(TG.screeningCycle(screenOut)).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Fast PnL poller — the real-time exit path between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  // Exits require `confirmTicks` consecutive confirming polls (registerExitSignal) so a
  // single noisy tick can't close a position; confirmed exits close DIRECTLY here (no
  // management-interval cooldown gate that used to swallow rule hits).
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks, config.management.pnlWarmupMinutes);

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        let exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (!exit) {
          exit = await checkPositionChartExit(p).catch(() => null);
        }
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null, rule = "exit";
        if (exit) { signal = exit.action; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }

        // Require N consecutive confirming ticks before acting.
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) {
          // No exit signal this tick — check the one-time partial TP (DCA-out).
          // Exits always win: partial only runs when nothing else fired. Anti-noise
          // comes from requiring the CONFIRMED peak >= trigger (confirmPeak ticks).
          if (!signal && config.management.partialTpEnabled) {
            const partial = shouldPartialTakeProfit(getTrackedPosition(p.position), p, config.management);
            if (partial) {
              log("state", `[PnL poll] PARTIAL_TP: ${p.pair} — ${partial.reason}`);
              _managementBusy = true;
              try {
                const res = await partialClosePosition({ position_address: p.position, close_pct: partial.close_pct, reason: partial.reason });
                if (res?.success && config.management.autoSwapAfterClose && res.base_mint && res.base_mint !== config.tokens.SOL) {
                  await swapBaseToSolWithRetry(res.base_mint, "post-partial-close");
                }
                log("state", `[PnL poll] ${p.pair}: partial close ${res?.success ? `OK (${partial.close_pct}%)` : `FAILED — ${res?.error || "unknown"}`}`);
              } catch (e) {
                log("cron_error", `Poll-triggered partial close failed: ${e.message}`);
              } finally {
                _managementBusy = false;
              }
              break; // one action per tick
            }
          }
          // POWER MODE: no exit and no partial — attempt a rebalance once the
          // OOR window + cooldown allow it (isRebalanceCandidate pre-gates so
          // the 3s tick doesn't hammer APIs). Only the REBALANCE action runs
          // here; close downgrades wait for the management cycle so poller
          // closes keep their N-tick confirmation discipline.
          if (!signal && config.management.autoRebalanceEnabled !== false) {
            const reb = await maybeResolveRebalance(p).catch(() => null);
            if (reb?.action === "REBALANCE") {
              log("state", `[PnL poll] REBALANCE: ${p.pair} — ${reb.reason}`);
              _managementBusy = true;
              try {
                const res = await rebalancePosition({ position_address: p.position, plan: reb.plan, reason: reb.reason });
                log("state", `[PnL poll] ${p.pair}: rebalance ${res?.success
                  ? `OK (${reb.plan.rebalance_type}, ${res.rebalance_path})`
                  : res?.blocked ? `SKIPPED — ${res?.error || "blocked"}` : `FAILED — ${res?.error || "unknown"}`}`);
              } catch (e) {
                log("cron_error", `Poll-triggered rebalance failed: ${e.message}`);
              } finally {
                _managementBusy = false;
              }
              break; // one action per tick
            }
          }
          continue;
        }

        log("state", `[PnL poll] ${signal} confirmed (${confirmTicks} ticks): ${p.pair} — ${reason} — closing directly`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, { action: "CLOSE", rule, reason }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the existing screening
  // deploy decision (runScreeningCycle), which re-checks guards and forces the deploy LLM.
  let opportunityPollInterval = null;
  if (config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const oppCooldownMs = 5 * 60 * 1000; // don't re-trigger the deploy LLM more than every 5m
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < oppCooldownMs) return;
      _opportunityPollBusy = true;
      try {
        reloadUserConfigFromDisk();
        if (!canTriggerScreening(config).ok) return;
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || !checkScreeningDeployGate({ openCount: positions.total_positions ?? 0, cfg: config }).allowed) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        if (process.env.DRY_RUN !== "true" && (!balance || balance.sol < minRequired)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        runScreeningCycle({ silent: true }).catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}`);
}

/**
 * Daemon-side deterministic close rules 1-7 (SL, TP, pumped-above, OOR,
 * low yield, TGE max-hold, IL gap). NOTE: tools/dlmm/rules.js exports a
 * DIFFERENT function with the same name (the generic ruleset used by the
 * executor/tests) — this one is the daemon's authoritative version and is
 * intentionally NOT exported.
 */
function getDeterministicCloseRule(position, managementConfig) {
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

export function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}, gmgnHolderStatsByMint = null) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const mint = pool.base?.mint || tokenInfo.mint;
  const gmgnStats = mint && gmgnHolderStatsByMint?.get ? gmgnHolderStatsByMint.get(mint) : null;
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(
    tokenInfo.audit?.gmgn_top10_pct
    ?? tokenInfo.audit?.top_holders_pct
    ?? pool.gmgn_token_info_top10_pct
    ?? pool.gmgn_top10_holder_pct,
  );
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  const bundlerPct = Number(gmgnStats?.bundlers_pct_in_top_100);
  const maxBundlerTop100Pct = config.gmgn?.maxBundlerTop100Pct;

  // Hard fundamental gates — no override.
  const mcap = Number(tokenInfo.mcap ?? pool.base?.mcap ?? pool.mcap);
  const minFeesSol = minTokenFeesSolForMcap(mcap);
  if (Number.isFinite(globalFeesSol) && globalFeesSol < minFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${minFeesSol} SOL${Number.isFinite(mcap) ? ` (mcap $${Math.round(mcap).toLocaleString()})` : ""}`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  if (
    Number.isFinite(bundlerPct)
    && maxBundlerTop100Pct != null
    && bundlerPct > maxBundlerTop100Pct
  ) {
    return `GMGN bundlers ${bundlerPct}% above maximum ${maxBundlerTop100Pct}%`;
  }

  // PVP conflict needs strong conviction (degen) to deploy solo.
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (_cronStarted) startCronJobs(); });
