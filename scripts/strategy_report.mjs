#!/usr/bin/env node
// Per-strategy performance report for tuning (bid_ask / spot / curve).
// Source of truth: state.json `closedOutcomes` (has strategy) joined with
// lessons.json `fees_earned_usd` (the REAL fee field — total_fees_claimed_usd
// only counts mid-position claims and is misleading). Join = same pool +
// nearest close/created timestamp within a window.
//
// Usage: node scripts/strategy_report.mjs [--last N] [--strat spot]
import fs from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const state = JSON.parse(fs.readFileSync(root + "state.json", "utf8"));
const lessonsRaw = JSON.parse(fs.readFileSync(root + "lessons.json", "utf8"));
// lessons.json = { lessons: [...], performance: {...} }. Only some lesson
// entries are close-records carrying pool + fees_earned_usd (the real fee).
const lessons = (Array.isArray(lessonsRaw) ? lessonsRaw : lessonsRaw.lessons || Object.values(lessonsRaw))
  .filter((l) => l && l.pool && l.fees_earned_usd != null);

const args = process.argv.slice(2);
const lastN = args.includes("--last") ? Number(args[args.indexOf("--last") + 1]) : null;
const onlyStrat = args.includes("--strat") ? args[args.indexOf("--strat") + 1] : null;

// Dedupe: a close is sometimes logged twice (once with the real close_reason,
// once as "external_close_sync_missing"). Keep one row per position, preferring
// the row whose reason is NOT the sync-missing artifact.
const seen = new Map();
for (const o of (state.closedOutcomes || []).filter((x) => x.strategy && x.position)) {
  const prev = seen.get(o.position);
  const isSync = (r) => /sync_missing|sync missing/i.test(r || "");
  if (!prev || (isSync(prev.close_reason) && !isSync(o.close_reason))) seen.set(o.position, o);
}
let outcomes = [...seen.values()];
outcomes.sort((a, b) => new Date(a.closed_at || 0) - new Date(b.closed_at || 0));
if (lastN) outcomes = outcomes.slice(-lastN);
if (onlyStrat) outcomes = outcomes.filter((o) => o.strategy === onlyStrat);

// Fee join: nearest lesson for same pool within 2h of close.
const feeFor = (o) => {
  const t = new Date(o.closed_at || o.deployed_at || 0).getTime();
  let best = null, bestDt = Infinity;
  for (const l of lessons) {
    if (l.pool !== o.pool || l.fees_earned_usd == null) continue;
    const dt = Math.abs(new Date(l.created_at || 0).getTime() - t);
    if (dt < bestDt) { bestDt = dt; best = l; }
  }
  return best && bestDt < 2 * 3600e3 ? best.fees_earned_usd : null;
};

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f = (n, d = 2) => (n == null ? "—" : Number(n).toFixed(d));

const byStrat = {};
for (const o of outcomes) (byStrat[o.strategy] ??= []).push({ ...o, fee_usd: feeFor(o) });

console.log(`\n=== Per-strategy report — ${outcomes.length} closed trades${lastN ? ` (last ${lastN})` : ""}${onlyStrat ? ` [${onlyStrat}]` : ""} ===\n`);
const cols = ["strategy", "n", "win%", "avgPnl%", "medPnl%", "best", "worst", "avgFee$", "fee>0", "avgVol", "avgTvl$", "avgMcap$"];
console.log(cols.join("\t"));
for (const [strat, rows] of Object.entries(byStrat).sort((a, b) => b[1].length - a[1].length)) {
  const pnl = rows.map((r) => r.pnl_pct).filter((x) => x != null && !isNaN(x));
  const fees = rows.map((r) => r.fee_usd).filter((x) => x != null);
  const wins = pnl.filter((x) => x > 0).length;
  console.log([
    strat, rows.length,
    `${((100 * wins) / (pnl.length || 1)).toFixed(0)}`,
    f(avg(pnl)), f(median(pnl)), f(Math.max(...pnl, -Infinity)), f(Math.min(...pnl, Infinity)),
    f(avg(fees), 3), `${fees.filter((x) => x > 0).length}/${fees.length}`,
    f(avg(rows.map((r) => r.volatility).filter(Boolean))),
    Math.round(avg(rows.map((r) => r.entry_tvl).filter(Boolean))),
    Math.round(avg(rows.map((r) => r.entry_mcap).filter(Boolean))),
  ].join("\t"));
}

// Per-strategy trade detail (most recent first) — useful for spot experiment.
for (const [strat, rows] of Object.entries(byStrat)) {
  if (!onlyStrat && rows.length > 8) continue; // only dump small/experimental sets unless filtered
  console.log(`\n--- ${strat} trades ---`);
  for (const r of [...rows].reverse()) {
    console.log(`  ${r.closed_at?.slice(5, 16) || "?"}  ${(r.pool_name || "?").padEnd(16)} pnl=${f(r.pnl_pct)}% fee=$${f(r.fee_usd, 3)} vol=${f(r.volatility)} tvl=$${Math.round(r.entry_tvl || 0)} feeTvl=${f(r.fee_tvl_ratio)} ${r.close_reason || ""}`);
  }
}
console.log("");
