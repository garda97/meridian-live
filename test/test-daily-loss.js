/**
 * Unit tests for the daily realized-loss kill-switch (pure, no files).
 * Run: node test/test-daily-loss.js
 */

import { dayStartMs, sumRealizedPnlUsd, checkDailyLossGate } from "../utils/daily-loss.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 03:00 WIB on Jul 4 = 20:00 UTC Jul 3 → WIB day start = Jul 3 17:00 UTC
const NOW = Date.parse("2026-07-03T20:00:00.000Z");
assert(dayStartMs(NOW, 7) === Date.parse("2026-07-03T17:00:00.000Z"), "WIB day start wrong");
// 23:00 WIB same day
assert(dayStartMs(Date.parse("2026-07-04T15:59:00Z"), 7) === Date.parse("2026-07-03T17:00:00.000Z"), "late-evening WIB must share the same day start");
// One minute later it rolls over
assert(dayStartMs(Date.parse("2026-07-04T17:00:00Z"), 7) === Date.parse("2026-07-04T17:00:00.000Z"), "WIB midnight must roll the day");

const mk = (type, hoursAgo, pnl) => ({
  type,
  ts: new Date(NOW - hoursAgo * 3600_000).toISOString(),
  metrics: { pnl_usd: pnl },
});

const decisions = [
  mk("close", 1, -1.2),          // today
  mk("partial_close", 2, 0.5),   // today
  mk("close", 2.5, -0.8),        // today
  mk("deploy", 1, -99),          // wrong type — ignored
  mk("skip", 1, -99),            // wrong type — ignored
  mk("close", 26, -50),          // yesterday — ignored
  { type: "close", ts: new Date(NOW - 3600_000).toISOString(), metrics: {} },        // null pnl — skipped
  { type: "close", ts: "garbage", metrics: { pnl_usd: -5 } },                        // bad ts — skipped
];

const since = dayStartMs(NOW, 7);
assert(sumRealizedPnlUsd(decisions, since) === -1.5, `sum should be -1.5, got ${sumRealizedPnlUsd(decisions, since)}`);

// Gate off when limit null/0/negative
assert(!checkDailyLossGate({ decisions, limitUsd: null, nowMs: NOW }).blocked, "null limit must be off");
assert(!checkDailyLossGate({ decisions, limitUsd: 0, nowMs: NOW }).blocked, "0 limit must be off");
assert(!checkDailyLossGate({ decisions, limitUsd: -3, nowMs: NOW }).blocked, "negative limit must be off");

// Blocked at/over the limit, open below it
assert(checkDailyLossGate({ decisions, limitUsd: 1.5, nowMs: NOW }).blocked, "loss -1.5 must trip limit 1.5");
assert(checkDailyLossGate({ decisions, limitUsd: 1, nowMs: NOW }).blocked, "loss -1.5 must trip limit 1");
assert(!checkDailyLossGate({ decisions, limitUsd: 2, nowMs: NOW }).blocked, "loss -1.5 must not trip limit 2");

// Profitable day never blocks
const greenDay = [mk("close", 1, 3.0), mk("close", 2, -0.5)];
assert(!checkDailyLossGate({ decisions: greenDay, limitUsd: 1, nowMs: NOW }).blocked, "net-positive day must not block");

// Yesterday's bloodbath alone must not block today
const yesterdayOnly = [mk("close", 26, -50)];
const r = checkDailyLossGate({ decisions: yesterdayOnly, limitUsd: 1, nowMs: NOW });
assert(!r.blocked && r.realizedPnlUsd === 0, "yesterday's losses must reset at WIB midnight");

console.log("  daily-loss: WIB day math, type/ts filters, limit semantics, midnight reset OK");
console.log("test-daily-loss: OK");
