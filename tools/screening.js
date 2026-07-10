import fs from "fs";
import { config } from "../config.js";
import { repoPath } from "../repo-root.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import {
  getBaseMintCooldownReason,
  getPoolCooldownReason,
  isBaseMintOnCooldown,
  isPoolOnCooldown,
} from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { getGmgnTokenSecurity, getGmgnTokenTopHolders, hasGmgnApiKey } from "./gmgn.js";

const SCREENING_FETCH_TIMEOUT_MS = 10_000;

const DATAPI_JUP = "https://datapi.jup.ag/v1";

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
// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this reference
// window, so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

/**
 * Rank candidates for LLM shortlist.
 * fee/TVL is the strongest historical profit signal (Fase 2: >=1.0 avg +7.5% vs <0.2 +0.13%)
 * so we tier-boost high fee printers instead of a flat linear weight only.
 */
export function scoreCandidate(pool) {
  const feeActive = Number(pool.fee_active_tvl_ratio || 0);
  const feeTvl24h = Number(pool.fee_tvl_ratio ?? pool.fee_per_tvl_24h ?? 0);
  const feeSignal = Math.max(
    Number.isFinite(feeActive) ? feeActive : 0,
    Number.isFinite(feeTvl24h) ? feeTvl24h : 0,
  );
  let feeBoost = feeSignal * 1000;
  if (feeSignal >= 1.0) feeBoost += 5000;
  else if (feeSignal >= 0.5) feeBoost += 2000;
  else if (feeSignal >= 0.2) feeBoost += 500;
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeBoost + organic * 10 + volume / 100 + holders / 100;
}

// Deploy path is single-sided SOL into tokenY (amount_y). Quote MUST be WSOL.
// Token-2022 *base* is fine when quote=SOL (Jotchua-SOL live deploys succeeded;
// @meteora-ag/dlmm 1.9.11 supports T22). The old blanket T22 skip was a misdiagnosis
// of KINS-USDC 0x1 (amount_y treated as USDC → Tokenkeg insufficient funds).
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** True when pool quote (tokenY) is native SOL / WSOL. */
export function isSolQuotePool(pool) {
  const mint =
    pool?.quote?.mint ||
    pool?.quote_mint ||
    pool?.token_y?.address ||
    pool?.token_y?.mint ||
    pool?.tokenY?.mint ||
    null;
  return mint === SOL_MINT;
}

/**
 * Drop pools the local SOL-only deploy path cannot open:
 * non-SOL quote (USDC etc). Token-2022 base is allowed.
 */
export function filterUnsupportedDeployPools(eligible, filteredOut) {
  if (!eligible?.length) return;
  const kept = [];
  let removed = 0;
  for (const p of eligible) {
    if (!isSolQuotePool(p)) {
      removed++;
      const qSym = p.quote?.symbol || p.token_y?.symbol || "non-SOL";
      pushFilteredReason(
        filteredOut,
        p,
        `quote is not SOL (single-sided SOL deploy unsupported for ${qSym} pairs)`,
      );
      log("screening", `Filtered non-SOL quote ${p.name || p.pool?.slice?.(0, 8)} (${qSym})`);
    } else {
      kept.push(p);
    }
  }
  if (removed > 0) {
    eligible.splice(0, eligible.length, ...kept);
    log("screening", `Non-SOL quote pre-filter removed ${removed} candidate(s)`);
  }
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity   → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity        → unique_lps + positions_created
 *   3. Fees paid to LPs          → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity                 → active_tvl (log floor — dust pools can't win on ratios)
 * Efficiency only (no momentum/change_pct), per design. Targets are configurable so the
 * score can be calibrated; each sub-score saturates at its target.
 *
 * The volume/fee/LP inputs are measured over `config.screening.timeframe`, so they are
 * normalized to a fixed 30m reference window before scoring — the targets are expressed
 * in 30m terms and stay valid even if the timeframe changes (5m, 1h, 24h, …). Liquidity
 * is a level, not a rate, so it is not scaled.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,    // (30m) volume/active_tvl that earns a full trading sub-score
    targetLpCount = 40,     // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,  // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

/**
 * Volatility-widened bin-step window (mirrors volatilityScaledBins' vol/5
 * pivot in strategy-router.js). Opt-in via binStepVolatilityScalingEnabled:
 * volatile pools accept a wider [minBinStep, maxBinStep] window than the
 * static config alone. Widening saturates at ±50% of each bound (vol >= 5)
 * and the min is floored at 1 so the window can never invert or collapse.
 * discoverPools' API-level pre-filter keeps the static bounds as the outer
 * fetch envelope; this only relaxes the post-fetch checks.
 */
export function volatilityScaledBinStepWindow(volatility, screening = config.screening) {
  const lo = numeric(screening.minBinStep);
  const hi = numeric(screening.maxBinStep);
  const flat = { minBinStep: lo, maxBinStep: hi };
  if (screening.binStepVolatilityScalingEnabled !== true) return flat;
  const vol = Number(volatility);
  if (!Number.isFinite(vol) || vol <= 0) return flat;
  const widen = Math.min(vol / 5, 1) * 0.5;
  return {
    minBinStep: lo == null ? null : Math.max(1, Math.floor(lo * (1 - widen))),
    maxBinStep: hi == null ? null : Math.ceil(hi * (1 + widen)),
  };
}

export function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  // Volatility: if API/GMGN didn't supply it (e.g. GMGN banned), fall back to a
  // moderate default so deploy can still proceed (Evil-Panda-style: market-make in any condition).
  const volatility = numeric(pool?.volatility) || 2;
  pool.volatility = volatility; // normalize so later checks see the defaulted value
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  const binStepWindow = volatilityScaledBinStepWindow(volatility, s);
  if (binStep == null || binStep < binStepWindow.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${binStepWindow.minBinStep}`;
  if (binStep > binStepWindow.maxBinStep) return `bin_step ${binStep} above maxBinStep ${binStepWindow.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (s.minEstimatedSharePct != null && pool?.estimated_share_pct != null && pool.estimated_share_pct < s.minEstimatedSharePct) {
    return `estimated share ${pool.estimated_share_pct.toFixed(2)}% below minEstimatedSharePct ${s.minEstimatedSharePct}%`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

const RUGCHECK_BATCH = 10;
const RUGCHECK_BATCH_DELAY_MS = 250;
const RUGCHECK_MAX_RETRY = 2;

async function rugCheckMint(mint, attempt = 0) {
  if (!mint) return { pass: true, rug_score: null };
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Retry on 429 (rate-limit) instead of spamming — avoids false-pass
    if (res.status === 429 && attempt < RUGCHECK_MAX_RETRY) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return rugCheckMint(mint, attempt + 1);
    }
    if (!res.ok) throw new Error(`rugcheck HTTP ${res.status}`);
    const data = await res.json();
    if (data.rugged) return { pass: false, reason: "rugcheck: token is rugged" };
    if ((data.score || 0) > 50_000) return { pass: false, reason: `rugcheck: score too high (${data.score})` };
    const topHolders = data.topHolders || [];
    const top10pct = topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || h.percentage || 0), 0);
    const top10Max = Number(config.screening.rugcheckTop10MaxPct ?? 60);
    if (top10pct > top10Max) return { pass: false, reason: `rugcheck: top10 holders ${top10pct.toFixed(1)}% > ${top10Max}%` };
    return { pass: true, rug_score: data.score || 0 };
  } catch (error) {
    // FAIL-CLOSED: rugcheck outages must NOT deploy unknown tokens (anti false-pass)
    log("screening", `Rugcheck API error for ${mint.slice(0, 8)}: ${error.message} — FAIL-CLOSED (reject)`);
    return { pass: false, reason: `rugcheck unavailable: ${error.message}` };
  }
}

async function rugCheckCandidates(pools) {
  const results = new Map();
  // Batch to avoid hammering rugcheck.xyz with 500 parallel calls (429 risk + false-pass)
  for (let i = 0; i < pools.length; i += RUGCHECK_BATCH) {
    const batch = pools.slice(i, i + RUGCHECK_BATCH);
    await Promise.all(
      batch.map(async (pool) => {
        const mint = getPoolBaseMint(pool) || pool?.base?.mint;
        const key = pool.pool || pool.pool_address;
        results.set(key, await rugCheckMint(mint));
      }),
    );
    if (i + RUGCHECK_BATCH < pools.length) {
      await new Promise((r) => setTimeout(r, RUGCHECK_BATCH_DELAY_MS));
    }
  }
  return results;
}

/**
 * Concentration Paradox Override (CPO)
 * -----------------------------------
 * Re-accepts a candidate that the rugcheck gate rejected SOLELY for high top-10
 * holder concentration (top10 > rugcheckTop10MaxPct), when on-chain fundamentals
 * are clean AND smart-money presence is strong. This restores the "escape hatch"
 * that lets legit early pumps (dev=0, LP burned, mint/freeze renounced, many SM
 * wallets) through the hard concentration gate instead of being false-rejected.
 *
 * Requires a GMGN API key (uses /v1/token/security + top holders). If the key is
 * absent or any lookup fails, the override is skipped and the token STAYS
 * rejected (fail-closed — never deploys unknown tokens).
 *
 * Maps the original 6-condition checklist to data available in Meridian:
 *   1. dev_holdings_pct == 0      → dev_token_burn_ratio >= 0.95 (proxy)
 *   2. lp_burned == true          → burn_status == "burned" || burn_ratio >= 0.95
 *   3. mint_renounced == true     → security.mint_renounced === true
 *   4. freeze_renounced == true   → security.freeze_renounced === true
 *   (5+6) SM count >= minSmCount  → count of top holders tagged smart_degen/renowned
 *   Bonus guard: no GMGN alert (is_show_alert === false) and no rug flags.
 */
async function concentrationParadoxOverride(mint, reason) {
  const sec = config.screening?.security ?? config.security;
  if (!sec || sec.concentrationParadoxOverrideEnabled !== true) return { override: false, reason: "disabled" };
  if (!mint || !hasGmgnApiKey()) {
    return { override: false, reason: "gmgn key unavailable" };
  }
  // HARD GUARD: never override when top-10 holder concentration is extreme
  // (>100% means a single entity / whale cluster controls the entire float and
  // can dump at will — that is not a "paradox", it is a genuine rug risk).
  const top10Match = /top10 holders?\s+([\d.]+)%\s*>/i.exec(reason || "");
  const top10pct = top10Match ? Number(top10Match[1]) : null;
  if (top10pct != null && top10pct > 100) {
    return { override: false, reason: `top10 ${top10pct}% > 100% (whale-dominated, hard block)`, top10pct };
  }
  const minSmCount = Number(sec.concentrationParadoxMinSmCount ?? 8);

  try {
    const [security, holders] = await Promise.all([
      getGmgnTokenSecurity(mint),
      getGmgnTokenTopHolders(mint, { limit: 100 }).catch(() => null),
    ]);
    if (!security) return { override: false, reason: "gmgn security lookup failed" };

    const mintRenounced = security.mint_renounced === true;
    const freezeRenounced = security.freeze_renounced === true;
    const lpBurned =
      security.burn_status === "burned" ||
      (Number(security.burn_ratio) ?? 0) >= 0.95;
    const devBurned = (Number(security.dev_token_burn_ratio) ?? 0) >= 0.95;
    const noAlert = security.is_show_alert !== true;
    const noRugFlags =
      !Array.isArray(security.flags) ||
      security.flags.filter((f) => /rug|scam|honeypot|mint/i.test(String(f))).length === 0;

    // Smart-money count from tagged top holders (renowned + smart_degen proxy SM).
    let smCount = 0;
    if (holders?.holders?.length) {
      for (const h of holders.holders) {
        const tags = Array.isArray(h.tags) ? h.tags.map((t) => String(t).toLowerCase()) : [];
        if (tags.includes("smart_degen") || tags.includes("renowned")) smCount += 1;
      }
    }

    const checks = {
      mintRenounced,
      freezeRenounced,
      lpBurned,
      devBurned,
      noAlert,
      noRugFlags,
      smCountOk: smCount >= minSmCount,
    };
    const passed = Object.values(checks).every(Boolean);

    if (!passed) {
      return {
        override: false,
        reason: "fundamentals/SM insufficient",
        checks,
        smCount,
      };
    }

    log(
      "screening",
      `[CONCENTRATION_PARADOX_OVERRIDE] ${mint.slice(0, 8)} passed — devBurned=${devBurned} lpBurned=${lpBurned} renounced(m/f)=${mintRenounced}/${freezeRenounced} smCount=${smCount} (rugcheck reason was: ${reason})`,
    );
    return { override: true, checks, smCount };
  } catch (error) {
    log("screening", `[CONCENTRATION_PARADOX_OVERRIDE] error for ${mint?.slice(0, 8)}: ${error.message} — stay rejected`);
    return { override: false, reason: `error: ${error.message}` };
  }
}

const DISCORD_SIGNALS_FILE = repoPath("discord-signals.json");

async function fetchRemoteDiscordSignalCandidates() {
  const res = await fetchWithTimeout(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  }, SCREENING_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchLocalDiscordSignalCandidates(timeframe) {
  if (!fs.existsSync(DISCORD_SIGNALS_FILE)) return [];
  let signals = [];
  try {
    signals = JSON.parse(fs.readFileSync(DISCORD_SIGNALS_FILE, "utf8"));
  } catch {
    return [];
  }
  const pending = signals.filter((s) => s.status === "pending" && s.pool_address);
  if (pending.length === 0) return [];

  const results = await Promise.allSettled(
    pending.map(async (signal) => {
      const discoveryPool = await fetchPoolDiscoveryDetail({
        poolAddress: signal.pool_address,
        timeframe,
      });
      if (!discoveryPool?.pool_address) return null;
      return {
        discovery_pool: discoveryPool,
        source_count: 1,
        seen_count: 1,
        first_seen_at: signal.queued_at || null,
        last_seen_at: signal.queued_at || null,
        local_signal_id: signal.id || null,
      };
    }),
  );

  const candidates = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);

  if (candidates.length > 0) {
    log("screening", `Loaded ${candidates.length} local Discord signal(s) from discord-signals.json`);
  }
  return candidates;
}

async function fetchDiscordSignalCandidates(timeframe) {
  const remote = await fetchRemoteDiscordSignalCandidates().catch((error) => {
    log("screening", `Remote Discord signals unavailable: ${error.message}`);
    return [];
  });
  const local = await fetchLocalDiscordSignalCandidates(timeframe);

  const byPool = new Map();
  for (const candidate of [...remote, ...local]) {
    const poolAddress = candidate?.discovery_pool?.pool_address;
    if (!poolAddress) continue;
    const existing = byPool.get(poolAddress);
    if (!existing) {
      byPool.set(poolAddress, candidate);
      continue;
    }
    byPool.set(poolAddress, {
      ...existing,
      source_count: Math.max(existing.source_count || 1, candidate.source_count || 1),
      seen_count: Math.max(existing.seen_count || 1, candidate.seen_count || 1),
      last_seen_at: candidate.last_seen_at || existing.last_seen_at,
    });
  }
  return Array.from(byPool.values());
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetchWithTimeout(url, {}, SCREENING_FETCH_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetchWithTimeout(url, {}, SCREENING_FETCH_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetchWithTimeout(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`, {}, SCREENING_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetchWithTimeout(url, {}, SCREENING_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = config.screening?.discoveryPageSize ?? 100,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates(s.timeframe).catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot
      await refreshDiscordOnlyPools(rawPools, s.timeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, s.timeframe);
      }
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetchWithTimeout(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`, {}, SCREENING_FETCH_TIMEOUT_MS)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
/**
 * Metlex Terminal candidate feed — load parsed signals from metlex-signals.json.
 * Fail-safe: returns [] if file missing/unreadable so screening is never blocked.
 */
function loadMetlexSignals() {
  try {
    const p = repoPath("metlex-signals.json");
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log("screening", `Metlex feed load failed: ${e.message}`);
    return [];
  }
}

export async function getTopCandidates({ limit = 10, timeframe = null } = {}) {
  const { config } = await import("../config.js");
  const discovery = await discoverPools({ page_size: config.screening?.discoveryPageSize ?? 100 });
  const { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);
  // Live SOL price (5-min cache) — a hardcoded constant overstated est share
  // ~1.8x at $81 SOL. null price → estimateSharePct returns null (metric absent).
  const { getSolPriceUsd } = await import("./wallet.js");
  const solPriceUsd = await getSolPriceUsd();

  const eligible = pools
    .map((p) => ({
      ...p,
      estimated_share_pct: estimateSharePct({
        deployAmountSol: config.management.deployAmountSol,
        solPriceUsd,
        poolTvlUsd: Number(p.active_tvl ?? p.tvl ?? 0),
      }),
    }))
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        const reason = getPoolCooldownReason(p.pool) || "pool cooldown active";
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)}): ${reason}`);
        pushFilteredReason(filteredOut, p, reason);
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        const reason = getBaseMintCooldownReason(p.base?.mint) || "token cooldown active";
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}): ${reason}`);
        pushFilteredReason(filteredOut, p, reason);
        return false;
      }
      if (config.screening.minEstimatedSharePct != null && p.estimated_share_pct != null && p.estimated_share_pct < config.screening.minEstimatedSharePct) {
        pushFilteredReason(filteredOut, p, `estimated share ${p.estimated_share_pct.toFixed(2)}% below minEstimatedSharePct ${config.screening.minEstimatedSharePct}%`);
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  // ─── Metlex Terminal candidate feed boost ──────────────────────────────
  // Pools whose base mint matches a recent Metlex "New DLMM Found" signal get
  // priority boost (sorted to top) but STILL pass all GMGN/rugcheck gates in
  // index.js. Fail-safe: no metlex-signals.json → no effect.
  // Dedupe by base mint so the SAME token never gets boosted twice (no twin coins).
  const metlex = loadMetlexSignals();
  if (metlex.length) {
    const metlexByMint = new Map(metlex.map((m) => [m.address, m]));
    const boostedMints = new Set();
    let boosted = 0;
    for (const p of eligible) {
      const mint = p.base?.mint || p.base_mint;
      if (mint && metlexByMint.has(mint) && !boostedMints.has(mint)) {
        p.metlex_boost = true;
        p.metlex_signal = metlexByMint.get(mint);
        boostedMints.add(mint);
        boosted++;
      }
    }
    if (boosted > 0) {
      eligible.sort(
        (a, b) =>
          (b.metlex_boost ? 1 : 0) - (a.metlex_boost ? 1 : 0) ||
          scoreCandidate(b) - scoreCandidate(a)
      );
      log("screening", `Metlex feed boosted ${boosted} unique candidate(s) to top priority (deduped by mint)`);
    }
  }

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Dev blocklist check — filter pools whose creator is on the blocklist
  if (eligible.length > 0) {
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via dev blocklist`);
  }

  // SOL-quote hard filter BEFORE rugcheck/LLM — amount_y path only deposits into tokenY.
  // Allows Token-2022 base when quote is SOL. Drops USDC/other quote pairs (KINS-USDC class).
  if (eligible.length > 0) {
    filterUnsupportedDeployPools(eligible, filteredOut);
  }

  // Rugcheck gate — on-chain safety screen on the trimmed candidate set only
  // (fails open on API errors; hard-rejects rugged / extreme-score tokens)
  if (config.screening.rugcheckEnabled !== false && eligible.length > 0) {
    const rugResults = await rugCheckCandidates(eligible);
    const before = eligible.length;
    const overrideCandidates = [];
    const rugFiltered = eligible.filter((p) => {
      const check = rugResults.get(p.pool) ?? { pass: true, rug_score: null };
      p.rug_score = check.rug_score ?? null;
      if (check.pass) return true;
      // Concentration-only failure → candidate for paradox override
      const isConcentrationOnly = /top10 holders .*% >/.test(check.reason);
      if (isConcentrationOnly) {
        overrideCandidates.push({ pool: p, reason: check.reason });
        return false; // tentatively drop; re-added below if override passes
      }
      pushFilteredReason(filteredOut, p, check.reason);
      log("screening", `Rugcheck rejected ${p.name} (${p.pool?.slice(0, 8)}): ${check.reason}`);
      return false;
    });

    // Try Concentration Paradox Override on concentration-only rejects
    if (overrideCandidates.length > 0 && config.screening?.security?.concentrationParadoxOverrideEnabled === true) {
      const rescued = [];
      await Promise.all(
        overrideCandidates.map(async ({ pool, reason }) => {
          const mint = getPoolBaseMint(pool) || pool?.base?.mint;
          const result = await concentrationParadoxOverride(mint, reason);
          if (result.override) {
            pool.paradox_override = true;
            pool.cpo_checks = result.checks;
            pool.cpo_sm_count = result.smCount;
            rescued.push(pool);
          } else {
            // stays rejected — record original rugcheck reason
            pushFilteredReason(filteredOut, pool, reason);
            log("screening", `Rugcheck rejected ${pool.name} (${pool.pool?.slice(0, 8)}): ${reason} [CPO skip: ${result.reason}]`);
          }
        }),
      );
      if (rescued.length > 0) {
        rugFiltered.push(...rescued);
        log("screening", `[CONCENTRATION_PARADOX_OVERRIDE] rescued ${rescued.length} candidate(s) past concentration gate`);
      }
    } else {
      // no override configured → keep original rejection reasons
      for (const { pool, reason } of overrideCandidates) {
        pushFilteredReason(filteredOut, pool, reason);
        log("screening", `Rugcheck rejected ${pool.name} (${pool.pool?.slice(0, 8)}): ${reason}`);
      }
    }

    eligible.splice(0, eligible.length, ...rugFiltered);
    if (eligible.length < before) log("screening", `Rugcheck removed ${before - eligible.length} candidate(s)`);
  }

  if (config.indicators.enabled && config.indicators.entryEnabled !== false && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Estimated share of pool TVL our deploy would take, in percent (web3probe
 * competitiveness insight). Informative at current position sizes — with a
 * 0.5 SOL deploy against a $20k+ TVL floor the share tops out around 0.2%,
 * so the optional minEstimatedSharePct filter should stay off until the
 * wallet is 10-20x larger.
 */
export function estimateSharePct({ deployAmountSol, solPriceUsd, poolTvlUsd }) {
  const amount = Number(deployAmountSol);
  const price = Number(solPriceUsd);
  const tvl = Number(poolTvlUsd);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(tvl) || tvl <= 0) return null;
  return Math.round(((amount * price) / tvl) * 10000) / 100;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    unique_lps_change_pct: fix(p.unique_lps_change_pct, 1),
    positions_created: p.positions_created,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
