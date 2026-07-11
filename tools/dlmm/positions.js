/**
 * Position reads: open-position discovery + PnL (RPC-primary, Meteora-API
 * fallback), per-position PnL, any-wallet scans, pool search, active bin.
 * Also reconciles externally-closed positions into the learning data.
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { getDLMM, getConnection, getWallet, getPool } from "./sdk.js";
import {
  getCachedPositions,
  getFreshPositionsCache,
  getPositionsInflight,
  setPositionsCache,
  setPositionsInflight,
} from "./positions-cache.js";
import {
  safeNum,
  maybeNum,
  roundNum,
  deriveOpenPnlPct,
  deriveLpAgentPnlPct,
  getClosedPnlValue,
  getClosedPnlPct,
} from "./rules.js";
import {
  getTrackedPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
  syncOpenPositions,
} from "../../state.js";
import { recordPoolDeploy } from "../../pool-memory.js";
import { appendDecision } from "../../decision-log.js";
import { normalizeMint } from "../wallet.js";
import { computePositions, fetchDlmmPnlForPool } from "../pnl.js";
import { fetchWithTimeout, withTimeout } from "../../utils/fetch-timeout.js";

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  // Prefer the public-infra path (RPC + Jupiter + Meteora deposits) used by getMyPositions.
  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error) {
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

/**
 * Record positions that vanished on-chain without going through closePosition
 * (closed manually in the UI or by an external tool). Fetches the final PnL
 * from the Meteora closed-positions API and writes the close to the decision
 * log + pool memory so the trade isn't lost from the learning data.
 * Fire-and-forget from the getMyPositions sync path — never throws.
 */
async function handleExternalCloses(externallyClosed, walletAddress) {
  for (const pos of externallyClosed) {
    const reason = "closed externally (missing on-chain, manual close?)";
    let pnlUsd = null;
    let pnlPct = null;
    let feesUsd = pos.total_fees_claimed_usd || 0;
    const minutesHeld = pos.deployed_at
      ? Math.floor((Date.now() - new Date(pos.deployed_at).getTime()) / 60000)
      : null;

    try {
      if (pos.pool) {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${pos.pool}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find((p) => p.positionAddress === pos.position);
            if (posEntry) {
              pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : safeNum(posEntry.pnlUsd);
              pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
              break;
            }
          }
          if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
        }
        // FIX (Hermes): if the Meteora PnL fetch failed, fall back to the last
        // tracked in-state pnl_pct so recordPoolDeploy still sees a real PnL.
        // Without this, external_close_sync_missing closes with pnl_pct=null ->
        // isLossClose()=false -> loss cooldown never set -> bot re-deploys losers.
        if (pnlPct == null) {
          const tracked = getTrackedPosition(pos.position);
          if (tracked && tracked.pnl_pct != null) pnlPct = Number(tracked.pnl_pct);
        }
      }
    } catch (e) {
      log("external_close_warn", `Final PnL fetch failed for ${pos.position.slice(0, 8)}: ${e.message}`);
    }

    try {
      if (pos.pool) {
        recordPoolDeploy(pos.pool, {
          pool_name: pos.pool_name || pos.pool.slice(0, 8),
          deployed_at: pos.deployed_at,
          closed_at: pos.closed_at,
          pnl_pct: pnlPct,
          pnl_usd: pnlUsd,
          fees_earned_usd: feesUsd || null,
          minutes_held: minutesHeld,
          close_reason: reason,
          strategy: pos.strategy,
          volatility: pos.volatility,
        });
      }
      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: pos.pool,
        pool_name: pos.pool_name || (pos.pool ? pos.pool.slice(0, 8) : null),
        position: pos.position,
        summary: pnlPct != null ? `Closed externally at ${pnlPct.toFixed(2)}%` : "Closed externally (PnL unknown)",
        reason,
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
          exit_signal_type: "manual_or_external",
        },
      });
      log("external_close", `Recorded external close for ${pos.pool_name || pos.position.slice(0, 8)}: PnL ${pnlPct != null ? pnlPct.toFixed(2) + "%" : "unknown"}`);
    } catch (e) {
      log("external_close_warn", `Recording external close failed for ${pos.position.slice(0, 8)}: ${e.message}`);
    }
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, wallet_address = null } = {}) {
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force) {
    const fresh = getFreshPositionsCache();
    if (fresh) return fresh;
  }
  if (useLocalWallet && getPositionsInflight()) return getPositionsInflight();

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    // ── Primary path: public infra (on-chain RPC + Jupiter + Meteora deposits) ──
    // No LPAgent / agentmeridian dependency, so the poller runs aggressively on
    // fully public resources. Falls through to the Meteora-API path on any error.
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${config.pnl.rpcUrl})...`);
        // Hard timeout: a hung Helius RPC read would otherwise wedge the whole
        // management cycle. On timeout this throws → the catch below falls back
        // to the Meteora portfolio API instead of hanging.
        const rpcResult = await withTimeout(
          computePositions(walletAddress),
          config.pnl.rpcTimeoutMs,
          "RPC PnL read"
        );
        if (useLocalWallet) {
          const externallyClosed = syncOpenPositions(rpcResult.positions.map((p) => p.position));
          if (externallyClosed?.length) {
            handleExternalCloses(externallyClosed, walletAddress).catch((e) => log("external_close_warn", e.message));
          }
          setPositionsCache(rpcResult);
        }
        return rpcResult;
      } catch (error) {
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${error.message}`);
      }
    }

    // ── Fallback path: Meteora portfolio + /pnl APIs (no LPAgent) ──
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetchWithTimeout(portfolioUrl, {}, config.pnl.rpcTimeoutMs);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = {}; // LPAgent removed — Meteora binData only

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        // Gate PnL rules ONLY when the tick is genuinely unpriceable (no real number
        // from either method — e.g. missing deposits / data outage). Reported-vs-derived
        // divergence is normal noise on volatile pools, so it is logged but NOT gated —
        // gating on it froze all exits (stop-loss/trailing/close) and stranded positions.
        const pnlPctSuspicious = reportedPnlPct == null && derivedPnlPct == null;
        if (pnlPctSuspicious) {
          log("positions_warn", `Unpriceable pnl_pct for ${positionAddress.slice(0, 8)}: no valid reported/derived value this tick — PnL rules paused`);
        } else if (pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5)) {
          // Informational only — does not gate rules.
          log("positions_warn", `pnl_pct divergence for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)} (informational)`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      const externallyClosed = syncOpenPositions(positions.map(p => p.position));
      if (externallyClosed?.length) {
        handleExternalCloses(externallyClosed, walletAddress).catch((e) => log("external_close_warn", e.message));
      }
      setPositionsCache(result);
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) setPositionsInflight(null);
  }
  };

  if (useLocalWallet) {
    const inflight = loadPositions();
    setPositionsInflight(inflight);
    return inflight;
  }

  return loadPositions();
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Helpers ──────────────────────────────────────────────────
export async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = getCachedPositions()?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
