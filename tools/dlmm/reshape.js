/**
 * Reshape (in-place re-center) and flip (bid_ask → curve) — ported from fees-maxi.
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { getConnection } from "./sdk.js";
import { withdrawLiquidity, addLiquidity } from "./liquidity.js";
import { closePosition } from "./close.js";
import { deployPosition } from "./deploy.js";
import { getWalletBalances } from "../wallet.js";
import {
  getTrackedPosition,
  recordRebalance,
  recordRebalanceAttempt,
  setPositionPendingReshape,
  clearPositionPendingReshape,
  setPositionPendingFlip,
  clearPositionPendingFlip,
  recordReshapeComplete,
} from "../../state.js";
import {
  computeWalletBalanceDelta,
  applyDepositSafetyBps,
  humanToLamports,
} from "./balance-delta.js";

function reshapeCfg() {
  return config.reshape || {};
}

function flipCfg() {
  return config.flip || {};
}

async function mintDecimals(mint) {
  if (!mint) return 9;
  try {
    const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9;
  }
}

async function budgetFromWalletDelta(before, after, baseMint, safetyBps) {
  const { delta_x, delta_sol } = computeWalletBalanceDelta(before, after, baseMint);
  const shaved = applyDepositSafetyBps(delta_x, delta_sol, safetyBps);
  const dec = await mintDecimals(baseMint);
  const lam = humanToLamports({ amount_x: shaved.amount_x, amount_y: shaved.amount_y, decimals_x: dec });
  return { ...shaved, ...lam, decimals_x: dec };
}

/**
 * Resume stranded reshape/flip steps after daemon crash (call before main management loop).
 */
export async function resumePendingShapeOperations() {
  const { getTrackedPositions } = await import("../../state.js");
  const all = getTrackedPositions(false);
  const results = [];
  for (const tracked of all) {
    if (!tracked.closed && tracked.pending_reshape) {
      const r = await reshapePosition({
        position_address: tracked.position,
        pool_address: tracked.pool,
        reason: "resume_pending_reshape",
        resumeOnly: true,
      });
      results.push({ position: tracked.position, op: "reshape_resume", ...r });
    }
    if (tracked.pending_flip) {
      const r = await flipToCurve({
        position_address: tracked.position,
        pool_address: tracked.pending_flip.pool_address || tracked.pool,
        reason: "resume_pending_flip",
        resumeOnly: true,
      });
      results.push({ position: tracked.position, op: "flip_resume", ...r });
    }
  }
  return results;
}

export async function reshapePosition({ position_address, pool_address, reason, resumeOnly = false }) {
  const tracked = getTrackedPosition(position_address);
  const pool = pool_address || tracked?.pool;
  const baseMint = tracked?.base_mint || null;
  const cfg = reshapeCfg();
  const safetyBps = cfg.depositSafetyBps ?? 9950;

  if (!pool) return { success: false, error: "pool_address required" };

  try {
    let budget;
    if (resumeOnly && tracked?.pending_reshape) {
      budget = tracked.pending_reshape;
    } else if (!resumeOnly) {
      const before = await getWalletBalances();
      const wd = await withdrawLiquidity({
        position_address,
        pool_address: pool,
        bps: 10000,
        claim_fees: true,
      });
      if (!wd?.success && !wd?.dry_run) {
        recordRebalanceAttempt(position_address);
        return { success: false, error: wd?.error || "withdraw failed", step: "withdraw" };
      }
      if (wd?.dry_run) {
        return { dry_run: true, would_reshape: position_address, message: "DRY RUN — withdraw only" };
      }
      const after = await getWalletBalances();
      const resolvedMint = wd.base_mint || baseMint;
      budget = await budgetFromWalletDelta(before, after, resolvedMint, safetyBps);
      budget.base_mint = resolvedMint;
      budget.pool_address = pool;
      budget.active_bin = tracked?.bin_range?.active ?? null;
      setPositionPendingReshape(position_address, budget);
    } else {
      return { success: false, error: "no pending_reshape to resume" };
    }

    const add = await addLiquidity({
      position_address,
      pool_address: pool,
      strategy: "curve",
      amount_x_lamports: budget.amount_x_lamports,
      amount_y_lamports: budget.amount_y_lamports,
    });
    if (!add?.success && !add?.dry_run) {
      recordRebalanceAttempt(position_address);
      return { success: false, error: add?.error || "re-add failed", step: "add", pending: true };
    }
    if (add?.dry_run) {
      return { dry_run: true, would_add: position_address, message: "DRY RUN — re-add curve" };
    }

    clearPositionPendingReshape(position_address);
    const activeBin = budget.active_bin ?? tracked?.bin_range?.active ?? null;
    recordReshapeComplete(position_address, { active_bin: activeBin, reason });
    recordRebalance(position_address, {
      plan: { rebalance_type: "reshape", strategy: "curve", reason },
      tx_hashes: [...(add.txs || [])],
    });

    log("reshape", `Reshaped ${position_address.slice(0, 8)}: ${reason}`);
    return { success: true, position: position_address, txs: add.txs, reason };
  } catch (error) {
    recordRebalanceAttempt(position_address);
    log("reshape_error", error.message);
    return { success: false, error: error.message };
  }
}

export async function flipToCurve({ position_address, pool_address, reason, resumeOnly = false }) {
  const tracked = getTrackedPosition(position_address);
  const pool = pool_address || tracked?.pool;
  const cfg = flipCfg();
  const safetyBps = reshapeCfg().depositSafetyBps ?? 9950;

  if (!pool) return { success: false, error: "pool_address required" };

  const binsBelow = Number(config.strategy?.defaultBinsBelow ?? config.strategy?.minBinsBelow ?? 40);
  const binsAbove = Number(config.strategy?.defaultBinsAbove ?? Math.max(1, Math.ceil(binsBelow / 4)));

  try {
    let budget;
    let oldAddress = position_address;

    if (resumeOnly && tracked?.pending_flip) {
      budget = tracked.pending_flip;
      oldAddress = tracked.pending_flip.closed_position || position_address;
    } else if (!resumeOnly) {
      const before = await getWalletBalances();
      const closed = await closePosition({ position_address, reason: reason || "flip_to_curve" });
      if (!closed?.success && !closed?.dry_run) {
        recordRebalanceAttempt(position_address);
        return { success: false, error: closed?.error || "close failed", step: "close" };
      }
      if (closed?.dry_run) {
        return { dry_run: true, would_flip: position_address, message: "DRY RUN — close only" };
      }
      const after = await getWalletBalances();
      const baseMint = closed.base_mint || tracked?.base_mint;
      budget = await budgetFromWalletDelta(before, after, baseMint, safetyBps);
      budget.base_mint = baseMint;
      budget.pool_address = pool;
      budget.closed_position = position_address;
      setPositionPendingFlip(position_address, budget);
    } else {
      return { success: false, error: "no pending_flip to resume" };
    }

    const deploy = await deployPosition({
      pool_address: pool,
      strategy: "curve",
      amount_x: budget.amount_x,
      amount_y: budget.amount_y,
      bins_below: binsBelow,
      bins_above: binsAbove,
    });
    if (!deploy?.success && !deploy?.dry_run && !deploy?.position) {
      recordRebalanceAttempt(oldAddress);
      return { success: false, error: deploy?.error || "deploy failed", step: "deploy", pending: true };
    }
    if (deploy?.dry_run) {
      return { dry_run: true, would_deploy: pool, message: "DRY RUN — curve deploy" };
    }

    const newPos = deploy.position;
    clearPositionPendingFlip(oldAddress);
    recordRebalance(oldAddress, {
      plan: { rebalance_type: "flip_to_curve", strategy: "curve", reason, bins_below: binsBelow, bins_above: binsAbove },
      tx_hashes: deploy.tx_hashes || [],
      new_position: newPos,
    });

    log("flip", `Flipped ${oldAddress.slice(0, 8)} → curve ${String(newPos).slice(0, 8)}: ${reason}`);
    return { success: true, old_position: oldAddress, position: newPos, reason };
  } catch (error) {
    recordRebalanceAttempt(position_address);
    log("flip_error", error.message);
    return { success: false, error: error.message };
  }
}