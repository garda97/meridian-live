/**
 * Liquidity primitives on existing positions: claim fees, partial take-profit,
 * withdraw (account kept), add at the current range, and empty-account rent
 * reclaim. Used directly by cli.js and composed by rebalance/close.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { log } from "../../logger.js";
import {
  getDLMM,
  getConnection,
  getWallet,
  getPool,
  getPoolMetadata,
  evictPool,
  sendAndConfirmTransaction,
} from "./sdk.js";
import { positionHasLiquidity } from "./position-utils.js";
import { invalidatePositionsCache } from "./positions-cache.js";
import { REBALANCE_SETTLE_DELAY_MS } from "./rules.js";
import { lookupPoolForPosition } from "./positions.js";
import {
  getTrackedPosition,
  recordClaim,
  recordPartialTpAttempt,
  markPartialTpDone,
} from "../../state.js";
import { appendDecision } from "../../decision-log.js";
import { normalizeMint } from "../wallet.js";

export async function resolveStrategyType(strategy) {
  const { StrategyType } = await getDLMM();
  const map = { spot: StrategyType.Spot, curve: StrategyType.Curve, bid_ask: StrategyType.BidAsk };
  const type = map[strategy];
  if (type === undefined) throw new Error(`Invalid strategy: ${strategy}. Use spot, curve, or bid_ask.`);
  return type;
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    evictPool(poolAddress);
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    invalidatePositionsCache(); // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Partial Close (DCA-out) ───────────────────────────────────
/**
 * One-time partial take-profit: claim fees, then remove close_pct% of liquidity
 * WITHOUT closing the position account. The remaining liquidity keeps running
 * under the existing SL/trailing management. Marks partial_tp_done in state so
 * it can never fire twice for the same position. Local SDK path only (deploys
 * already use it regardless of relay mode).
 */
export async function partialClosePosition({ position_address, close_pct = 50, reason }) {
  position_address = normalizeMint(position_address);
  const pct = Math.min(Math.max(Number(close_pct) || 50, 1), 99);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_partial_close: position_address, close_pct: pct, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed" };
  }
  if (tracked?.partial_tp_done) {
    return { success: false, error: "Partial TP already executed for this position" };
  }

  recordPartialTpAttempt(position_address);
  try {
    log("partial_close", `Partial close ${pct}% of ${position_address}: ${reason || "partial take profit"}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    evictPool(poolAddress);
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);
    const baseMint = pool.lbPair.tokenXMint.toString();

    // ─── Step 1: Claim fees (realize earnings before trimming) ─
    const claimTxHashes = [];
    try {
      const positionData = await pool.getPosition(positionPubKey);
      const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
      for (const tx of claimTxs || []) {
        claimTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
      }
      if (claimTxHashes.length) {
        log("partial_close", `Step 1 OK (claim): ${claimTxHashes.join(", ")}`);
        recordClaim(position_address);
      }
    } catch (e) {
      log("partial_close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove pct% of liquidity, keep account open ──
    const positionForRemove = await pool.getPosition(positionPubKey);
    const processed = positionForRemove?.positionData;
    const fromBinId = processed?.lowerBinId ?? tracked?.bin_range?.min ?? -887272;
    const toBinId = processed?.upperBinId ?? tracked?.bin_range?.max ?? 887272;

    const removeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(Math.round(pct * 100)),
      shouldClaimAndClose: false,
    });
    const removeTxHashes = [];
    for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
      removeTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
    }
    log("partial_close", `Step 2 OK (removed ${pct}%): ${removeTxHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before the caller's auto-swap
    await new Promise((r) => setTimeout(r, 5000));
    invalidatePositionsCache();

    markPartialTpDone(position_address, `removed ${pct}% liquidity — ${reason || "partial take profit"}`);
    appendDecision({
      type: "partial_close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: tracked?.pool_name || poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: `Partial TP: removed ${pct}% liquidity, position stays open`,
      reason: reason || "partial take profit",
      metrics: {
        exit_signal_type: "partial_tp",
        closed_pct: pct,
      },
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: tracked?.pool_name || poolMeta.name || null,
      close_pct: pct,
      claim_txs: claimTxHashes,
      remove_txs: removeTxHashes,
      base_mint: baseMint,
    };
  } catch (error) {
    log("partial_close_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Remove liquidity from an existing position without closing the account.
 * bps 10000 = 100%. Returns the pre-withdraw X/Y amounts (raw lamport strings)
 * so callers (rebalance) know the re-add budget.
 */
export async function withdrawLiquidity({ position_address, pool_address, bps = 10000, claim_fees = true }) {
  position_address = normalizeMint(position_address);
  const clampedBps = Math.min(Math.max(Math.round(Number(bps) || 10000), 1), 10000);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_withdraw: position_address, bps: clampedBps, message: "DRY RUN — no transaction sent" };
  }
  try {
    const wallet = getWallet();
    const poolAddress = pool_address || (await lookupPoolForPosition(position_address, wallet.publicKey.toString()));
    evictPool(poolAddress);
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);

    const claimTxHashes = [];
    if (claim_fees) {
      try {
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
        for (const tx of claimTxs || []) {
          claimTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
        }
        if (claimTxHashes.length) recordClaim(position_address);
      } catch (e) {
        log("withdraw_warn", `Claim before withdraw failed or nothing to claim: ${e.message}`);
      }
    }

    const positionForRemove = await pool.getPosition(positionPubKey);
    const processed = positionForRemove?.positionData;
    const fromBinId = processed?.lowerBinId ?? -887272;
    const toBinId = processed?.upperBinId ?? 887272;
    const withdrawnX = String(processed?.totalXAmount ?? "0");
    const withdrawnY = String(processed?.totalYAmount ?? "0");

    const removeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(clampedBps),
      shouldClaimAndClose: false,
    });
    const removeTxHashes = [];
    for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
      removeTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
    }
    invalidatePositionsCache();
    log("withdraw", `Removed ${clampedBps / 100}% liquidity from ${position_address.slice(0, 8)}: ${removeTxHashes.join(", ")}`);

    return {
      success: true,
      position: position_address,
      pool: String(poolAddress),
      bps: clampedBps,
      claim_txs: claimTxHashes,
      remove_txs: removeTxHashes,
      withdrawn_x: withdrawnX,
      withdrawn_y: withdrawnY,
      lower_bin: fromBinId,
      upper_bin: toBinId,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("withdraw_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Add liquidity to an EXISTING position at its current bin range.
 * amount_x / amount_y in human units; amount_x_lamports / amount_y_lamports
 * (BN-able) override them for exact re-adds.
 */
export async function addLiquidity({
  position_address,
  pool_address,
  amount_x = 0,
  amount_y = 0,
  strategy = "spot",
  single_sided_x = false,
  amount_x_lamports = null,
  amount_y_lamports = null,
}) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_add_to: position_address, amount_x, amount_y, strategy, message: "DRY RUN — no transaction sent" };
  }
  try {
    const wallet = getWallet();
    const poolAddress = pool_address || (await lookupPoolForPosition(position_address, wallet.publicKey.toString()));
    evictPool(poolAddress);
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);
    const strategyType = await resolveStrategyType(strategy);

    const existing = await pool.getPosition(positionPubKey);
    const minBinId = existing?.positionData?.lowerBinId;
    const maxBinId = existing?.positionData?.upperBinId;
    if (minBinId == null || maxBinId == null) throw new Error("Position bin range unavailable");

    let totalXAmount = new BN(0);
    if (amount_x_lamports != null) {
      totalXAmount = new BN(String(amount_x_lamports));
    } else if (amount_x > 0) {
      const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
      const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
      totalXAmount = new BN(Math.floor(amount_x * Math.pow(10, decimals)));
    }
    let totalYAmount = amount_y_lamports != null
      ? new BN(String(amount_y_lamports))
      : new BN(Math.floor((single_sided_x ? 0 : amount_y) * 1e9));

    const isWide = maxBinId - minBinId + 1 > 69;
    const txHashes = [];
    const params = {
      positionPubKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
      slippage: 10,
    };
    if (isWide) {
      const txs = await pool.addLiquidityByStrategyChunkable(params);
      for (const tx of Array.isArray(txs) ? txs : [txs]) {
        txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
      }
    } else {
      const tx = await pool.addLiquidityByStrategy({ ...params, slippage: 1000 });
      for (const t of Array.isArray(tx) ? tx : [tx]) {
        txHashes.push(await sendAndConfirmTransaction(getConnection(), t, [wallet]));
      }
    }
    invalidatePositionsCache();
    log("add_liquidity", `Added liquidity to ${position_address.slice(0, 8)} (${strategy}, bins ${minBinId}→${maxBinId}): ${txHashes.join(", ")}`);
    return { success: true, position: position_address, pool: String(poolAddress), txs: txHashes, min_bin: minBinId, max_bin: maxBinId, strategy };
  } catch (error) {
    log("add_liquidity_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Wide-range chunkable add with fresh blockhash per tx.
 * On mid-sequence failure, adopts partial liquidity instead of leaving an orphan.
 */
export async function addLiquidityChunked(pool, {
  positionPubKey,
  totalXAmount,
  totalYAmount,
  strategy,
  slippage = 10,
  wallet,
  logPrefix = "deploy",
}) {
  const addTxs = await pool.addLiquidityByStrategyChunkable({
    positionPubKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy,
    slippage,
  });
  const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
  const txHashes = [];
  let completed = 0;

  try {
    for (let i = 0; i < addTxArray.length; i++) {
      const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
      txHashes.push(txHash);
      completed = i + 1;
      log(logPrefix, `Add liquidity tx ${completed}/${addTxArray.length}: ${txHash}`);
    }
    return { success: true, txHashes, completed, total: addTxArray.length, partial: false };
  } catch (error) {
    const hasLiq = await positionHasLiquidity(pool, positionPubKey);
    if (!hasLiq) throw error;
    log(
      logPrefix,
      `Partial chunkable add ${completed}/${addTxArray.length} — position has liquidity, adopting (${error.message})`,
    );
    return {
      success: true,
      txHashes,
      completed,
      total: addTxArray.length,
      partial: true,
      error: error.message,
    };
  }
}

/** Best-effort reclaim of an emptied position account after RPC settle. */
export async function reclaimEmptyPositionAccount(pool, wallet, position_address, { delayMs = REBALANCE_SETTLE_DELAY_MS, label = "rebalance" } = {}) {
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  try {
    const orphan = await pool.getPosition(new PublicKey(position_address));
    const closeTx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: orphan });
    if (closeTx) {
      const hash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      log(label, `Reclaimed empty position account ${position_address.slice(0, 8)} (settle ${delayMs}ms): ${hash}`);
      return { success: true, tx: hash };
    }
  } catch (e) {
    log(`${label}_warn`, `Could not reclaim empty account ${position_address.slice(0, 8)}: ${e.message}`);
  }
  return { success: false };
}
