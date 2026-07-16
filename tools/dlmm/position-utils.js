/**
 * On-chain position helpers shared by deploy, close, and liquidity paths.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/** True when any bin in the position account holds liquidity. */
export async function positionHasLiquidity(pool, positionPubKey) {
  const key = positionPubKey instanceof PublicKey ? positionPubKey : new PublicKey(positionPubKey);
  const positionData = await pool.getPosition(key);
  const bins = positionData?.positionData?.positionBinData;
  if (!Array.isArray(bins) || bins.length === 0) return false;
  return bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
}

/** Estimate SOL (token Y) deposited from on-chain position totals. */
export async function estimatePositionSolAmount(pool, positionPubKey) {
  const key = positionPubKey instanceof PublicKey ? positionPubKey : new PublicKey(positionPubKey);
  const positionData = await pool.getPosition(key);
  const yRaw = positionData?.positionData?.totalYAmount;
  if (yRaw == null) return null;
  const lamports = new BN(String(yRaw));
  if (lamports.lte(new BN(0))) return null;
  return Number(lamports.toString()) / 1e9;
}