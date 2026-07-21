import { discoverPools, getPoolDetail, getTopCandidates, volatilityScaledBinStepWindow } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  rebalancePosition,
  searchPools,
} from "./dlmm.js";
import { resolveRebalancePlanForPosition, shouldRebalance } from "./position-router.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition, markPositionClosing, unmarkPositionClosing, markCloseNotified } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, reloadUserConfigFromDisk, strategyDeployOverride, MIN_SAFE_BINS_BELOW } from "../config.js";
import { isScreeningPaused } from "../utils/screening-gate.js";
import {
  applyPendingPlanToDeployArgs,
  validateDeployPlanGate,
} from "./strategy-router.js";
import { getRecentDecisions, appendDecision } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, sendMessage as sendTelegramMessage } from "../telegram.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }
  // FIX (Hermes): entry-timing guard — reject extreme volatility spikes. A pool whose
  // volatility is far above the historical norm (avg ~2.34 across closed outcomes) is
  // usually in a pump/dump leg; deploying then -> immediate OOR. maxVolatility caps entry.
  const maxVol = numberOrNull(config.screening?.maxVolatility ?? config.maxVolatility);
  if (maxVol != null && volatility > maxVol) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility.toFixed(2)} exceeds maxVolatility ${maxVol} — refusing deploy (extreme move / entry-timing guard).`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const binStepWindow = volatilityScaledBinStepWindow(volatility);
  const minStep = numberOrNull(binStepWindow.minBinStep);
  const maxStep = numberOrNull(binStepWindow.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  return { pass: true, entryMarketData };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
    "lpAgentDiscoveryEnabled",
    "copyTradeEnabled",
    "copyTradeMirrorExit",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "gmgnFeeSource",
    "gmgnApiKey",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  rebalance_position: async ({ position_address, reason }) => {
    if (!position_address) return { error: "position_address required" };
    const tracked = getTrackedPosition(position_address);
    const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
    const position = live?.positions?.find((p) => p.position === position_address);
    if (!position) return { error: `Position ${position_address} not found on-chain` };

    const plan = await resolveRebalancePlanForPosition({ position, tracked });
    if (!plan) return { error: "Could not resolve a rebalance plan (pool/indicator data unavailable)" };

    const decision = shouldRebalance({ plan, position, tracked });
    if (decision.action !== "rebalance") {
      return {
        success: false,
        decision: decision.action,
        reason: decision.reason,
        market_view: plan.market_view,
        plan_action: plan.action,
        note: decision.action === "close"
          ? "Router recommends CLOSE, not rebalance — use close_position."
          : "Router says hold — no rebalance executed.",
      };
    }
    return rebalancePosition({ position_address, plan, reason: reason || decision.reason });
  },
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      mcapScaledTokenFees: ["screening", "mcapScaledTokenFees"],
      minTokenFeesSolPer100kMcap: ["screening", "minTokenFeesSolPer100kMcap"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      lpAgentDiscoveryEnabled: ["screening", "lpAgentDiscoveryEnabled"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      rugcheckEnabled: ["screening", "rugcheckEnabled"],
      rugcheckTop10MaxPct: ["screening", "rugcheckTop10MaxPct"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      lossRedeployBlockEnabled: ["management", "lossRedeployBlockEnabled"],
      lossRedeployCooldownHours: ["management", "lossRedeployCooldownHours"],
      winOorRedeployCooldownHours: ["management", "winOorRedeployCooldownHours"],
      winRedeployCooldownEnabled: ["management", "winRedeployCooldownEnabled"],
      winRedeployCooldownHours: ["management", "winRedeployCooldownHours"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      autoRebalanceEnabled: ["management", "autoRebalanceEnabled"],
      rebalanceMinOorMinutes: ["management", "rebalanceMinOorMinutes"],
      rebalanceMaxPerPosition: ["management", "rebalanceMaxPerPosition"],
      rebalanceCooldownMinutes: ["management", "rebalanceCooldownMinutes"],
      rebalanceMinAgeMinutes: ["management", "rebalanceMinAgeMinutes"],
      rebalanceMinPnlPct: ["management", "rebalanceMinPnlPct"],
      rebalanceOnStrategyDrift: ["management", "rebalanceOnStrategyDrift"],
      shareExitEnabled: ["management", "shareExitEnabled"],
      shareExitMinPct: ["management", "shareExitMinPct"],
      shareExitTvlGrowthMin: ["management", "shareExitTvlGrowthMin"],
      rebalanceMigrateRentBufferSol: ["management", "rebalanceMigrateRentBufferSol"],
      rebalanceMigrateWideRentExtraSol: ["management", "rebalanceMigrateWideRentExtraSol"],
      rebalanceTxFeeBufferSol: ["management", "rebalanceTxFeeBufferSol"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      partialTpEnabled: ["management", "partialTpEnabled"],
      partialTpTriggerPct: ["management", "partialTpTriggerPct"],
      partialTpClosePct: ["management", "partialTpClosePct"],
      partialTpMinRemainUsd: ["management", "partialTpMinRemainUsd"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      pnlWarmupMinutes: ["management", "pnlWarmupMinutes"],
      dailyLossLimitUsd: ["management", "dailyLossLimitUsd"],
      noDeployAfterHour: ["schedule", "noDeployAfterHour"],
      noDeployBeforeHour: ["schedule", "noDeployBeforeHour"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      minAgeBeforeTakeProfit: ["management", "minAgeBeforeTakeProfit"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      autoStrategyEnabled: ["autoStrategy", "enabled"],
      autoStrategyMaxBins: ["autoStrategy", "maxBins"],
      autoStrategyAllowSpot: ["autoStrategy", "allowSpot"],
      autoStrategyAllowCurve: ["autoStrategy", "allowCurve"],
      autoStrategyPreferSpotHighFee: ["autoStrategy", "preferSpotHighFee"],
      autoStrategySpotFeeTvlMin: ["autoStrategy", "spotFeeTvlMin"],
      autoStrategyMaxPumpPct1h: ["autoStrategy", "maxPumpPct1h"],
      autoStrategyMaxOorRisk: ["autoStrategy", "maxOorRisk"],
      minUpsideCoverPctPump: ["autoStrategy", "minUpsideCoverPctPump"],
      athEntryGateEnabled: ["autoStrategy", "athEntryGateEnabled"],
      athLookbackCandles: ["autoStrategy", "athLookbackCandles"],
      tgeMaxAgeHours: ["autoStrategy", "tgeMaxAgeHours"],
      tgeMinFeePct: ["autoStrategy", "tgeMinFeePct"],
      tgeMaxHoldHours: ["autoStrategy", "tgeMaxHoldHours"],
      solRegimeGateEnabled: ["screening", "solRegimeGateEnabled"],
      solDump1hPctThreshold: ["screening", "solDump1hPctThreshold"],
      minEstimatedSharePct: ["screening", "minEstimatedSharePct"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source", ["pnlSource"]],
      pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
      // gmgn fee source + holder audit
      gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
      gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
      gmgnHolderAudit: ["gmgn", "holderAudit", ["gmgnHolderAudit"]],
      maxBundlerTop100Pct: ["gmgn", "maxBundlerTop100Pct", ["maxBundlerTop100Pct"]],
      maxFreshWalletHolderPct: ["gmgn", "maxFreshWalletHolderPct", ["maxFreshWalletHolderPct"]],
      maxBundledWalletHolderPct: ["gmgn", "maxBundledWalletHolderPct", ["maxBundledWalletHolderPct"]],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
      evilPandaRsiExit: ["indicators", "evilPandaRsiExit", ["chartIndicators", "evilPandaRsiExit"]],
      evilPandaMacdExitEnabled: ["indicators", "evilPandaMacdExitEnabled", ["chartIndicators", "evilPandaMacdExitEnabled"]],
      // copy-trade
      copyTradeEnabled: ["copyTrade", "enabled", ["copyTrade", "enabled"]],
      copyTradePollIntervalSec: ["copyTrade", "pollIntervalSec", ["copyTrade", "pollIntervalSec"]],
      copyTradeAmountSol: ["copyTrade", "amountSol", ["copyTrade", "amountSol"]],
      copyTradeMaxPositions: ["copyTrade", "maxPositions", ["copyTrade", "maxPositions"]],
      copyTradeMirrorExit: ["copyTrade", "mirrorExit", ["copyTrade", "mirrorExit"]],
      copyTradeMinPositionUsd: ["copyTrade", "minPositionUsd", ["copyTrade", "minPositionUsd"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    atomicWriteFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    // Keep in-memory config aligned with disk (CLI runs in a separate process; daemon
    // reloads via reloadUserConfigFromDisk at cycle start — this covers agent path).
    reloadUserConfigFromDisk();

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "rebalance_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
export async function swapBaseToSolWithRetry(baseMint, label, meta = {}) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = null;
  let lastToken = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.usd < 0.10) {
        // Nothing left to swap (already sold or dust) — treat as done.
        return { swapped: attempt > 1, result: null, token: null };
      }
      lastToken = token;
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  // Stranded-capital ledger (fees-maxi port): the unsold token's value would
  // otherwise vanish from all accounting. Record it so the management cycle
  // retries the swap and the daily-loss gate counts the stuck capital.
  if (lastToken && lastToken.usd >= Number(config.management.strandedMinUsd ?? 0.5)) {
    try {
      const { recordStranded } = await import("../stranded-capital.js");
      recordStranded({
        mint: baseMint,
        symbol: lastToken.symbol,
        amount: lastToken.balance,
        usd_at_strand: lastToken.usd,
        label,
        position: meta.position || null,
        pool_name: meta.pool_name || null,
      });
      sendTelegramMessage(`⚠️ Stranded: ${lastToken.symbol || baseMint.slice(0, 8)} $${lastToken.usd.toFixed(2)} left unsold (${label}) — will retry each management cycle`).catch(() => {});
    } catch (e) {
      log("executor_warn", `Stranded-capital record failed: ${e.message}`);
    }
  }
  return { swapped: false, result: null, token: lastToken };
}

/**
 * Retry swapping stranded tokens back to SOL (called from the management
 * cycle, fire-and-forget). One pass over due entries per call; each entry
 * respects strandedRetryCooldownMin so a dead token doesn't burn a swap
 * quote every 5 minutes forever. A vanished balance (sold manually / below
 * $0.10) closes the entry as recovered with its realized value unknown.
 */
export async function retryStrandedSwaps() {
  const { getUnrecoveredStranded, strandedEntriesDueForRetry, markStrandedRetry, markStrandedRecovered } =
    await import("../stranded-capital.js");
  const due = strandedEntriesDueForRetry(
    getUnrecoveredStranded(),
    Date.now(),
    Number(config.management.strandedRetryCooldownMin ?? 15),
  );
  for (const entry of due) {
    markStrandedRetry(entry.mint);
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === entry.mint);
      if (!token || token.usd < 0.10) {
        markStrandedRecovered(entry.mint, { usd_recovered: null });
        continue;
      }
      const swapResult = await swapToken({ input_mint: entry.mint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) {
        markStrandedRecovered(entry.mint, { usd_recovered: token.usd });
        notifySwap({ inputSymbol: token.symbol || entry.mint.slice(0, 8), outputSymbol: "SOL", amountIn: swapResult.amount_in, amountOut: swapResult.amount_out, tx: swapResult.tx }).catch(() => {});
      } else {
        log("executor_warn", `Stranded retry failed for ${entry.symbol || entry.mint.slice(0, 8)}: ${swapResult?.error || "no tx"}`);
      }
    } catch (e) {
      log("executor_warn", `Stranded retry error for ${entry.symbol || entry.mint.slice(0, 8)}: ${e.message}`);
    }
  }
  return due.length;
}

/**
 * Normalize an LLM-emitted tool name to a real tool in the toolMap.
 * Some models mangle names: channel artifacts ("get_top_candidates<|channel|>…"),
 * namespace prefixes ("functions.get_top_candidates"), or camel-case compat
 * aliases with random suffixes ("CompatGetTopCandidates8964").
 * Returns { name, corrected, known } — `name` is the best candidate,
 * `known` says whether it resolved to a real tool.
 */
export function sanitizeToolName(rawName) {
  let name = String(rawName || "")
    .replace(/<.*$/, "")        // channel artifacts: "tool<|channel|>commentary"
    .replace(/[`'"]/g, "")
    .trim()
    .replace(/^(functions?|tools?|namespace|api)[./:]/i, ""); // "functions.tool_name"

  if (toolMap[name]) return { name, corrected: name !== rawName, known: true };

  // Fuzzy path: strip compat prefix + trailing hash noise (ebdf59, eff2f4), camelCase → snake_case
  const fuzzy = name
    .replace(/^compat[_-]?/i, "")
    .replace(/[_-]?[a-f0-9]{5,}$/i, "") // CompatDeployPositionebdf59 → DeployPosition
    .replace(/[_-]?\d+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (fuzzy && toolMap[fuzzy]) {
    log("executor_warn", `Fuzzy-matched tool name "${rawName}" → "${fuzzy}"`);
    return { name: fuzzy, corrected: true, known: true };
  }

  return { name, corrected: name !== rawName, known: false };
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args, context = {}) {
  const startTime = Date.now();

  // Normalize model-mangled tool names (artifacts, prefixes, compat aliases)
  const resolved = sanitizeToolName(name);
  name = resolved.name;

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    try {
      appendDecision({
        type: "skip",
        actor: context.actor || "GENERAL",
        summary: `Unknown tool call rejected: ${name}`,
        reason: `LLM called a tool that does not exist (raw name: ${String(name).slice(0, 80)}). Call blocked, nothing executed.`,
      });
    } catch { /* decision log must never break tool dispatch */ }
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (name === "deploy_position") {
    args = applyPendingPlanToDeployArgs(args);
  }
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args, context);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  // Guard a double close notification: while this close_position tx settles the
  // position is already gone on-chain but not yet recordClose'd, so mark it so
  // syncOpenPositions defers to this tool path instead of firing its own
  // external-close card (see markPositionClosing in state.js).
  if (name === "close_position" && args.position_address) markPositionClosing(args.position_address);
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        await notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch((e) => log("telegram_error", `notifyDeploy failed: ${e.message}`));
      } else if (name === "close_position") {
        const notified = await notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, feesUsd: result.fees_usd ?? null, deployedUsd: result.deployed_usd ?? null, amountSol: result.deployed_sol ?? null, holdMinutes: result.minutes_held ?? null, strategy: result.strategy ?? null, reason: result.close_reason ?? args.reason ?? null }).catch((e) => {
          log("telegram_error", `notifyClose failed: ${e.message}`);
          return false;
        });
        if (notified && args.position_address) markCloseNotified(args.position_address);
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        if (!args.skip_swap && result.base_mint) {
          const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after close", { position: args.position_address, pool_name: result.pool_name });
          if (swapped) {
            // Tell the model the swap already happened so it doesn't call swap_token again
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  } finally {
    if (name === "close_position" && args.position_address) unmarkPositionClosing(args.position_address);
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args, context = {}) {
  switch (name) {
    case "deploy_position": {
      const autoPlan = args._auto_strategy_plan ?? null;
      if (autoPlan) {
        const gate = validateDeployPlanGate(autoPlan);
        if (!gate.pass) return gate;
      }

      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const { minBinStep: minStep, maxBinStep: maxStep } = volatilityScaledBinStepWindow(args.volatility);
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      const deployStrategy = String(args.strategy ?? config.strategy.strategy ?? "bid_ask");
      const allowsUpsideBins = deployStrategy === "spot" || deployStrategy === "curve";
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "Token-only deploys are not supported yet. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const argBinsBelow = Number(args.bins_below ?? args.binsBelow ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsBelow = Math.min(
        Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)),
        Math.max(minBinsBelow, Number.isFinite(argBinsBelow) && argBinsBelow > 0 ? argBinsBelow : config.strategy.defaultBinsBelow ?? minBinsBelow)
      );
      const argBinsAbove = Number(args.bins_above ?? args.binsAbove ?? 0);
      const requestedBinsAbove = Math.max(0, Number.isFinite(argBinsAbove) ? argBinsAbove : 0);
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        !allowsUpsideBins &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL bid_ask deploy must use bins_above=0.",
        };
      }
      if (
        isSingleSidedSol &&
        allowsUpsideBins &&
        args.downside_pct == null &&
        args.upside_pct == null &&
        requestedBinsBelow + requestedBinsAbove < minBinsBelow
      ) {
        return {
          pass: false,
          reason: `spot/curve deploy needs at least ${minBinsBelow} total bins (got ${requestedBinsBelow + requestedBinsAbove}).`,
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      reloadUserConfigFromDisk();
      if (isScreeningPaused(config)) {
        return {
          pass: false,
          reason: "Screening paused (maxPositions=0). Set maxPositions >= 1 to resume deploys.",
        };
      }
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      // Recovery Strat deliberately opens a second position in the same pool/token
      // (below the parent's range) — internal-only actor, never LLM-reachable.
      const isRecoveryDeploy = context.actor === "RECOVERY";
      if (!isRecoveryDeploy) {
        const alreadyInPool = positions.positions.some(
          (p) => p.pool === args.pool_address
        );
        if (alreadyInPool) {
          return {
            pass: false,
            reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
          };
        }

        // Block same base token across different pools
        if (args.base_mint) {
          const alreadyHasMint = positions.positions.some(
            (p) => p.base_mint === args.base_mint
          );
          if (alreadyHasMint) {
            return {
              pass: false,
              reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
            };
          }
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      // Per-strategy fixed size (e.g. spot 0.5 vs bid_ask 2): when set, that
      // strategy's deploys are pinned to the override — both floor and ceiling —
      // so a smaller spot size isn't rejected by the global deployAmountSol floor
      // and the LLM can't oversize it past the override.
      const stratOverride = strategyDeployOverride(deployStrategy);
      const minDeploy = stratOverride != null
        ? Math.max(0.1, stratOverride)
        : Math.max(0.1, config.management.deployAmountSol);
      const maxDeploy = stratOverride != null
        ? Math.max(minDeploy, stratOverride)
        : config.risk.maxDeployAmount;
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL) for strategy ${deployStrategy}. Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > maxDeploy) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${maxDeploy} SOL) for strategy ${deployStrategy}.`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "rebalance_position": {
      const tracked = getTrackedPosition(args.position_address);
      if (tracked?.closed) {
        return { pass: false, reason: "Position is already closed — nothing to rebalance." };
      }
      // Plan-level gates (volume, PnL floor, budget, cooldown, OOR risk) run
      // inside the tool via shouldRebalance — this is just the hard stop.
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
