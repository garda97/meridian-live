import fs from "fs";
import path from "path";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const FALSY_STRINGS = new Set(["false", "0", "no", "off", ""]);
const TRUTHY_STRINGS = new Set(["true", "1", "yes", "on"]);

/**
 * Coerce a user-config value to a real boolean (P2b, SPOT_LOSS_ANALYSIS.md).
 * Config flags used to be read as `u.xFlag ?? default` / `u.xFlag !== false`,
 * which silently mis-evaluates string values: "0"/"false" are truthy in JS
 * (non-empty strings), so a flag saved as the STRING "0" would read as ON,
 * and `"false" !== false` is also true (string never strictly equals a
 * boolean), so a flag meant to disable something would stay enabled.
 * `undefined`/`null` fall through to `defaultValue` (unset = use default).
 * Unrecognized non-empty values fail safe to `defaultValue` rather than a
 * blind `Boolean(value)` cast, so a typo can't silently flip a safety gate.
 */
export function boolConfig(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (FALSY_STRINGS.has(normalized)) return false;
    if (TRUTHY_STRINGS.has(normalized)) return true;
    return defaultValue;
  }
  return defaultValue;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

// Jito Bundle integration for MEV protection and transaction guarantees
const jitoConfig = {
  enabled: true,  // Set to true to enable Jito Bundle routing for LP transactions
  blockEngineUrl: process.env.JITO_BLOCK_ENGINE || 'https://ny.mainnet.block-engine.jito.wtf',
  tipLamports: Number(process.env.JITO_TIP_LAMPORTS) || 1_000_000,  // 0.001 SOL default
};

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}
// Fallback: reuse gmgn-cli credentials when Meridian has no explicit GMGN key.
if (!process.env.GMGN_API_KEY) {
  const gmgnCliEnv = path.join(process.env.HOME || "", ".config", "gmgn", ".env");
  if (fs.existsSync(gmgnCliEnv)) {
    for (const line of fs.readFileSync(gmgnCliEnv, "utf8").split("\n")) {
      const match = line.match(/^GMGN_API_KEY=(.+)$/);
      if (match) {
        process.env.GMGN_API_KEY = match[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: boolConfig(u.excludeHighSupplyConcentration, true),
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // floor (SOL); Evil Panda rule: <30 SOL total fees = bundled/scam signal
    mcapScaledTokenFees: boolConfig(u.mcapScaledTokenFees, true), // MeteoraFR rule: 10 SOL per $100k mcap
    minTokenFeesSolPer100kMcap: u.minTokenFeesSolPer100kMcap ?? 10,
    useDiscordSignals: boolConfig(u.useDiscordSignals, false),
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   boolConfig(u.avoidPvpSymbols, true), // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   boolConfig(u.blockPvpSymbols, false), // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    rugcheckEnabled:    boolConfig(u.rugcheckEnabled, true), // rugcheck.xyz gate on final candidates (fails open on API error)
    rugcheckTop10MaxPct: u.rugcheckTop10MaxPct ?? 60, // rugcheck top-10 holder concentration cap
    solRegimeGateEnabled: boolConfig(u.solRegimeGateEnabled, true),
    solDump1hPctThreshold: Number(u.solDump1hPctThreshold ?? -3),
    // Competitiveness floor: min estimated TVL share (%) our deploy must take.
    // null = off — at 0.5 SOL deploys the share is ~0.2% max, so this only
    // makes sense once the wallet is much larger. Metric always shown to LLM.
    minEstimatedSharePct: u.minEstimatedSharePct ?? null,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    boolConfig(u.autoSwapAfterClaim, false),
    autoSwapAfterClose:    boolConfig(u.autoSwapAfterClose, true),
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: boolConfig(u.repeatDeployCooldownEnabled, true),
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    autoRecovery:          boolConfig(u.autoRecovery, false), // Hermes: open recovery position below OOR-dropped position (off by default, owner opt-in)
    autoRecoveryBinsBelow: u.autoRecoveryBinsBelow ?? 100,  // how far below original lower bin to open recovery
    lossRedeployBlockEnabled: boolConfig(u.lossRedeployBlockEnabled, true),
    lossRedeployCooldownHours: u.lossRedeployCooldownHours ?? 24,
    winOorRedeployCooldownHours: u.winOorRedeployCooldownHours ?? 3, // block redeploy after a win that still went OOR (volatile pool)
    winRedeployCooldownEnabled: boolConfig(u.winRedeployCooldownEnabled, true), // block redeploy after a clean in-range win (trailing TP / take profit)
    winRedeployCooldownHours: u.winRedeployCooldownHours ?? 3,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    exitRule3ConditionsEnabled: boolConfig(u.exitRule3ConditionsEnabled, false),
    // TGE Play (opt-in): override konservatif untuk pool TGE (bins_below=35, bins_above=0, max_hold_hours=8).
    // Default OFF (false) — hanya aktifkan untuk pool TGE yang baru diluncurkan.
    tgePlayEnabled: boolConfig(u.tgePlayEnabled, false),
    tgeMaxAgeHours: u.tgeMaxAgeHours ?? null, // null = no age limit
    tgeMinFeePct: u.tgeMinFeePct ?? 5, // 5% minimum fee
    tgeMaxHoldHours: u.tgeMaxHoldHours ?? 8, // 8 jam max hold
    //   1. PnL ≥ takeProfitPct (trailing TP)
    //   2. PnL ≤ stopLossPct (hard SL)
    //   3. OOR ≥ outOfRangeWaitMinutes (OOR timeout)
    // Default OFF (false) — only enable if you want to override the default
    // trailing TP + hard SL + OOR timeout logic with a unified exit rule.
    exitRule3ConditionsEnabled: boolConfig(u.exitRule3ConditionsEnabled, false),
    // POWER MODE auto-rebalance: re-analyze open positions and reposition
    // (shift/widen/reseed/convert) instead of only hold/close.
    autoRebalanceEnabled:      boolConfig(u.autoRebalanceEnabled, true),
    rebalanceMinOorMinutes:    u.rebalanceMinOorMinutes    ?? 5,   // OOR confirmation window before repositioning
    rebalanceMaxPerPosition:   u.rebalanceMaxPerPosition   ?? 3,   // budget per position, then close
    rebalanceCooldownMinutes:  u.rebalanceCooldownMinutes  ?? 15,  // between attempts on the same position
    rebalanceMinPnlPct:        u.rebalanceMinPnlPct        ?? -8,  // below this, close instead of rebalance
    rebalanceOnStrategyDrift:  boolConfig(u.rebalanceOnStrategyDrift, true), // in-range bid_ask→spot conversion
    // TVL dilution exit (opt-in): close when our share collapsed AND the pool
    // TVL exploded since entry AND yield is under the low-yield floor.
    shareExitEnabled:      boolConfig(u.shareExitEnabled, false),
    shareExitMinPct:       u.shareExitMinPct       ?? 2,
    shareExitTvlGrowthMin: u.shareExitTvlGrowthMin ?? 3,
    rebalanceMigrateRentBufferSol: u.rebalanceMigrateRentBufferSol ?? 0.1,  // extra SOL atop gasReserve for new position account rent
    rebalanceMigrateWideRentExtraSol: u.rebalanceMigrateWideRentExtraSol ?? 0.05, // added when planned range > 69 bins
    rebalanceTxFeeBufferSol:   u.rebalanceTxFeeBufferSol   ?? 0.02, // headroom for claim/remove/add/close txs
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    // Min hold before deterministic take-profit may fire (deposits + PnL cache settle).
    // Stop loss stays live. Default tracks pnlWarmupMinutes (≥ pnlDepositCacheTtlSec/60).
    minAgeBeforeTakeProfit: u.minAgeBeforeTakeProfit ?? u.pnlWarmupMinutes ?? 10,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    boolConfig(u.trailingTakeProfit, true),
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // PnL warmup: minutes after deploy/rebalance during which peaks, trailing
    // arming, and take-profit are untrusted (FABLE phantom +74% spike 5s after
    // deploy fired trailing TP → 0% real close). Stop loss stays live.
    pnlWarmupMinutes:      u.pnlWarmupMinutes      ?? 3,
    // Partial take-profit (DCA-out) — one-time partial liquidity removal at profit,
    // position account stays open and keeps running under SL/trailing
    partialTpEnabled:      boolConfig(u.partialTpEnabled, false),
    partialTpTriggerPct:   u.partialTpTriggerPct   ?? 5,    // fire once when confirmed PnL reaches X%
    partialTpClosePct:     u.partialTpClosePct     ?? 50,   // % of liquidity to remove (clamped 1-99)
    partialTpMinRemainUsd: u.partialTpMinRemainUsd ?? 10,   // skip if remaining value would fall below this (SOL units when solMode)
    // Daily realized-loss kill-switch: when today's (WIB) summed realized PnL
    // hits -X USD, skip all new deploys until midnight. Open positions keep
    // running under SL/trailing. null = off.
    dailyLossLimitUsd:     u.dailyLossLimitUsd     ?? null,
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               boolConfig(u.solMode, false),
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
    // Time-of-day deploy gate, server-local hours (VPS = WIB). null = off.
    // e.g. noDeployAfterHour 18 = no new deploys from 18:00; existing positions unaffected.
    noDeployAfterHour:  u.noDeployAfterHour  ?? null,
    noDeployBeforeHour: u.noDeployBeforeHour ?? null,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        boolConfig(u.darwinEnabled, true),
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: boolConfig(u.lpAgentRelayEnabled, false),
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: boolConfig(u.opportunityPollEnabled, true),
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── GMGN (fee source + holder/security audit) ───────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    requestDelayMs: Number(gmgnUserConfig.requestDelayMs ?? u.gmgnRequestDelayMs ?? 2500),
    maxRetries: Number(gmgnUserConfig.maxRetries ?? u.gmgnMaxRetries ?? 2),
    // Hard per-request timeout — the underlying fetch() has none by default,
    // so a hung GMGN connection used to stall the whole screening cycle
    // forever (no error, no timeout, _screeningBusy never released).
    requestTimeoutMs: Number(gmgnUserConfig.requestTimeoutMs ?? u.gmgnRequestTimeoutMs ?? 10_000),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
    // Enrich token audit with GMGN security + holder tags when API key is present.
    holderAudit: boolConfig(gmgnUserConfig.holderAudit ?? u.gmgnHolderAudit, true),
    // Optional hard filter on bundler supply share in top-100 holders (null = off).
    maxBundlerTop100Pct: gmgnUserConfig.maxBundlerTop100Pct ?? u.maxBundlerTop100Pct ?? null,
    // Optional hard filters on tagged-wallet counts as % of total token holders
    // (METEORA_LP checklist points 10-11). null = off.
    maxFreshWalletHolderPct: gmgnUserConfig.maxFreshWalletHolderPct ?? u.maxFreshWalletHolderPct ?? null,
    maxBundledWalletHolderPct: gmgnUserConfig.maxBundledWalletHolderPct ?? u.maxBundledWalletHolderPct ?? null,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  autoStrategy: {
    enabled: boolConfig(u.autoStrategyEnabled, true),
    fetchIndicators: boolConfig(u.autoStrategyFetchIndicators, true),
    indicatorInterval: nonEmptyString(u.autoStrategyIndicatorInterval, "15_MINUTE"),
    allowSpot: boolConfig(u.autoStrategyAllowSpot, true),
    allowCurve: boolConfig(u.autoStrategyAllowCurve, true),
    maxBins: Math.max(69, Number(u.autoStrategyMaxBins ?? 200)),
    spotRatioBelow: Number(u.autoStrategySpotRatioBelow ?? 0.75),
    requireEntryConfirm: boolConfig(u.autoStrategyRequireEntryConfirm, false),
    preferSpotHighFee: boolConfig(u.autoStrategyPreferSpotHighFee, true),
    spotFeeTvlMin: Number(u.autoStrategySpotFeeTvlMin ?? 2),
    maxOorRisk: Number(u.autoStrategyMaxOorRisk ?? 65), // 0-100; block deploy above this, 0/null disables
    minUpsideCoverPctPump: Number(u.minUpsideCoverPctPump ?? 25), // pump-view deploys need this % of range above active bin
    // Evil Panda entry rule (opt-in): only deploy when token just set a new
    // ATH within the lookback window AND supertrend confirms break up.
    athEntryGateEnabled: boolConfig(u.athEntryGateEnabled, false),
    athLookbackCandles: Math.max(2, Number(u.athLookbackCandles ?? 48)),
    // "open" (default): indicator fetch failure skips the gate (deploy allowed).
    // "closed": indicator fetch failure blocks the deploy instead — safer but
    // means a rate-limited data source can also block otherwise-good entries.
    athGateFailMode: u.athGateFailMode === "closed" ? "closed" : "open",
    maxPumpPct1h: Number(u.autoStrategyMaxPumpPct1h ?? 20),
    // TGE play (opt-in): tokens younger than tgeMaxAgeHours get a very wide
    // range + max-hold clock, and are skipped on low-fee pools where the fee
    // tier can't cover launch volatility. null = off.
    tgeMaxAgeHours: u.tgeMaxAgeHours ?? null,
    tgeMinFeePct: Number(u.tgeMinFeePct ?? 5),
    tgeMaxHoldHours: Number(u.tgeMaxHoldHours ?? 8),
    // A — Supertrend dynamic range (Bid Ask and Chill): range = current price → 10% below supertrend
    supertrendRange: boolConfig(u.supertrendRange, false),
    // B — Drop-entry gate (Drop and bidask): only enter in dip zone [dropEntryMin%, dropEntryMax%]
    dropEntryGate: boolConfig(u.dropEntryGate, false),
    dropEntryMin: Number(u.dropEntryMin ?? -50),
    dropEntryMax: Number(u.dropEntryMax ?? -30),
  },

  indicators: {
    enabled: boolConfig(indicatorUserConfig.enabled, false),
    entryEnabled: boolConfig(indicatorUserConfig.entryEnabled, true),
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    // Per-mint response cache (429 hardening, SPOT_LOSS_ANALYSIS.md P2a):
    // repeated candidates within a screening cycle (or back-to-back cycles)
    // reuse the same fetch instead of re-hammering the data source.
    cacheTtlSec: Math.max(0, Number(indicatorUserConfig.cacheTtlSec ?? 150)),
    requireAllIntervals: boolConfig(indicatorUserConfig.requireAllIntervals, false),
    // Exit confirmations default strict: every interval must agree before a
    // chart exit fires (traindog lesson: 5m-only signal closed a +0.07% peak
    // into a -0.03% net loss). Entry keeps requireAllIntervals above.
    exitRequireAllIntervals: boolConfig(indicatorUserConfig.exitRequireAllIntervals, true),
    // Min PnL % before a chart exit may fire — below this, fees+slippage turn
    // the "profit take" into a loss. Stop loss owns the downside path.
    chartExitMinPnlPct: Number(indicatorUserConfig.chartExitMinPnlPct ?? 0.5),
    // RSI limit for the evil_panda_exit preset (RSI(2) > 90 per the thread) —
    // separate from rsiOverbought so the generic presets keep their own level.
    evilPandaRsiExit: Number(indicatorUserConfig.evilPandaRsiExit ?? 90),
    // Third evil_panda_exit trigger: first green MACD histogram bar after the
    // supertrend break (computed client-side from payload candles).
    evilPandaMacdExitEnabled: boolConfig(indicatorUserConfig.evilPandaMacdExitEnabled, false),
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Minimum global token fees (SOL) — floor or mcap-scaled (MeteoraFR: 10 SOL per $100k mcap).
 * @param {number} mcap — token market cap USD
 * @param {object} [screening] — defaults to config.screening
 */
export function minTokenFeesSolForMcap(mcap, screening = config.screening) {
  const floor = Number(screening.minTokenFeesSol ?? 10);
  if (screening.mcapScaledTokenFees === false) return floor;
  const m = Number(mcap);
  if (!Number.isFinite(m) || m <= 0) return floor;
  const per100k = Number(screening.minTokenFeesSolPer100kMcap ?? 10);
  return Math.max(floor, Math.ceil((m / 100_000) * per100k));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
/** Apply a flat user-config key onto the live config object (CONFIG_MAP sections). */
function applyFlatUserKey(fresh, key) {
  const n = (v) => (v === undefined ? undefined : Number(v));
  switch (key) {
    case "maxPositions":
      if (fresh.maxPositions !== undefined) config.risk.maxPositions = Math.round(Number(fresh.maxPositions));
      break;
    case "maxDeployAmount":
      if (fresh.maxDeployAmount != null) config.risk.maxDeployAmount = n(fresh.maxDeployAmount);
      break;
    case "deployAmountSol":
      if (fresh.deployAmountSol != null) config.management.deployAmountSol = n(fresh.deployAmountSol);
      break;
    case "gasReserve":
      if (fresh.gasReserve != null) config.management.gasReserve = n(fresh.gasReserve);
      break;
    case "minSolToOpen":
      if (fresh.minSolToOpen != null) config.management.minSolToOpen = n(fresh.minSolToOpen);
      break;
    case "positionSizePct":
      if (fresh.positionSizePct != null) config.management.positionSizePct = n(fresh.positionSizePct);
      break;
    case "dailyLossLimitUsd":
      if (fresh.dailyLossLimitUsd !== undefined) {
        config.management.dailyLossLimitUsd = fresh.dailyLossLimitUsd == null ? null : n(fresh.dailyLossLimitUsd);
      }
      break;
    case "noDeployAfterHour":
      if (fresh.noDeployAfterHour !== undefined) {
        config.schedule.noDeployAfterHour = fresh.noDeployAfterHour == null ? null : n(fresh.noDeployAfterHour);
      }
      break;
    case "noDeployBeforeHour":
      if (fresh.noDeployBeforeHour !== undefined) {
        config.schedule.noDeployBeforeHour = fresh.noDeployBeforeHour == null ? null : n(fresh.noDeployBeforeHour);
      }
      break;
    case "screeningIntervalMin":
      if (fresh.screeningIntervalMin != null) config.schedule.screeningIntervalMin = Math.round(n(fresh.screeningIntervalMin));
      break;
    case "managementIntervalMin":
      if (fresh.managementIntervalMin != null) config.schedule.managementIntervalMin = Math.round(n(fresh.managementIntervalMin));
      break;
    case "opportunityPollEnabled":
      if (fresh.opportunityPollEnabled !== undefined) config.opportunity.enabled = !!fresh.opportunityPollEnabled;
      break;
    case "autoStrategyEnabled":
      if (fresh.autoStrategyEnabled !== undefined) config.autoStrategy.enabled = !!fresh.autoStrategyEnabled;
      break;
    case "rugcheckTop10MaxPct":
      if (fresh.rugcheckTop10MaxPct != null) config.screening.rugcheckTop10MaxPct = n(fresh.rugcheckTop10MaxPct);
      break;
    case "screeningModel":
      if (fresh.screeningModel) config.llm.screeningModel = fresh.screeningModel;
      break;
    case "managementModel":
      if (fresh.managementModel) config.llm.managementModel = fresh.managementModel;
      break;
    case "generalModel":
      if (fresh.generalModel) config.llm.generalModel = fresh.generalModel;
      break;
    default:
      break;
  }
}

/**
 * Reload user-config.json into the in-memory config object.
 * Daemon calls this at the start of each screening/management cycle so CLI
 * `config set` changes apply without restart.
 */
export function reloadUserConfigFromDisk() {
  reloadScreeningThresholds();
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    for (const key of [
      "maxPositions", "maxDeployAmount", "deployAmountSol", "gasReserve", "minSolToOpen",
      "positionSizePct", "dailyLossLimitUsd", "noDeployAfterHour", "noDeployBeforeHour",
      "screeningIntervalMin", "managementIntervalMin", "opportunityPollEnabled",
      "autoStrategyEnabled", "rugcheckTop10MaxPct",
      "screeningModel", "managementModel", "generalModel",
    ]) {
      applyFlatUserKey(fresh, key);
    }
  } catch { /* ignore */ }
}

export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.mcapScaledTokenFees !== undefined) s.mcapScaledTokenFees = fresh.mcapScaledTokenFees;
    if (fresh.minTokenFeesSolPer100kMcap != null) s.minTokenFeesSolPer100kMcap = fresh.minTokenFeesSolPer100kMcap;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
