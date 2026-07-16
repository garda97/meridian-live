// Screening cycle — extracted from daemon/engine.js. Discovers/filters/enriches
// pool candidates and either deploys (via the LLM SCREENER) or writes a no-deploy
// decision. Depends only on engineState + leaf modules (no back-import from the
// engine facade), so the dependency stays acyclic.
import cron from "node-cron";
import { engineState } from "./engine-state.js";
import { log } from "../../logger.js";
import { config, computeDeployAmount, deployAmountForStrategy, minTokenFeesSolForMcap, reloadUserConfigFromDisk } from "../../config.js";
import { getActiveBin, getMyPositions } from "../../tools/dlmm.js";
import { getWalletBalances, getSolPriceUsd } from "../../tools/wallet.js";
import { checkScreeningDeployGate } from "../../utils/screening-gate.js";
import { appendDecision, enrichDecisionEntry, getRecentDecisions } from "../../decision-log.js";
import { checkDailyLossGate } from "../../utils/daily-loss.js";
import { isWithinDeployWindow } from "../../utils/deploy-window.js";
import { checkSolRegimeGate } from "../../tools/sol-regime.js";
import { createLiveMessage, sendMessage, isEnabled as telegramEnabled } from "../../telegram.js";
import { TG, TG_TITLES, formatNoCandidatesReport, formatNoDeployReport, localizeTelegramReport } from "../../utils/telegram-id.js";
import { sanitizeUntrustedPromptText, stripThink, timers } from "../runtime.js";
import { getActiveStrategy } from "../../strategy-library.js";
import { degenScore, estimateSharePct, getTopCandidates } from "../../tools/screening.js";
import { checkSmartWalletsOnPool } from "../../smart-wallets.js";
import { getTokenInfo, getTokenNarrative } from "../../tools/token.js";
import { recallForPool } from "../../pool-memory.js";
import { computeHolderRatios, getGmgnTokenTopHolders } from "../../tools/gmgn.js";
import { formatDeployPlanBlock, resolveDeployPlansForCandidates } from "../../tools/strategy-router.js";
import { stageSignals } from "../../signal-tracker.js";
import { getWeightsSummary } from "../../signal-weights.js";
import { agentLoop } from "../../agent.js";
import { recordScreeningOutcome } from "../../filter-autotune.js";
import { formatWalletSignalNote } from "../../utils/wallet-signal-enrich.js";
import { getBlockedThemeRejectReason } from "../../utils/blocked-theme.js";

export async function runScreeningCycle({ silent = false } = {}) {
  if (engineState.screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  engineState.screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  engineState.screeningLastTriggered = Date.now();

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
    // Jupiter price for regime gate — Helius wallet pricePerToken can glitch (e.g. $120 vs ~$75).
    const solPriceForRegime = (await getSolPriceUsd()) ?? preBalance?.sol_price;
    const regime = checkSolRegimeGate(solPriceForRegime, { btcPriceUsd });
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
    const topCandidates = await getTopCandidates({ limit: 15 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 15);
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
      const themeReject = getBlockedThemeRejectReason(
        {
          poolName: pool?.name,
          symbol: ti?.symbol || pool?.base?.symbol,
        },
        config.screening.blockedNameKeywords,
      );
      if (themeReject) {
        log("screening", `Skipping ${pool.name} — ${themeReject}`);
        filteredOut.push({ name: pool.name, reason: themeReject });
        return false;
      }
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
      // Per-strategy deploy size: a fixed override for the resolved strategy
      // (e.g. spot smaller than bid_ask) or the compounding global amount.
      const candDeployAmount = deployAmountForStrategy(plan?.strategy ?? config.strategy.strategy, currentBalance.sol);
      const estSharePct = estimateSharePct({ deployAmountSol: candDeployAmount, solPriceUsd: currentBalance.sol_price, poolTvlUsd: pool.tvl ?? pool.active_tvl });
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const ws = pool.wallet_signal;
      const walletSignalLine = ws
        ? `  wallet_signal: ${ws.wallet_name} → inferred ${ws.inferred_strategy} (${formatWalletSignalNote(ws) || "shape unknown"}, confidence=${ws.strategy_confidence}) — REFERENCE ONLY, do NOT mirror range/size`
        : pool.discord_signal && pool.signal_source?.startsWith("signal:")
          ? `  wallet_signal: ${pool.signal_source.replace("signal:", "")} flagged this pool (strategy shape unavailable) — REFERENCE ONLY`
          : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}${estSharePct != null ? `, est_share=${estSharePct}% of TVL` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${bundlerPct != null ? `, gmgn_bundlers=${bundlerPct}%` : ""}${smartDegen != null ? `, gmgn_sm=${smartDegen}` : ""}${holderRatios.fresh_wallet_holder_pct != null ? `, fresh_holders=${holderRatios.fresh_wallet_holder_pct}%` : ""}${holderRatios.bundled_wallet_holder_pct != null ? `, bundled_holders=${holderRatios.bundled_wallet_holder_pct}%` : ""}${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        walletSignalLine,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        plan ? formatDeployPlanBlock(plan) : null,
        `  deploy_amount_sol: ${candDeployAmount} SOL (for strategy ${plan?.strategy ?? config.strategy.strategy}) — USE THIS EXACT AMOUNT`,
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
0. Do NOT call get_top_candidates, search_pools, get_token_info, get_token_holders, get_token_narrative, or check_smart_wallets_on_pool — all candidate data is already pre-loaded above.
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, pool metrics, and auto_strategy fit. Skip candidates with entry_gate: BLOCK.
   ENTRY GATE: dip zone is [${config.autoStrategy?.dropEntryMin ?? "n/a"}%, ${config.autoStrategy?.dropEntryMax ?? "n/a"}%] 1h (dropEntryGate=${config.autoStrategy?.dropEntryGate ? "ON" : "OFF"}). When reporting BLOCK, quote the candidate's entry_reason EXACTLY — never invent -55%/-20% or other bands.
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
    if (/🚀\s*DEPLOY/i.test(content) && !deploySucceeded) {
      screenReport = "⚠️ Screening: model mengklaim deploy tanpa eksekusi deploy_position. Siklus dibatalkan — akan dicoba lagi.";
      appendDecision(enrichDecisionEntry({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Hallucinated deploy without tool execution",
        reason: stripThink(content).slice(0, 500),
      }, content));
    } else if (/⛔\s*(NO DEPLOY|TIDAK DEPLOY)/i.test(content)) {
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
    engineState.screeningBusy = false;
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
