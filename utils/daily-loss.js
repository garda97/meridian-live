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
 * @returns {{ blocked: boolean, realizedPnlUsd: number, limitUsd: number|null, dayStartIso: string }}
 */
export function checkDailyLossGate({ decisions, limitUsd, nowMs = Date.now(), tzOffsetHours = 7 }) {
  const start = dayStartMs(nowMs, tzOffsetHours);
  const realizedPnlUsd = sumRealizedPnlUsd(decisions, start);
  const limit = limitUsd == null ? null : Number(limitUsd);
  const blocked =
    limit != null && Number.isFinite(limit) && limit > 0 && realizedPnlUsd <= -limit;
  return {
    blocked,
    realizedPnlUsd,
    limitUsd: limit,
    dayStartIso: new Date(start).toISOString(),
  };
}
