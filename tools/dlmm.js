/**
 * Meteora DLMM toolkit — facade.
 *
 * The implementation lives in tools/dlmm/*:
 *   sdk.js             lazy SDK loader, wallet/connection, Jito send, pool caches
 *   positions-cache.js shared open-positions cache (TTL + inflight dedup)
 *   tx-safety.js       relay signing/simulation guards, bin-array rent guards
 *   rules.js           pure decision logic + PnL derivation (unit-testable)
 *   positions.js       getMyPositions / PnL reads / pool search / external closes
 *   deploy.js          deployPosition
 *   liquidity.js       claimFees / partial close / withdraw / add / rent reclaim
 *   rebalance.js       rebalancePosition (POWER MODE)
 *   close.js           closePosition + performance recording
 *
 * Import from this facade, not the submodules — it is the stable public API.
 */
export {
  getActiveBin,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  searchPools,
} from "./dlmm/positions.js";
export { deployPosition } from "./dlmm/deploy.js";
export {
  claimFees,
  partialClosePosition,
  withdrawLiquidity,
  addLiquidity,
} from "./dlmm/liquidity.js";
export { rebalancePosition } from "./dlmm/rebalance.js";
export { reshapePosition, flipToCurve, resumePendingShapeOperations } from "./dlmm/reshape.js";
export { closePosition } from "./dlmm/close.js";
export {
  getDeterministicCloseRule,
  isBinSlippageError,
  planBinSlippageRetry,
  plannedRangeFitsAccount,
  minSolRequiredForRebalanceMigrate,
  minSolRequiredForRebalanceInPlace,
  checkRebalanceSolGate,
  REBALANCE_SETTLE_DELAY_MS,
} from "./dlmm/rules.js";
