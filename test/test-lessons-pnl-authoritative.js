/**
 * Regression test for the 2026-07-16 BULLCAT incident: the Meteora
 * closed-positions API returned a partial withdrawal (withdrawn=22.82 vs
 * deposited=58.13) right after close, and lessons.js recomputed PnL from
 * those values → a phantom -60.68% landed in lessons.json AND pool-memory
 * (loss cooldown on a ~breakeven pool), while closedOutcomes[] had the
 * settled +0.06% — three stores disagreeing about one close. Covers:
 *  1. When close.js passes its settled pnl_pct, lessons.json AND
 *     pool-memory record THAT value, not the final_value-derived one.
 *  2. Without an authoritative pnl_pct, the derived computation still
 *     works exactly as before (backward compat for old callers).
 *  3. The suspiciousUnitMix guard still skips garbage-only records, but
 *     records (with the settled value) when an authoritative pnl_pct exists.
 * Run: node test/test-lessons-pnl-authoritative.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const LESSONS_PATH = repoPath("lessons.json");
const POOLMEM_PATH = repoPath("pool-memory.json");

// recordPerformance fire-and-forgets HiveMind pushes — stub fetch so the
// test never hits the network (pattern from scratchpad/test_close_notify.mjs).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { recordPerformance } = await import("../lessons.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function backup(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
}
function restore(path, data) {
  if (data == null) {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } else {
    fs.writeFileSync(path, data);
  }
}

function basePerf(overrides = {}) {
  // The real BULLCAT numbers from the incident.
  return {
    position: "LESSFIX_POS_1",
    pool: "LESSFIX_POOL_1",
    pool_name: "LESSFIXTEST-SOL",
    base_mint: "LESSFIX_MINT_1",
    strategy: "bid_ask",
    bin_range: { min: -530, max: -344, bins_below: 186, bins_above: 0 },
    bin_step: 125,
    volatility: 13.6,
    amount_sol: 0.75,
    fees_earned_usd: 0.07,
    final_value_usd: 22.82,   // partial-withdrawal artifact
    initial_value_usd: 58.13,
    minutes_in_range: 60,
    minutes_held: 60,
    close_reason: "Low yield: fee/TVL 1.45% < min 2.5% (age: 60m)",
    ...overrides,
  };
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function testAuthoritativePnlWins() {
  const perf = basePerf({ pnl_pct: 0.06 }); // close.js settled value
  await recordPerformance(perf);

  const lessons = readJson(LESSONS_PATH);
  const rec = lessons.performance.find((p) => p.position === "LESSFIX_POS_1");
  assert(rec, "performance record must exist");
  assert(rec.pnl_pct === 0.06, `lessons must use settled pnl_pct: expected 0.06, got ${rec.pnl_pct}`);
  const derivedWould = ((22.82 + 0.07 - 58.13) / 58.13) * 100; // ≈ -60.6%
  assert(Math.abs(rec.pnl_pct - derivedWould) > 50, "sanity: settled and derived must actually differ in this fixture");

  const pm = readJson(POOLMEM_PATH);
  const entry = pm["LESSFIX_POOL_1"];
  assert(entry, "pool-memory entry must exist");
  const deploy = entry.deploys[entry.deploys.length - 1];
  assert(deploy.pnl_pct === 0.06, `pool-memory must receive settled pnl_pct: expected 0.06, got ${deploy.pnl_pct}`);
  assert(!entry.base_mint_cooldown_until || Date.parse(entry.base_mint_cooldown_until) < Date.now() + 1,
    "no loss cooldown should be set for a ~breakeven settled close");
  console.log("  ✓ settled pnl_pct wins over garbage final_value_usd in lessons AND pool-memory");
}

async function testDerivedFallbackUnchanged() {
  const perf = basePerf({
    position: "LESSFIX_POS_2",
    pool: "LESSFIX_POOL_2",
    final_value_usd: 55.0,
    // no pnl_pct passed — old caller shape
  });
  await recordPerformance(perf);

  const lessons = readJson(LESSONS_PATH);
  const rec = lessons.performance.find((p) => p.position === "LESSFIX_POS_2");
  assert(rec, "performance record must exist");
  const expected = Math.round(((55.0 + 0.07 - 58.13) / 58.13) * 100 * 100) / 100;
  assert(rec.pnl_pct === expected, `derived path must be unchanged: expected ${expected}, got ${rec.pnl_pct}`);
  console.log("  ✓ derived computation unchanged when no authoritative pnl_pct");
}

async function testUnitMixGuard() {
  // Unit-mixed garbage (final_value_usd looks like a SOL amount), NO authoritative → skipped.
  const skipped = basePerf({
    position: "LESSFIX_POS_3",
    pool: "LESSFIX_POOL_3",
    final_value_usd: 0.9,
    amount_sol: 0.75,
  });
  await recordPerformance(skipped);
  let lessons = readJson(LESSONS_PATH);
  assert(!lessons.performance.find((p) => p.position === "LESSFIX_POS_3"),
    "unit-mixed record without authoritative pnl must still be skipped");

  // Same garbage WITH authoritative settled pnl → recorded using the settled value.
  const kept = basePerf({
    position: "LESSFIX_POS_4",
    pool: "LESSFIX_POOL_4",
    final_value_usd: 0.9,
    amount_sol: 0.75,
    pnl_pct: -1.2,
  });
  await recordPerformance(kept);
  lessons = readJson(LESSONS_PATH);
  const rec = lessons.performance.find((p) => p.position === "LESSFIX_POS_4");
  assert(rec, "unit-mixed record WITH authoritative pnl must be recorded");
  assert(rec.pnl_pct === -1.2, `must use settled value: expected -1.2, got ${rec.pnl_pct}`);
  console.log("  ✓ unitMix guard: skips without authoritative, records with it");
}

const savedLessons = backup(LESSONS_PATH);
const savedPoolMem = backup(POOLMEM_PATH);
try {
  fs.writeFileSync(LESSONS_PATH, JSON.stringify({ lessons: [], performance: [] }));
  fs.writeFileSync(POOLMEM_PATH, JSON.stringify({}));

  await testAuthoritativePnlWins();
  await testDerivedFallbackUnchanged();
  await testUnitMixGuard();

  console.log("\nAll lessons-pnl-authoritative tests passed ✅");
} finally {
  restore(LESSONS_PATH, savedLessons);
  restore(POOLMEM_PATH, savedPoolMem);
}
process.exit(0);
