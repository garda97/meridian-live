/**
 * rebalancePosition (POWER MODE): reposition an open position to a fresh range
 * from a position-router plan: claim → remove 100% (account kept) → re-add at
 * the new range.
 *
 * DLMM position accounts have a FIXED bin allocation set at creation, so a
 * range that still fits the old account re-adds in place ("in_place" path);
 * a shifted range migrates to a new account and reclaims the old rent
 * ("migrate" path — the common case for shift_up / reseed_below).
 *
 * Fail-open: if the re-add fails after the 0x1774 ladder, the withdrawn funds
 * stay in the wallet, the empty account is reclaimed, and the position is
 * marked closed with reason "rebalance failed" — the screener redeploys later.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { getConnection, getWallet, getPool, getPoolMetadata, evictPool, sendAndConfirmTransaction } from "./sdk.js";
import { assertRangeDoesNotRequireBinArrayInitialization } from "./tx-safety.js";
import {
  isBinSlippageError,
  planBinSlippageRetry,
  plannedRangeFitsAccount,
  checkRebalanceSolGate,
} from "./rules.js";
import { invalidatePositionsCache } from "./positions-cache.js";
import { lookupPoolForPosition } from "./positions.js";
import { withdrawLiquidity, reclaimEmptyPositionAccount, resolveStrategyType } from "./liquidity.js";
import {
  getTrackedPosition,
  recordClose,
  recordRebalance,
  recordRebalanceAttempt,
} from "../../state.js";
import { appendDecision } from "../../decision-log.js";
import { getWalletBalances, normalizeMint } from "../wallet.js";

export async function rebalancePosition({ position_address, plan, reason }) {
  position_address = normalizeMint(position_address);
  if (!plan || (plan.bins_below == null && plan.bins_above == null)) {
    return { success: false, error: "rebalance plan with bins_below/bins_above required" };
  }
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_rebalance: position_address,
      rebalance_type: plan.rebalance_type,
      strategy: plan.strategy,
      bins: `${plan.bins_below}/${plan.bins_above}`,
      message: "DRY RUN — no transaction sent",
    };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) return { success: false, error: "Position already closed" };

  try {
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    evictPool(poolAddress);
    const pool = await getPool(poolAddress);
    try {
      await pool.refetchStates(); // 0x1774 lesson: never anchor to a stale active bin
    } catch (e) {
      log("rebalance_warn", `refetchStates failed (${e.message}) — using getActiveBin only`);
    }

    // Pre-flight: assess migrate vs in_place and verify SOL BEFORE withdraw.
    const freshBin = await pool.getActiveBin();
    let preBinsBelow = Math.max(0, Number(plan.bins_below) || 0);
    let preBinsAbove = Math.max(0, Number(plan.bins_above) || 0);
    const preMinBinId = freshBin.binId - preBinsBelow;
    const preMaxBinId = freshBin.binId + preBinsAbove;
    const preIsWide = preMaxBinId - preMinBinId + 1 > 69;

    let accountLower = tracked?.bin_range?.min;
    let accountUpper = tracked?.bin_range?.max;
    try {
      const existing = await pool.getPosition(new PublicKey(position_address));
      const lower = existing?.positionData?.lowerBinId;
      const upper = existing?.positionData?.upperBinId;
      if (Number.isFinite(lower) && Number.isFinite(upper)) {
        accountLower = lower;
        accountUpper = upper;
      }
    } catch (e) {
      log("rebalance_warn", `Could not read on-chain bin range for pre-flight (${e.message}) — using tracked range`);
    }

    const prePath = plannedRangeFitsAccount(preMinBinId, preMaxBinId, accountLower, accountUpper) ? "in_place" : "migrate";
    const balance = await getWalletBalances().catch(() => null);
    const solGate = checkRebalanceSolGate({
      balanceSol: balance?.sol,
      path: prePath,
      isWide: preIsWide,
      mgmtConfig: config.management,
    });
    if (!solGate.ok) {
      // Stamp the cooldown even on a skip: without it the 3s poller re-resolves
      // and re-logs this every tick until SOL frees up (yep-SOL spam loop).
      // Retry naturally resumes after rebalanceCooldownMinutes.
      recordRebalanceAttempt(position_address);
      log("rebalance", `Skipped (${prePath}): ${solGate.reason}`);
      appendDecision({
        type: "skip",
        actor: "MANAGER",
        pool: String(poolAddress),
        pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
        position: position_address,
        summary: "Rebalance skipped — insufficient SOL for safe migrate",
        reason: solGate.reason,
        metrics: {
          rebalance_type: plan.rebalance_type ?? null,
          rebalance_path_planned: prePath,
          balance_sol: balance?.sol ?? null,
          sol_required: solGate.required,
          planned_bins: preBinsBelow + preBinsAbove,
          planned_wide: preIsWide,
        },
      });
      return { success: false, blocked: true, error: solGate.reason, rebalance_path_planned: prePath };
    }

    // Pre-flight bin-array check: refuse to rebalance into a range that would
    // require Meteora bin-array initialization (non-refundable rent). MUST run
    // BEFORE withdrawLiquidity — otherwise the position is already emptied and
    // the failed re-add force-closes it (funds returned, deploy undone).
    // Mirrors deploy-time guard in assertRangeDoesNotRequireBinArrayInitialization
    // but here we skip (keep position open) instead of closing.
    try {
      await assertRangeDoesNotRequireBinArrayInitialization(pool, preMinBinId, preMaxBinId);
    } catch (binErr) {
      recordRebalanceAttempt(position_address);
      log("rebalance", `Skipped (${prePath}): ${binErr.message}`);
      appendDecision({
        type: "skip",
        actor: "MANAGER",
        pool: String(poolAddress),
        pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
        position: position_address,
        summary: "Rebalance skipped — target range needs uninitialized bin-array (would charge non-refundable rent)",
        reason: binErr.message,
        metrics: {
          rebalance_type: plan.rebalance_type ?? null,
          rebalance_path_planned: prePath,
          planned_bins: preBinsBelow + preBinsAbove,
          planned_wide: preIsWide,
        },
      });
      return { success: false, blocked: true, error: binErr.message, rebalance_path_planned: prePath };
    }

    // Cooldown stamp before on-chain work — failures must not retry every tick
    recordRebalanceAttempt(position_address);

    // Step 1+2: claim + remove 100%, capture the re-add budget
    const withdrawn = await withdrawLiquidity({ position_address, pool_address: String(poolAddress), bps: 10000, claim_fees: true });
    if (!withdrawn.success) {
      return { success: false, error: `Withdraw failed: ${withdrawn.error}` };
    }
    const oldLower = withdrawn.lower_bin;
    const oldUpper = withdrawn.upper_bin;
    let budgetX = new BN(withdrawn.withdrawn_x || "0");
    let budgetY = new BN(withdrawn.withdrawn_y || "0");

    // Token-heavy after a dump-through: give the withdrawn token an ask side
    // to sell into the bounce (single_sided_reseed doctrine).
    let binsBelow = Math.max(0, Number(plan.bins_below) || 0);
    let binsAbove = Math.max(0, Number(plan.bins_above) || 0);
    if (budgetX.gt(new BN(0)) && binsAbove === 0) {
      binsAbove = Math.max(1, Math.ceil(binsBelow / 3));
      log("rebalance", `Withdrawn base-token budget > 0 with no ask side — extending ${binsAbove} bins above for the bounce`);
    }

    const spotFeeTvlMin = Number(config.autoStrategy?.spotFeeTvlMin ?? 2);
    let runStrategy = plan.strategy || "bid_ask";
    let runBinsBelow = binsBelow;
    let runBinsAbove = binsAbove;
    let added = null;
    let lastError = null;

    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) {
        const step = planBinSlippageRetry(attempt, {
          strategy: runStrategy,
          binsBelow: runBinsBelow,
          binsAbove: runBinsAbove,
          feeTvlRatio: plan.fee_tvl_ratio ?? null,
          minBinsBelow: config.strategy.minBinsBelow,
          spotFeeTvlMin,
        });
        if (step.action === "stop") {
          log("rebalance", `0x1774 ladder exhausted — ${step.reason}`);
          break;
        }
        runStrategy = step.strategy;
        runBinsBelow = step.binsBelow;
        runBinsAbove = step.binsAbove;
        try { await pool.refetchStates(); } catch { /* fresh bin below still re-fetched */ }
      }

      const freshBin = await pool.getActiveBin();
      const minBinId = freshBin.binId - runBinsBelow;
      const maxBinId = freshBin.binId + runBinsAbove;
      const strategyType = await resolveStrategyType(runStrategy);
      const fitsOldAccount = minBinId >= oldLower && maxBinId <= oldUpper;
      const isWide = maxBinId - minBinId + 1 > 69;

      try {
        await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);
        const txHashes = [];
        let newPositionAddress = position_address;
        let path;

        if (fitsOldAccount) {
          // In-place: same account, new distribution (convert_to_spot case)
          path = "in_place";
          const params = {
            positionPubKey: new PublicKey(position_address),
            user: wallet.publicKey,
            totalXAmount: budgetX,
            totalYAmount: budgetY,
            strategy: { minBinId, maxBinId, strategyType },
          };
          const txs = isWide
            ? await pool.addLiquidityByStrategyChunkable({ ...params, slippage: 10 })
            : await pool.addLiquidityByStrategy({ ...params, slippage: 1000 });
          for (const tx of Array.isArray(txs) ? txs : [txs]) {
            txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
          }
        } else {
          // Migrate: new account at the shifted range, then reclaim old rent
          path = "migrate";
          const newPosition = Keypair.generate();
          newPositionAddress = newPosition.publicKey.toString();
          if (isWide) {
            const createTxs = await pool.createExtendedEmptyPosition(minBinId, maxBinId, newPosition.publicKey, wallet.publicKey);
            const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
            for (let i = 0; i < createTxArray.length; i++) {
              txHashes.push(await sendAndConfirmTransaction(getConnection(), createTxArray[i], i === 0 ? [wallet, newPosition] : [wallet]));
            }
            const addTxs = await pool.addLiquidityByStrategyChunkable({
              positionPubKey: newPosition.publicKey,
              user: wallet.publicKey,
              totalXAmount: budgetX,
              totalYAmount: budgetY,
              strategy: { minBinId, maxBinId, strategyType },
              slippage: 10,
            });
            for (const tx of Array.isArray(addTxs) ? addTxs : [addTxs]) {
              txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
            }
          } else {
            const tx = await pool.initializePositionAndAddLiquidityByStrategy({
              positionPubKey: newPosition.publicKey,
              user: wallet.publicKey,
              totalXAmount: budgetX,
              totalYAmount: budgetY,
              strategy: { minBinId, maxBinId, strategyType },
              slippage: 1000,
            });
            txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]));
          }
          // Old account is now empty — wait for RPC settle, then reclaim rent
          const reclaimed = await reclaimEmptyPositionAccount(pool, wallet, position_address);
          if (reclaimed.tx) txHashes.push(reclaimed.tx);
        }

        added = {
          txHashes,
          path,
          newPositionAddress,
          minBinId,
          maxBinId,
          activeBinId: freshBin.binId,
          strategy: runStrategy,
          binsBelow: runBinsBelow,
          binsAbove: runBinsAbove,
          retries: attempt,
        };
        break;
      } catch (error) {
        lastError = error;
        if (!isBinSlippageError(error)) break;
        log("rebalance", `Bin slippage (0x1774) on rebalance attempt ${attempt}: ${error.message}`);
      }
    }

    invalidatePositionsCache();

    if (!added) {
      // Fail-open: withdrawn funds are in the wallet; reclaim the empty
      // account and hand the pool back to the screener.
      const failMsg = lastError?.message ?? "re-add exhausted the retry ladder";
      log("rebalance_error", `Re-add failed after withdraw (${failMsg}) — closing empty account, funds stay in wallet`);
      await reclaimEmptyPositionAccount(pool, wallet, position_address, { label: "rebalance_error" });
      recordClose(position_address, `rebalance failed after withdraw (${failMsg}) — funds returned to wallet`);
      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: String(poolAddress),
        pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
        position: position_address,
        summary: "Rebalance failed after withdraw — position closed, funds in wallet",
        reason: reason || plan.reason || "rebalance failed",
        metrics: { exit_signal_type: "rebalance_failed", rebalance_type: plan.rebalance_type },
      });
      return { success: false, error: `Rebalance re-add failed: ${failMsg}`, funds_withdrawn: true, position_closed: true };
    }

    const updated = recordRebalance(position_address, {
      plan: {
        ...plan,
        strategy: added.strategy,
        bins_below: added.binsBelow,
        bins_above: added.binsAbove,
        min_bin: added.minBinId,
        max_bin: added.maxBinId,
      },
      tx_hashes: added.txHashes,
      new_position: added.newPositionAddress !== position_address ? added.newPositionAddress : null,
    });

    appendDecision({
      type: "rebalance",
      actor: "MANAGER",
      pool: String(poolAddress),
      pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
      position: added.newPositionAddress,
      summary: `Rebalanced (${plan.rebalance_type}, ${added.path}): ${added.strategy} ${added.binsBelow}/${added.binsAbove} @ bin ${added.activeBinId}`,
      reason: reason || plan.reason || "rebalance",
      metrics: {
        rebalance_type: plan.rebalance_type,
        rebalance_path: added.path,
        rebalance_count: updated?.rebalance_count ?? null,
        market_view: plan.market_view ?? null,
        oor_direction: plan.oor_direction ?? null,
        oor_risk: plan.oor_risk ?? null,
        bins_used: added.binsBelow + added.binsAbove,
        min_bin: added.minBinId,
        max_bin: added.maxBinId,
        active_bin: added.activeBinId,
        deploy_retries: added.retries,
        old_position: added.newPositionAddress !== position_address ? position_address : null,
      },
    });

    log("rebalance", `SUCCESS (${added.path}) — ${plan.rebalance_type}: ${added.strategy} ${added.binsBelow}/${added.binsAbove} @ ${added.activeBinId}, ${added.txHashes.length} tx(s)`);
    return {
      success: true,
      position: added.newPositionAddress,
      old_position: position_address,
      pool: String(poolAddress),
      pool_name: tracked?.pool_name || poolMeta.name || null,
      rebalance_type: plan.rebalance_type,
      rebalance_path: added.path,
      strategy: added.strategy,
      bin_range: { min: added.minBinId, max: added.maxBinId, active: added.activeBinId },
      txs: added.txHashes,
      retries: added.retries,
    };
  } catch (error) {
    log("rebalance_error", error.message);
    return { success: false, error: error.message };
  }
}
