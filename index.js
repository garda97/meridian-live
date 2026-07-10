import "./envcrypt.js";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  isEnabled as telegramEnabled,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { bootstrapHiveMind, ensureAgentId, startHiveMindBackgroundSync } from "./hivemind.js";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import {
  runManagementCycle,
  runScreeningCycle,
  startCronJobs,
  stopCronJobs,
  ensureCronStarted,
  maybeRunMissedBriefing,
  filterRecoveryCandidates,
  computeRecoveryBinsBelow,
} from "./daemon/engine.js";
import { telegramHandler } from "./daemon/telegram-ui.js";
import {
  timers,
  buildPrompt,
  setPromptRefresher,
  isInteractiveBusy,
  setInteractiveBusy,
  sessionHistory,
  appendHistory,
  setLatestCandidates,
  getLatestCandidatesMeta,
} from "./daemon/runtime.js";

// Public daemon API — the engine implements it; tests and external callers
// keep importing from index.js.
export {
  runManagementCycle,
  runScreeningCycle,
  startCronJobs,
  filterRecoveryCandidates,
  computeRecoveryBinsBelow,
};

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Last-resort crash handlers. Node 22 kills the process on any unhandled
// rejection — for a live-money daemon a stray promise in a poller must not
// take down position monitoring, so rejections are logged loudly and the
// daemon keeps running (all state writes are already atomic). A synchronous
// uncaughtException leaves the process in an unknown state: log, fire a
// best-effort Telegram alert, and exit non-zero so PM2/systemd restarts clean.
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  log("fatal_warn", `Unhandled promise rejection (daemon continues): ${detail}`);
});
process.on("uncaughtException", (error) => {
  const detail = error?.stack || error?.message || String(error);
  log("fatal", `Uncaught exception — restarting via supervisor: ${detail}`);
  try {
    if (telegramEnabled()) {
      sendMessage(`🚨 Meridian crash (uncaught exception) — restarting.\n${(error?.message || error).toString().slice(0, 300)}`).catch(() => {});
    }
  } catch { /* never block the exit path */ }
  setTimeout(() => process.exit(1), 1500).unref();
});

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE (REPL startup + /candidates)
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    const sharePct = p.estimated_share_pct != null ? `${p.estimated_share_pct.toFixed(2)}%`.padStart(7) : "?".padStart(7);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}  share:${sharePct}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  setPromptRefresher(() => {
    rl.setPrompt(buildPrompt());
    rl.prompt(true);
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!isInteractiveBusy()) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (ensureCronStarted()) {
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (isInteractiveBusy()) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    setInteractiveBusy(true); rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { setInteractiveBusy(false); rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  setInteractiveBusy(true);
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    setInteractiveBusy(false);
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  // In TTY/interactive mode, start polling here. In non-TTY (daemon) mode the
  // polling is started further below (guarded by telegramEnabled) to avoid a
  // double getUpdates loop -> HTTP 409 conflict.
  if (isTTY) {
    startPolling(telegramHandler);
  }

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync(repoPath("lessons.json"), "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately. ensureCronStarted (not bare startCronJobs)
  // seeds the countdown timers AND flips the started flag the cron-restarter
  // checks — previously interval changes via update_config never restarted
  // cron under systemd because the flag stayed false in non-TTY mode.
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  ensureCronStarted();
  maybeRunMissedBriefing().catch(() => { });
  // Telegram inbound polling MUST run in daemon (non-TTY) mode too — otherwise
  // incoming photos/commands are never received (only outbound sendMessage worked).
  // Previously this was commented out ("moved to TTY block"), which disabled
  // inbound entirely under systemd. Guarded by telegramEnabled().
  if (telegramEnabled()) {
    startPolling(telegramHandler);
    log("startup", "Telegram inbound polling started (non-TTY daemon mode).");
  }
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
