/**
 * Daily realized-loss kill-switch — deterministic, portfolio-level.
 *
 * Sums realized PnL (USD) of close/partial_close decisions since the start of
 * the current WIB calendar day. When the summed loss reaches the configured
 * limit, the screening cycle skips all new deploys for the rest of the day;
 * open positions stay fully managed (SL/trailing/OOR untouched). Resets
 * naturally at WIB midnight — resuming earlier is an owner decision (raise or
 * clear dailyLossLimitUsd).
 */

const CLOSE_TYPES = new Set(["close", "partial_close"]);

/** Epoch ms of 00:00 in the given UTC-offset timezone (default WIB, UTC+7). */
export function dayStartMs(nowMs, tzOffsetHours = 7) {
  const offsetMs = tzOffsetHours * 60 * 60 * 1000;
  const local = nowMs + offsetMs;
  return local - (local % (24 * 60 * 60 * 1000)) - offsetMs;
}

/** Sum realized PnL (USD) from close-type decisions on/after sinceMs. Null pnl entries are skipped. */
export function sumRealizedPnlUsd(decisions, sinceMs) {
  let sum = 0;
  for (const d of decisions || []) {
    if (!CLOSE_TYPES.has(d?.type)) continue;
    const ts = Date.parse(d?.ts);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const pnl = Number(d?.metrics?.pnl_usd);
    if (Number.isFinite(pnl)) sum += pnl;
  }
  return Math.round(sum * 10000) / 10000;
}

/**
 * @param {number} [strandedUsd] - USD value of unrecovered stranded tokens
 *   (fees-maxi port: capital stuck in unsold base tokens after a failed
 *   auto-swap counts toward the loss gate in full — it is at-risk in an
 *   illiquid memecoin until it is back in SOL). 0 / omitted = unchanged.
 * @returns {{ blocked: boolean, realizedPnlUsd: number, strandedUsd: number, effectiveLossUsd: number, limitUsd: number|null, dayStartIso: string }}
 */
export function checkDailyLossGate({ decisions, limitUsd, strandedUsd = 0, nowMs = Date.now(), tzOffsetHours = 7 }) {
  const start = dayStartMs(nowMs, tzOffsetHours);
  const realizedPnlUsd = sumRealizedPnlUsd(decisions, start);
  const stranded = Number.isFinite(Number(strandedUsd)) ? Math.max(0, Number(strandedUsd)) : 0;
  const effectiveLossUsd = Math.round((realizedPnlUsd - stranded) * 10000) / 10000;
  const limit = limitUsd == null ? null : Number(limitUsd);
  const blocked =
    limit != null && Number.isFinite(limit) && limit > 0 && effectiveLossUsd <= -limit;
  return {
    blocked,
    realizedPnlUsd,
    strandedUsd: stranded,
    effectiveLossUsd,
    limitUsd: limit,
    dayStartIso: new Date(start).toISOString(),
  };
}
