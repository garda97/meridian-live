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
import { runCopyTradePoll } from "../copytrade.js";
import { timers, stripThink, sanitizeUntrustedPromptText } from "./runtime.js";
import { maybeAutoRecovery } from "./engine/recovery.js";
// Recovery Strat lives in ./engine/recovery.js; re-export its pure, unit-tested
// helpers so index.js (and test/test-recovery-strat.js through it) keep importing
// filterRecoveryCandidates/computeRecoveryBinsBelow from the engine facade.
export { filterRecoveryCandidates, computeRecoveryBinsBelow } from "./engine/recovery.js";
// Daemon-side deterministic close rules 1-7 (private — index.js does not re-export;
// distinct from the same-named generic rule in tools/dlmm/rules.js).
import { getDeterministicCloseRule } from "./engine/close-rules.js";
import { engineState } from "./engine/engine-state.js";
import { runScreeningCycle, getLoneCandidateSkipReason } from "./engine/screening-cycle.js";
export { runScreeningCycle, getLoneCandidateSkipReason };

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
// Exit/peak confirmation is done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** True while a management or screening cycle holds the engine. */
export function isEngineBusy() {
  return engineState.managementBusy || engineState.screeningBusy;
}

export function isCronStarted() {
  return engineState.cronStarted;
}

/**
 * Start the autonomous cycles once: seeds the countdown timers and flips the
 * started flag that the cron-restarter (interval config changes) checks.
 * Returns true when this call actually started them, false if already running.
 */
export function ensureCronStarted() {
  if (engineState.cronStarted) return false;
  engineState.cronStarted = true;
  timers.managementLastRun = Date.now();
  timers.screeningLastRun = Date.now();
  startCronJobs();
  return true;
}

export function pauseCronJobs() {
  stopCronJobs();
  engineState.cronStarted = false;
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
  for (const task of engineState.cronTasks) task.stop();
  if (engineState.cronTasks._pnlPollInterval) clearInterval(engineState.cronTasks._pnlPollInterval);
  if (engineState.cronTasks._opportunityPollInterval) clearInterval(engineState.cronTasks._opportunityPollInterval);
  if (engineState.cronTasks._copyTradePollInterval) clearInterval(engineState.cronTasks._copyTradePollInterval);
  engineState.cronTasks = [];
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

export async function runManagementCycle({ silent = false } = {}) {
  if (engineState.managementBusy) return null;
  engineState.managementBusy = true;
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

    // POWER MODE plan resolution is read-only (pool detail + chart indicators +
    // token-info fetches, then a pure plan compute) and independent per position,
    // so resolve every candidate's plan concurrently instead of one-await-per-
    // position inside the loop below (was N × up to 3 sequential RPC round-trips).
    // Positions already flagged for a hard exit skip rebalancing, so don't spend
    // fetches on them. Fail-open per position (matching the sibling call site) —
    // one position's resolution error must not abort the whole management cycle.
    const rebalanceByPosition = new Map();
    if (config.management.autoRebalanceEnabled !== false) {
      const rebalanceCandidates = positionData.filter((p) => !exitMap.has(p.position));
      const resolvedPlans = await Promise.all(
        rebalanceCandidates.map((p) => maybeResolveRebalance(p).catch(() => null)),
      );
      rebalanceCandidates.forEach((p, i) => rebalanceByPosition.set(p.position, resolvedPlans[i]));
    }

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
        const reb = rebalanceByPosition.get(p.position);
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
      Date.now() - engineState.screeningLastTriggered > screeningCooldownMs
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
    engineState.managementBusy = false;
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

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (engineState.managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (engineState.managementBusy) return;
    engineState.managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      engineState.managementBusy = false;
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
    if (engineState.managementBusy || engineState.screeningBusy || _pnlPollBusy) return;
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
              engineState.managementBusy = true;
              try {
                const res = await partialClosePosition({ position_address: p.position, close_pct: partial.close_pct, reason: partial.reason });
                if (res?.success && config.management.autoSwapAfterClose && res.base_mint && res.base_mint !== config.tokens.SOL) {
                  await swapBaseToSolWithRetry(res.base_mint, "post-partial-close");
                }
                log("state", `[PnL poll] ${p.pair}: partial close ${res?.success ? `OK (${partial.close_pct}%)` : `FAILED — ${res?.error || "unknown"}`}`);
              } catch (e) {
                log("cron_error", `Poll-triggered partial close failed: ${e.message}`);
              } finally {
                engineState.managementBusy = false;
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
              engineState.managementBusy = true;
              try {
                const res = await rebalancePosition({ position_address: p.position, plan: reb.plan, reason: reb.reason });
                log("state", `[PnL poll] ${p.pair}: rebalance ${res?.success
                  ? `OK (${reb.plan.rebalance_type}, ${res.rebalance_path})`
                  : res?.blocked ? `SKIPPED — ${res?.error || "blocked"}` : `FAILED — ${res?.error || "unknown"}`}`);
              } catch (e) {
                log("cron_error", `Poll-triggered rebalance failed: ${e.message}`);
              } finally {
                engineState.managementBusy = false;
              }
              break; // one action per tick
            }
          }
          continue;
        }

        log("state", `[PnL poll] ${signal} confirmed (${confirmTicks} ticks): ${p.pair} — ${reason} — closing directly`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        engineState.managementBusy = true;
        try {
          const actMap = new Map([[p.position, { action: "CLOSE", rule, reason }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          engineState.managementBusy = false;
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
      if (engineState.screeningBusy || engineState.managementBusy || _opportunityPollBusy) return;
      if (Date.now() - engineState.screeningLastTriggered < oppCooldownMs) return;
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

  // Copy-trade poller — off by default (config.copyTrade.enabled). Diffs
  // tracked "copytrade"-type wallets' live positions against the last poll
  // and mirrors newly-opened ones. See copytrade.js for the full flow.
  let copyTradePollInterval = null;
  if (config.copyTrade.enabled) {
    const ctMs = Math.max(15, Number(config.copyTrade.pollIntervalSec ?? 60)) * 1000;
    let _copyTradePollBusy = false;
    copyTradePollInterval = setInterval(async () => {
      if (engineState.managementBusy || engineState.screeningBusy || _copyTradePollBusy) return;
      _copyTradePollBusy = true;
      try {
        await runCopyTradePoll();
      } catch (e) {
        log("cron_error", `Copytrade poll failed: ${e.message}`);
      } finally {
        _copyTradePollBusy = false;
      }
    }, ctMs);
  }

  engineState.cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval refs so stopCronJobs can clear them
  engineState.cronTasks._pnlPollInterval = pnlPollInterval;
  engineState.cronTasks._opportunityPollInterval = opportunityPollInterval;
  engineState.cronTasks._copyTradePollInterval = copyTradePollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}${config.copyTrade.enabled ? `, copytrade poll every ${config.copyTrade.pollIntervalSec}s` : ""}`);
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (engineState.cronStarted) startCronJobs(); });
