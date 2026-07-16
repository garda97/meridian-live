/**
 * Wallet before/after snapshots for reshape/flip (fees-maxi pattern).
 * Pure helpers — unit-tested without network.
 */
import BN from "bn.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function tokenBalanceHuman(snapshot, mint) {
  if (!mint || !snapshot) return 0;
  if (mint === SOL_MINT || mint === "SOL") {
    return Number(snapshot.sol) || 0;
  }
  const entry = (snapshot.tokens || []).find((t) => t.mint === mint);
  return entry ? Number(entry.amount ?? entry.balance) || 0 : 0;
}

/**
 * Human-unit delta (SOL + base token) between two getWalletBalances() snapshots.
 */
export function computeWalletBalanceDelta(before, after, baseMint) {
  const solBefore = Number(before?.sol) || 0;
  const solAfter = Number(after?.sol) || 0;
  const xBefore = tokenBalanceHuman(before, baseMint);
  const xAfter = tokenBalanceHuman(after, baseMint);
  return {
    delta_sol: Math.max(0, solAfter - solBefore),
    delta_x: Math.max(0, xAfter - xBefore),
  };
}

export function applyDepositSafetyBps(deltaX, deltaY, safetyBps = 9950) {
  const bps = Math.min(Math.max(Math.round(Number(safetyBps) || 9950), 1), 10000);
  const factor = bps / 10000;
  const x = Math.max(0, Number(deltaX) || 0) * factor;
  const y = Math.max(0, Number(deltaY) || 0) * factor;
  return { amount_x: x, amount_y: y, safety_bps: bps };
}

/** Convert human amounts to lamport strings for addLiquidity / pending state. */
export function humanToLamports({ amount_x, amount_y, decimals_x = 9 }) {
  const xLam = amount_x > 0
    ? new BN(Math.floor(amount_x * 10 ** decimals_x)).toString()
    : "0";
  const yLam = amount_y > 0
    ? new BN(Math.floor(amount_y * 1e9)).toString()
    : "0";
  return { amount_x_lamports: xLam, amount_y_lamports: yLam };
}