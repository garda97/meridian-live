import { config } from "../config.js";

/**
 * Discord signal pre-check pipeline
 * Stages: dedup → blacklist → pool resolution → rug check → deployer check → fees check → screening gate
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

function loadScreeningConfig() {
  return config.screening;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function includesCaseInsensitive(list, value) {
  if (!Array.isArray(list) || !value) return false;
  const needle = String(value).toLowerCase();
  return list.some((item) => String(item).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  return pool?.base_token_launchpad || pool?.token_x?.launchpad || pool?.token_x?.launchpad_platform || null;
}

function screeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const holders = numeric(pool?.base_token_holders ?? base?.holder_count ?? base?.holders);
  const volume = numeric(pool?.volume ?? pool?.[`volume_${s.timeframe}`]);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const binStep = numeric(pool?.bin_step);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  let volatility = numeric(pool?.volatility ?? pool?.[`volatility_${s.timeframe}`]);
  // Volatility fallback: if API/GMGN didn't supply it, use moderate default
  // (Evil-Panda-style: market-make in any condition). Only blocks if truly absent after fallback.
  if (volatility == null || volatility <= 0) volatility = 2;
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
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (volatility == null || volatility <= 0) return `volatility ${volatility ?? "unknown"} is unusable`;
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) return `blocked launchpad (${launchpad})`;
  if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0 && launchpad && !includesCaseInsensitive(s.allowedLaunchpads, launchpad)) {
    return `launchpad ${launchpad} not in allow-list`;
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

// In-memory dedup: address → timestamp
const recentSeen = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Stage 1: Dedup — reject if seen in last 10 minutes
export function dedupCheck(address) {
  const now = Date.now();
  // Clean old entries
  for (const [k, ts] of recentSeen.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) recentSeen.delete(k);
  }
  if (recentSeen.has(address)) {
    return { pass: false, reason: "dedup: seen in last 10 minutes" };
  }
  recentSeen.set(address, now);
  return { pass: true };
}

// Stage 2: Token blacklist — reject if mint is blacklisted
export function blacklistCheck(mint) {
  const file = path.join(ROOT, "token-blacklist.json");
  if (!fs.existsSync(file)) return { pass: true };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data[mint]) {
      return { pass: false, reason: `blacklisted: ${data[mint].reason || "no reason"}` };
    }
  } catch { /* parse error, pass */ }
  return { pass: true };
}

// Stage 3: Pool resolution
// Try address directly as Meteora pool, then try as mint via DexScreener
export async function resolvePool(address) {
  // Try as pool address directly
  try {
    const res = await axios.get(`https://dlmm.datapi.meteora.ag/pools/${address}`, { timeout: 8000 });
    const pool = res.data;
    if (pool?.address || pool?.pubkey || pool?.pool_address) {
      const poolAddr = pool.address || pool.pubkey || pool.pool_address || address;
      const baseMint = pool.mint_x || pool.base_mint || pool.token_x?.address;
      const symbol = pool.name?.split("-")[0] || pool.token_x?.symbol || "?";
      const createdAt = pool.created_at || pool.pool_created_at || pool.token_x?.created_at;
      const tokenAgeMinutes = createdAt ? Math.round((Date.now() - createdAt) / 60000) : null;
      return { pass: true, pool_address: poolAddr, base_mint: baseMint, symbol, source: "meteora_direct", token_age_minutes: tokenAgeMinutes };
    }
  } catch { /* not a pool, try as token mint */ }

  // Try as token mint via DexScreener → find Meteora DLMM pools
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${address}`, { timeout: 8000 });
    const pairs = res.data?.pairs || [];
    const meteoraPairs = pairs.filter(p =>
      p.dexId === "meteora-dlmm" &&
      (p.baseToken?.address === address || p.quoteToken?.address === address)
    );
    if (meteoraPairs.length === 0) {
      return { pass: false, reason: "no Meteora DLMM pool found for this token" };
    }
    // Pick highest TVL
    const best = meteoraPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const pairCreated = best.pairCreatedAt ? new Date(best.pairCreatedAt).getTime() : null;
    const tokenAgeMinutes = pairCreated ? Math.round((Date.now() - pairCreated) / 60000) : null;
    return {
      pass: true,
      pool_address: best.pairAddress,
      base_mint: best.baseToken?.address,
      symbol: best.baseToken?.symbol || "?",
      source: "dexscreener",
      token_age_minutes: tokenAgeMinutes,
    };
  } catch (e) {
    return { pass: false, reason: `pool resolution failed: ${e.message}` };
  }
}

// Stage 4: Rug check via rugcheck.xyz
export async function rugCheck(mint) {
  if (!mint) return { pass: true, rug_score: null }; // can't check without mint
  try {
    const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 10000 });
    const data = res.data;
    if (data.rugged) return { pass: false, reason: "rugcheck: token is rugged" };
    if ((data.score || 0) > 50000) return { pass: false, reason: `rugcheck: score too high (${data.score})` };
    // Top 10 holders check from rugcheck
    const topHolders = data.topHolders || [];
    const top10pct = topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || h.percentage || 0), 0);
    if (top10pct > 60) return { pass: false, reason: `rugcheck: top10 holders ${top10pct.toFixed(1)}% > 60%` };
    return { pass: true, rug_score: data.score || 0 };
  } catch (e) {
    // RugCheck API down or unknown token — warn but don't block
    console.warn(`  [rugcheck] API error for ${mint}: ${e.message} — passing`);
    return { pass: true, rug_score: null };
  }
}

// Stage 5: Deployer blacklist
export async function deployerCheck(poolAddress) {
  const file = path.join(ROOT, "deployer-blacklist.json");
  if (!fs.existsSync(file)) return { pass: true };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const blocked = data.addresses || [];
    if (blocked.length === 0) return { pass: true };

    // Fetch pool creator from Meteora API
    const res = await axios.get(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`, { timeout: 8000 });
    const creator = res.data?.creator || res.data?.creator_address;
    if (creator && blocked.includes(creator)) {
      return { pass: false, reason: `deployer blacklisted: ${creator}` };
    }
  } catch { /* can't check, pass */ }
  return { pass: true };
}

// Stage 6: Global fees check — priority + jito tips via Jupiter ChainInsight API
// Mcap-scaled threshold from config (MeteoraFR: 10 SOL per $100k mcap)
export async function feesCheck(mint) {
  if (!mint) return { pass: true, global_fees_sol: null };

  const screening = config.screening;

  const minFeesForMcap = (mcap) => {
    const floor = Number(screening.minTokenFeesSol ?? 10);
    if (screening.mcapScaledTokenFees === false) return floor;
    const m = Number(mcap);
    if (!Number.isFinite(m) || m <= 0) return floor;
    const per100k = Number(screening.minTokenFeesSolPer100kMcap ?? 10);
    return Math.max(floor, Math.ceil((m / 100_000) * per100k));
  };

  try {
    const res = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${mint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tokens = Array.isArray(data) ? data : [data];
    const token = tokens.find(t => t.id === mint) || tokens[0];
    const globalFees = token?.fees != null ? parseFloat(token.fees) : null;
    const mcap = token?.mcap ?? token?.fdv ?? null;
    const minFeesSol = minFeesForMcap(mcap);

    if (globalFees === null) {
      console.warn(`  [fees] No fee data for ${mint} — passing`);
      return { pass: true, global_fees_sol: null };
    }
    if (globalFees < minFeesSol) {
      return { pass: false, reason: `global fees too low: ${globalFees.toFixed(2)} SOL < ${minFeesSol} SOL threshold${mcap != null ? ` (mcap $${Math.round(mcap)})` : ""}` };
    }
    return { pass: true, global_fees_sol: globalFees };
  } catch (e) {
    console.warn(`  [fees] Jupiter API error: ${e.message} — passing`);
    return { pass: true, global_fees_sol: null };
  }
}

// Stage 7: Screening gate — same thresholds as main screener before queueing
export async function screeningGateCheck(poolAddress) {
  const s = loadScreeningConfig();
  try {
    const url = `${POOL_DISCOVERY_BASE}/pools?` +
      `page_size=1` +
      `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
      `&timeframe=${s.timeframe}` +
      `&category=${s.category}`;
    const res = await axios.get(url, { timeout: 10_000 });
    const pool = (res.data?.data || [])[0];
    if (!pool) return { pass: false, reason: "pool not found in discovery API" };
    const reason = screeningRejectReason(pool, s);
    if (reason) return { pass: false, reason: `screening: ${reason}` };
    return { pass: true };
  } catch (e) {
    console.warn(`  [screening] discovery API error: ${e.message} — passing`);
    return { pass: true };
  }
}

function rejectStage(stage, result, pool = null) {
  const { pass: _pass, ...stageRest } = result;
  const { pass: _poolPass, ...poolRest } = pool || {};
  return { pass: false, ...poolRest, ...stageRest };
}

// Run the full pipeline
export async function runPreChecks(address) {
  console.log(`\n[pre-check] ${address}`);

  const dedup = dedupCheck(address);
  if (!dedup.pass) { console.log(`  REJECT [dedup] ${dedup.reason}`); return { pass: false, ...dedup }; }
  console.log(`  OK [dedup]`);

  const bl = blacklistCheck(address);
  if (!bl.pass) { console.log(`  REJECT [blacklist] ${bl.reason}`); return { pass: false, ...bl }; }
  console.log(`  OK [blacklist]`);

  const pool = await resolvePool(address);
  if (!pool.pass) { console.log(`  REJECT [pool] ${pool.reason}`); return { pass: false, ...pool }; }
  console.log(`  OK [pool] → ${pool.pool_address} (${pool.symbol}, via ${pool.source})`);

  // Also blacklist-check the resolved mint
  if (pool.base_mint && pool.base_mint !== address) {
    const bl2 = blacklistCheck(pool.base_mint);
    if (!bl2.pass) { console.log(`  REJECT [blacklist-mint] ${bl2.reason}`); return { pass: false, ...bl2 }; }
  }

  const rug = await rugCheck(pool.base_mint);
  if (!rug.pass) { console.log(`  REJECT [rug] ${rug.reason}`); return rejectStage("rug", rug, pool); }
  console.log(`  OK [rug] score=${rug.rug_score ?? "n/a"}`);

  const deployer = await deployerCheck(pool.pool_address);
  if (!deployer.pass) { console.log(`  REJECT [deployer] ${deployer.reason}`); return rejectStage("deployer", deployer, pool); }
  console.log(`  OK [deployer]`);

  const fees = await feesCheck(pool.base_mint);
  if (!fees.pass) { console.log(`  REJECT [fees] ${fees.reason}`); return rejectStage("fees", fees, pool); }
  console.log(`  OK [fees] global_fees=${fees.global_fees_sol ?? "n/a"} SOL`);

  const screening = await screeningGateCheck(pool.pool_address);
  if (!screening.pass) { console.log(`  REJECT [screening] ${screening.reason}`); return rejectStage("screening", screening, pool); }
  console.log(`  OK [screening] passed user-config thresholds`);

  console.log(`  PASS → queuing signal (token age: ${pool.token_age_minutes ?? "unknown"} min)`);
  return {
    pass: true,
    pool_address: pool.pool_address,
    base_mint: pool.base_mint,
    symbol: pool.symbol,
    rug_score: rug.rug_score,
    total_fees_sol: fees.global_fees_sol,
    token_age_minutes: pool.token_age_minutes,
  };
}
