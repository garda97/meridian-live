/**
 * Shared open-positions cache. Deploy/close/claim/rebalance invalidate the TTL
 * after every on-chain mutation; getMyPositions repopulates it. The stale
 * object is intentionally kept readable after invalidation — closePosition's
 * PnL fallback and lookupPoolForPosition use it as a last-known snapshot.
 */
export const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

/** Fresh-enough cached result, or null when expired/empty. */
export function getFreshPositionsCache() {
  if (_positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  return null;
}

/** Last stored result regardless of TTL (may be stale) — snapshot reads only. */
export function getCachedPositions() {
  return _positionsCache;
}

export function setPositionsCache(result) {
  _positionsCache = result;
  _positionsCacheAt = Date.now();
}

/** Expire the TTL after an on-chain mutation; keeps the stale snapshot readable. */
export function invalidatePositionsCache() {
  _positionsCacheAt = 0;
}

export function getPositionsInflight() {
  return _positionsInflight;
}

export function setPositionsInflight(promise) {
  _positionsInflight = promise;
}
