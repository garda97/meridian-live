/**
 * deployPosition: open a new DLMM LP position. Validates args/cooldowns,
 * resolves the bin range, refuses ranges that would pay non-refundable
 * bin-array rent, then runs the standard (≤69 bins) or wide multi-tx path
 * behind the 0x1774 retry ladder, and records state + decision on success.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../../config.js";
import { log } from "../../logger.js";
import { getDLMM, getConnection, getWallet, getPool, sendAndConfirmTransaction } from "./sdk.js";
import {
  assertRangeDoesNotRequireBinArrayInitialization,
  assertNoInitializeBinArrayInstructions,
  signSerializedTransactions,
  normalizeExecutionSignatures,
} from "./tx-safety.js";
import { isBinSlippageError, planBinSlippageRetry } from "./rules.js";
import { invalidatePositionsCache } from "./positions-cache.js";
import { getMyPositions } from "./positions.js";
import { trackPosition } from "../../state.js";
import {
  addPoolNote,
  getBaseMintCooldownReason,
  getPoolCooldownReason,
  isBaseMintOnCooldown,
  isPoolOnCooldown,
} from "../../pool-memory.js";
import { getWalletBalances, normalizeMint } from "../wallet.js";
import { appendDecision } from "../../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "../agent-meridian.js";
import { getAndClearStagedSignals } from "../../signal-tracker.js";

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

/** Compact holder-audit block for deploy decision metrics, from staged screening signals. */
function buildHolderAuditSnapshot(snapshot) {
  if (!snapshot) return null;
  const audit = {
    top10_pct: snapshot.top10_pct ?? null,
    bot_pct: snapshot.bot_pct ?? null,
    bundler_pct: snapshot.bundler_pct ?? null,
    smart_degen_count: snapshot.smart_degen_count ?? null,
    organic_score: snapshot.organic_score ?? null,
    fresh_wallet_holder_pct: snapshot.fresh_wallet_holder_pct ?? null,
    bundled_wallet_holder_pct: snapshot.bundled_wallet_holder_pct ?? null,
  };
  return Object.values(audit).some((v) => v != null) ? audit : null;
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  // entry market conditions (injected by executor safety checks)
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
  // auto-strategy plan risk score (injected by applyPendingPlanToDeployArgs)
  oor_risk,
  // TGE play flag (injected by applyPendingPlanToDeployArgs) — arms the max-hold close rule
  tge,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    const reason = getPoolCooldownReason(pool_address) || "pool cooldown active";
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping (${reason})`);
    return { success: false, error: `Pool on cooldown — ${reason}. Try a different pool.` };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    const reason = getBaseMintCooldownReason(baseMint) || "token cooldown active";
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy (${reason})`);
    return { success: false, error: `Token on cooldown — ${reason}. Try a different token.` };
  }
  // The cached DLMM object can hold lbPair state up to 5 min old, and the SDK
  // passes lbPair.activeId as the on-chain slippage reference — a stale value
  // is exactly what triggers 0x1774 ExceededBinSlippageTolerance.
  try {
    await pool.refetchStates();
  } catch (error) {
    log("deploy", `refetchStates failed (${error.message}) — continuing with cached pool state`);
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Token-only deploys are not supported yet. Use amount_y/amount_sol with amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  const allowsUpsideBins = activeStrategy === "spot" || activeStrategy === "curve";
  if (isSingleSidedSol && !allowsUpsideBins && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL bid_ask deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol && !allowsUpsideBins) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol && !allowsUpsideBins
    ? activeBin.binId
    : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && !allowsUpsideBins && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL bid_ask deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : activeStrategy === "curve" ? "Curve" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      invalidatePositionsCache();
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      const signalSnapshot = getAndClearStagedSignals(pool_address, baseMint);
      if (positionAddress) {
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
          signal_snapshot: signalSnapshot,
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
          tge: tge === true || undefined,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
          holder_audit: buildHolderAuditSnapshot(signalSnapshot),
          est_share_pct: signalSnapshot?.estimated_share_pct ?? null,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const spotFeeTvlMin = Number(config.autoStrategy?.spotFeeTvlMin ?? 2);

  // 0x1774 retry ladder — attempt 0 runs the plan as-is; each rung refetches
  // pool state and re-anchors the range to the fresh active bin first.
  let runStrategy = activeStrategy;
  let runBinsBelow = activeBinsBelow;
  let runBinsAbove = activeBinsAbove;
  let runActiveBinId = activeBin.binId;
  let deployed = null;
  let lastError = null;

  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      const plan = planBinSlippageRetry(attempt, {
        strategy: runStrategy,
        binsBelow: runBinsBelow,
        binsAbove: runBinsAbove,
        feeTvlRatio: fee_tvl_ratio,
        minBinsBelow,
        spotFeeTvlMin,
      });
      if (plan.action === "stop") {
        log("deploy", `0x1774 ladder exhausted — ${plan.reason}`);
        break;
      }
      runStrategy = plan.strategy;
      runBinsBelow = plan.binsBelow;
      runBinsAbove = plan.binsAbove;
      try {
        await pool.refetchStates();
      } catch (refetchError) {
        log("deploy", `refetchStates failed on retry (${refetchError.message}) — using getActiveBin only`);
      }
      const freshBin = await pool.getActiveBin();
      runActiveBinId = freshBin.binId;
      log("deploy", `0x1774 retry ${attempt}/3 (${plan.step}): active bin ${runActiveBinId}, ${runStrategy} ${runBinsBelow}/${runBinsAbove}`);
    }

    const runStrategyType = strategyMap[runStrategy];
    const runAllowsUpside = runStrategy === "spot" || runStrategy === "curve";
    const runMinBinId = runActiveBinId - runBinsBelow;
    const runMaxBinId = isSingleSidedSol && !runAllowsUpside ? runActiveBinId : runActiveBinId + runBinsAbove;
    const runIsWide = runBinsBelow + runBinsAbove > 69;
    const newPosition = Keypair.generate();

    if (attempt === 0) {
      log("deploy", `Pool: ${pool_address}`);
      log("deploy", `Strategy: ${runStrategy}, Bins: ${runMinBinId} to ${runMaxBinId} (${runBinsBelow + runBinsAbove} bins${runIsWide ? " — WIDE RANGE" : ""})`);
      log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
    }
    log("deploy", `Position: ${newPosition.publicKey.toString()}`);

    try {
      if (attempt > 0) {
        await assertRangeDoesNotRequireBinArrayInitialization(pool, runMinBinId, runMaxBinId);
      }
      const txHashes = [];

      if (runIsWide) {
        // ── Wide Range Path (>69 bins) ─────────────────────────────────
        // Solana limits inner instruction realloc to 10240 bytes, so we can't create
        // a large position in a single initializePosition ix.
        // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
        //           then addLiquidityByStrategyChunkable (returns Transaction[]).

        // Phase 1: Create empty position (may be multiple txs)
        const createTxs = await pool.createExtendedEmptyPosition(
          runMinBinId,
          runMaxBinId,
          newPosition.publicKey,
          wallet.publicKey,
        );
        const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
        for (let i = 0; i < createTxArray.length; i++) {
          const signers = i === 0 ? [wallet, newPosition] : [wallet];
          const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers);
          txHashes.push(txHash);
          log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
        }

        try {
          // Phase 2: Add liquidity (may be multiple txs)
          const addTxs = await pool.addLiquidityByStrategyChunkable({
            positionPubKey: newPosition.publicKey,
            user: wallet.publicKey,
            totalXAmount: totalXLamports,
            totalYAmount: totalYLamports,
            strategy: { minBinId: runMinBinId, maxBinId: runMaxBinId, strategyType: runStrategyType },
            slippage: 10, // 10%
          });
          const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
          for (let i = 0; i < addTxArray.length; i++) {
            const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
            txHashes.push(txHash);
            log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
          }
        } catch (addError) {
          // Empty position already exists on-chain; a ladder retry re-anchors
          // with a new keypair, so reclaim this one's rent first.
          try {
            const orphan = await pool.getPosition(newPosition.publicKey);
            const closeTx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: orphan });
            if (closeTx) await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
            log("deploy", `Reclaimed empty position ${newPosition.publicKey.toString().slice(0, 8)} after failed add`);
          } catch (cleanupError) {
            log("deploy", `Could not reclaim empty position ${newPosition.publicKey.toString()}: ${cleanupError.message}`);
          }
          throw addError;
        }
      } else {
        // ── Standard Path (≤69 bins) ─────────────────────────────────
        const tx = await pool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: totalXLamports,
          totalYAmount: totalYLamports,
          strategy: { maxBinId: runMaxBinId, minBinId: runMinBinId, strategyType: runStrategyType },
          slippage: 1000, // 10% in bps
        });
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
        txHashes.push(txHash);
      }

      deployed = {
        txHashes,
        position: newPosition.publicKey.toString(),
        minBinId: runMinBinId,
        maxBinId: runMaxBinId,
        activeBinId: runActiveBinId,
        strategy: runStrategy,
        binsBelow: runBinsBelow,
        binsAbove: runBinsAbove,
        isWide: runIsWide,
        retries: attempt,
      };
      break;
    } catch (error) {
      lastError = error;
      if (!isBinSlippageError(error)) break;
      log("deploy", `Bin slippage (0x1774) on attempt ${attempt}: ${error.message}`);
    }
  }

  if (!deployed) {
    const message = lastError?.message ?? "Deploy failed: 0x1774 retry ladder exhausted";
    if (lastError == null || isBinSlippageError(lastError)) {
      addPoolNote({
        pool_address,
        note: `Deploy failed 0x1774 after retry ladder (shift/shrink/spot) — active bin too volatile at ${new Date().toISOString().slice(0, 16)}Z`,
      });
    }
    log("deploy_error", message);
    return { success: false, error: message };
  }

  log("deploy", `SUCCESS — ${deployed.txHashes.length} tx(s): ${deployed.txHashes[0]}${deployed.retries > 0 ? ` (after ${deployed.retries} 0x1774 retr${deployed.retries === 1 ? "y" : "ies"})` : ""}`);

  const finalActivePrice = Number(getPriceOfBinByBinId(deployed.activeBinId, actualBinStep).toString());
  const finalMinPrice = Number(getPriceOfBinByBinId(deployed.minBinId, actualBinStep).toString());
  const finalMaxPrice = Number(getPriceOfBinByBinId(deployed.maxBinId, actualBinStep).toString());
  const finalDownsidePct = finalActivePrice > 0 ? ((finalActivePrice - finalMinPrice) / finalActivePrice) * 100 : null;
  const finalUpsidePct = finalActivePrice > 0 ? ((finalMaxPrice - finalActivePrice) / finalActivePrice) * 100 : null;
  const finalWidthPct = finalMinPrice > 0 ? ((finalMaxPrice - finalMinPrice) / finalMinPrice) * 100 : null;

  invalidatePositionsCache();
  // Always consume staged signals — darwin uses them for weighting, the deploy
  // decision log uses them for the holder-audit snapshot.
  const signalSnapshot = getAndClearStagedSignals(pool_address, baseMint);
  trackPosition({
    position: deployed.position,
    pool: pool_address,
    pool_name,
    strategy: deployed.strategy,
    bin_range: { min: deployed.minBinId, max: deployed.maxBinId, bins_below: deployed.binsBelow, bins_above: deployed.binsAbove },
    bin_step,
    volatility: normalizedVolatility,
    fee_tvl_ratio,
    organic_score,
    amount_sol: finalAmountY,
    amount_x: finalAmountX,
    active_bin: deployed.activeBinId,
    initial_value_usd,
    signal_snapshot: signalSnapshot,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    tge: tge === true || undefined,
  });

  appendDecision({
    type: "deploy",
    actor: "SCREENER",
    pool: pool_address,
    pool_name,
    position: deployed.position,
    summary: `Deployed ${finalAmountY} SOL with ${deployed.strategy}`,
    reason: `Chosen range ${deployed.minBinId}→${deployed.maxBinId} around active bin ${deployed.activeBinId}${deployed.retries > 0 ? ` (0x1774 ladder: ${deployed.retries} retr${deployed.retries === 1 ? "y" : "ies"})` : ""}`,
    risks: [
      normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
      fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
    ].filter(Boolean),
    metrics: {
      amount_sol: finalAmountY,
      strategy: deployed.strategy,
      active_bin: deployed.activeBinId,
      min_bin: deployed.minBinId,
      max_bin: deployed.maxBinId,
      bins_used: deployed.binsBelow + deployed.binsAbove,
      upside_cover_pct: finalUpsidePct != null ? Number(finalUpsidePct.toFixed(2)) : null,
      oor_risk: oor_risk ?? null,
      deploy_retries: deployed.retries,
      downside_pct: downside_pct ?? null,
      upside_pct: upside_pct ?? null,
      holder_audit: buildHolderAuditSnapshot(signalSnapshot),
      est_share_pct: signalSnapshot?.estimated_share_pct ?? null,
    },
  });

  return {
    success: true,
    position: deployed.position,
    pool: pool_address,
    pool_name,
    bin_range: { min: deployed.minBinId, max: deployed.maxBinId, active: deployed.activeBinId },
    price_range: { min: finalMinPrice, max: finalMaxPrice },
    range_coverage: {
      downside_pct: finalDownsidePct,
      upside_pct: finalUpsidePct,
      width_pct: finalWidthPct,
      active_price: finalActivePrice,
    },
    bin_step: actualBinStep,
    base_fee: actualBaseFee,
    strategy: deployed.strategy,
    wide_range: deployed.isWide,
    amount_x: finalAmountX,
    amount_y: finalAmountY,
    deploy_retries: deployed.retries,
    txs: deployed.txHashes,
  };
}
