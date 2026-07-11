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
import { withTimeout } from "../utils/fetch-timeout.js";
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
import { runManagementCycle, executeManagementActions, maybeResolveRebalance } from "./engine/management.js";
export { runManagementCycle };

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

// Stuck-busy-flag watchdog state. A cycle sets its busy flag true then relies on a
// finally{} to reset it — but if an await inside the cycle HANGS (e.g. an RPC that
// never resolves and has no timeout), the finally never runs, the flag stays true,
// and every later cycle early-returns. Management (or screening) then silently dies
// until a manual restart. The watchdog below tracks each flag's rising edge and
// force-resets it once it has been stuck past STALE_BUSY_MS.
const STALE_BUSY_MS = 4 * 60 * 1000;
let _mgmtBusySince = 0;
let _screenBusySince = 0;

export function stopCronJobs() {
  for (const task of engineState.cronTasks) task.stop();
  if (engineState.cronTasks._pnlPollInterval) clearInterval(engineState.cronTasks._pnlPollInterval);
  if (engineState.cronTasks._opportunityPollInterval) clearInterval(engineState.cronTasks._opportunityPollInterval);
  if (engineState.cronTasks._copyTradePollInterval) clearInterval(engineState.cronTasks._copyTradePollInterval);
  if (engineState.cronTasks._busyWatchdog) clearInterval(engineState.cronTasks._busyWatchdog);
  engineState.cronTasks = [];
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (engineState.managementBusy) return;
    timers.managementLastRun = Date.now();
    // Hard cron-level guard: even if an await inside runManagementCycle wedges in
    // a way the internal per-phase mgmtPhase timeouts don't catch (observed under
    // live concurrency with the 3s poller — the cycle sets managementBusy=true then
    // never settles), bound the whole call and force-release the flag so the poller
    // (gated on managementBusy) can't be starved past ~2min. The dangling cycle, if
    // it ever settles, just re-clears an already-false flag (harmless).
    try {
      await withTimeout(runManagementCycle(), 120000, "runManagementCycle");
    } catch (e) {
      log("cron_error", `management cron aborted: ${e.message}`);
    } finally {
      if (engineState.managementBusy) {
        engineState.managementBusy = false;
        engineState.managementBusyReason = null;
      }
    }
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (engineState.managementBusy) return;
    engineState.managementBusy = true;
    engineState.managementBusyReason = "health-check";
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
              engineState.managementBusyReason = `poller-partial-close:${p.pair}`;
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
              engineState.managementBusyReason = `poller-rebalance:${p.pair}`;
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
        engineState.managementBusyReason = `poller-close:${p.pair}`;
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

  // Stuck-busy-flag watchdog (see STALE_BUSY_MS note by stopCronJobs). Checks every
  // 60s: if a busy flag has stayed true past the threshold, a cycle hung — force it
  // false so subsequent cycles resume instead of dying silently until a restart.
  const busyWatchdog = setInterval(() => {
    const now = Date.now();
    if (engineState.managementBusy) {
      if (!_mgmtBusySince) _mgmtBusySince = now;
      else if (now - _mgmtBusySince > STALE_BUSY_MS) {
        log("cron_error", `managementBusy stuck ${Math.round((now - _mgmtBusySince) / 60000)}m [culprit: ${engineState.managementBusyReason || "unknown"}] — force-resetting (a cycle hung on an await with no timeout)`);
        engineState.managementBusy = false;
        _mgmtBusySince = 0;
      }
    } else {
      _mgmtBusySince = 0;
    }
    if (engineState.screeningBusy) {
      if (!_screenBusySince) _screenBusySince = now;
      else if (now - _screenBusySince > STALE_BUSY_MS) {
        log("cron_error", `screeningBusy stuck ${Math.round((now - _screenBusySince) / 60000)}m — force-resetting (a cycle likely hung)`);
        engineState.screeningBusy = false;
        _screenBusySince = 0;
      }
    } else {
      _screenBusySince = 0;
    }
  }, 60 * 1000);
  busyWatchdog.unref?.();
  engineState.cronTasks._busyWatchdog = busyWatchdog;

  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}${config.copyTrade.enabled ? `, copytrade poll every ${config.copyTrade.pollIntervalSec}s` : ""}`);
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (engineState.cronStarted) startCronJobs(); });
