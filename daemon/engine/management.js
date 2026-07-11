// Management cycle — extracted from daemon/engine.js. Evaluates open positions
// each cycle: deterministic close rules + POWER MODE rebalance + auto-recovery,
// executing mechanical actions directly and deferring only INSTRUCTION positions
// to the MANAGER LLM. Depends on engineState + sibling cycle/rule submodules +
// leaf modules; no back-import from the engine facade (acyclic).
import { engineState } from "./engine-state.js";
import { getDeterministicCloseRule } from "./close-rules.js";
import { maybeAutoRecovery } from "./recovery.js";
import { runScreeningCycle } from "./screening-cycle.js";
import { stripThink } from "../runtime.js";
import { log } from "../../logger.js";
import { config, reloadUserConfigFromDisk } from "../../config.js";
import { getTrackedPosition, confirmPeak, updatePnlAndCheckExits } from "../../state.js";
import { isRebalanceCandidate, resolveRebalancePlanForPosition, shouldRebalance, computeTvlDilution, checkTvlDilutionExit } from "../../tools/position-router.js";
import { executeTool } from "../../tools/executor.js";
import { observeOpenPosition } from "../../lessons.js";
import { getMyPositions, rebalancePosition } from "../../tools/dlmm.js";
import { canTriggerScreening } from "../../utils/screening-gate.js";
import { isEnabled as telegramEnabled, notifyOutOfRange, sendMessage, createLiveMessage } from "../../telegram.js";
import { TG, TG_TITLES, localizeTelegramReport } from "../../utils/telegram-id.js";
import { agentLoop } from "../../agent.js";
import { getPoolDetail } from "../../tools/screening.js";
import { checkPositionChartExit } from "../../tools/chart-indicators.js";
import { recordPositionSnapshot, recallForPool } from "../../pool-memory.js";

/**
 * POWER MODE: cheap-gate, resolve, and decide a rebalance for one position.
 * Returns an actionMap-shaped entry: REBALANCE (with plan), CLOSE (downgrade:
 * dead volume / max count / deep PnL / risky re-plan), or null (hold — fall
 * through to the existing deterministic rules).
 */
export async function maybeResolveRebalance(p) {
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
export async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
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

