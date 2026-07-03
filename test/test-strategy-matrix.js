/**
 * Unit tests for the strategy matrix, OOR risk score, and pool-memory
 * cooldown stacking (no network).
 * Run: node test/test-strategy-matrix.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { classifyMarketView, buildDeployPlan, computeOorRisk } from "../tools/strategy-router.js";
import { recordPoolDeploy, isPoolOnCooldown, getPoolCooldownReason } from "../pool-memory.js";
import { passesChartExitPnlGate } from "../tools/chart-indicators.js";
import { config } from "../config.js";

const POOL_MEMORY_PATH = repoPath("pool-memory.json");

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

// ── OOR risk score ─────────────────────────────────────────────
function testOorRisk() {
  // FABLE pattern: volatile, pumping, zero upside cover, narrow-ish range
  const fable = computeOorRisk({ volatility: 6, priceChange1h: 22, binsBelow: 69, binsAbove: 0 });
  assert(fable > 70, `FABLE pattern should score >70, got ${fable}`);

  // Calm sideways spot with upside cover
  const calm = computeOorRisk({ volatility: 2, priceChange1h: 3, binsBelow: 75, binsAbove: 25 });
  assert(calm < 40, `calm spot should score <40, got ${calm}`);

  // Upside cover on a pump strictly reduces risk vs no cover
  const noCover = computeOorRisk({ volatility: 4, priceChange1h: 18, binsBelow: 80, binsAbove: 0 });
  const withCover = computeOorRisk({ volatility: 4, priceChange1h: 18, binsBelow: 40, binsAbove: 40 });
  assert(withCover < noCover, `upside cover should reduce risk (${withCover} vs ${noCover})`);

  // Bounded 0-100 and handles missing inputs
  const unknown = computeOorRisk({});
  assert(unknown >= 0 && unknown <= 100, `unknown inputs should stay in 0-100, got ${unknown}`);

  console.log(`  oor_risk: FABLE=${fable} calm=${calm} cover ${withCover}<${noCover} OK`);
}

// ── Strategy matrix ────────────────────────────────────────────
function testStrategyMatrix() {
  // pump view >15% 1h + bullish ST
  const pumpView = classifyMarketView({
    pool: { volatility: 4 },
    priceChange1h: 18,
    signal: { supertrendDirection: "bullish" },
  });
  assert(pumpView.view === "pump", `18% 1h + bullish should classify pump, got ${pumpView.view}`);

  // Matrix: pump → spot balanced, never bid_ask SOL-below
  const pumpPlan = buildDeployPlan({
    pool: { volatility: 4, fee_active_tvl_ratio: 0.5 },
    classification: pumpView,
    signal: { supertrendDirection: "bullish" },
    fibHint: null,
  });
  assert(pumpPlan.strategy === "spot", `pump plan should be spot, got ${pumpPlan.strategy}`);
  assert(pumpPlan.bins_above > 0, `pump plan needs upside cover, got bins_above=${pumpPlan.bins_above}`);
  assert(
    !(pumpPlan.strategy === "bid_ask" && pumpPlan.deposit_side === "sol_below"),
    "pump plan must never be bid_ask SOL-below",
  );

  // Matrix: breakdown → bid_ask wide SOL below, no upside bins
  const breakdownPlan = buildDeployPlan({
    pool: { volatility: 4, fee_active_tvl_ratio: 0.5 },
    classification: { view: "breakdown", reason: "test" },
    signal: null,
    fibHint: null,
  });
  assert(breakdownPlan.strategy === "bid_ask", `breakdown should be bid_ask, got ${breakdownPlan.strategy}`);
  assert(breakdownPlan.bins_above === 0, `breakdown should have 0 upside bins, got ${breakdownPlan.bins_above}`);
  assert(breakdownPlan.bins_below >= 69, `breakdown should be wide, got ${breakdownPlan.bins_below} bins`);

  // Matrix: sideways → spot with below/above split
  const sidewaysPlan = buildDeployPlan({
    pool: { volatility: 3, fee_active_tvl_ratio: 0.5 },
    classification: { view: "sideways", reason: "test" },
    signal: null,
    fibHint: null,
  });
  assert(sidewaysPlan.strategy === "spot", `sideways should be spot, got ${sidewaysPlan.strategy}`);
  assert(sidewaysPlan.bins_below > sidewaysPlan.bins_above, "sideways spot should be bottom-weighted");

  console.log(`  matrix: pump=spot(${pumpPlan.bins_below}/${pumpPlan.bins_above}) breakdown=bid_ask(${breakdownPlan.bins_below}) sideways=spot OK`);
}

// ── Pool-memory cooldown stacking ──────────────────────────────
function testCooldownStacking() {
  const saved = backup(POOL_MEMORY_PATH);
  const pool = "TEST_POOL_COOLDOWN_STACK_11111111111111111111";
  try {
    fs.writeFileSync(POOL_MEMORY_PATH, "{}");

    // 1. Loss close → 24h cooldown
    recordPoolDeploy(pool, {
      pool_name: "TEST-SOL",
      base_mint: "TESTMINT1111111111111111111111111111111111",
      pnl_pct: -3.2,
      close_reason: "stop loss",
    });
    assert(isPoolOnCooldown(pool), "loss close should set pool cooldown");
    const lossUntil = new Date(JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"))[pool].cooldown_until);

    // 2. Win+OOR close afterwards (shorter, ~3h) must NOT truncate the 24h cooldown
    recordPoolDeploy(pool, {
      pool_name: "TEST-SOL",
      pnl_pct: 0.19,
      close_reason: "pumped far above range (out of range)",
    });
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"));
    const stackedUntil = new Date(db[pool].cooldown_until);
    assert(stackedUntil >= lossUntil, `shorter cooldown must not truncate longer one (${stackedUntil.toISOString()} < ${lossUntil.toISOString()})`);
    assert(
      db[pool].base_mint_cooldown_until != null,
      "base mint cooldown should be set too",
    );

    // 3. Win+OOR on a fresh pool sets its own short cooldown
    const pool2 = "TEST_POOL_WINOOR_2222222222222222222222222222";
    recordPoolDeploy(pool2, {
      pool_name: "TEST2-SOL",
      pnl_pct: 1.5,
      close_reason: "out of range",
    });
    assert(isPoolOnCooldown(pool2), "win+OOR close should set cooldown");
    const reason = getPoolCooldownReason(pool2) || "";
    assert(reason.includes("volatile OOR"), `cooldown reason should mention volatile OOR, got "${reason}"`);

    console.log("  pool-memory: loss 24h kept over win+OOR 3h; win+OOR sets own cooldown OK");
  } finally {
    restore(POOL_MEMORY_PATH, saved);
  }
}

// ── Chart exit PnL gate ────────────────────────────────────────
function testChartExitPnlGate() {
  const savedMin = config.indicators.chartExitMinPnlPct;
  try {
    config.indicators.chartExitMinPnlPct = 0.5;

    // traindog case: +0.07% peak must be blocked
    assert(!passesChartExitPnlGate({ pnl_pct: 0.07 }), "chart exit must be blocked at +0.07%");
    // above threshold: allowed
    assert(passesChartExitPnlGate({ pnl_pct: 0.6 }), "chart exit must be allowed at +0.6%");
    // exactly at threshold: allowed
    assert(passesChartExitPnlGate({ pnl_pct: 0.5 }), "chart exit must be allowed at exactly +0.5%");
    // losing / unknown / suspicious: always blocked
    assert(!passesChartExitPnlGate({ pnl_pct: -1.2 }), "chart exit must be blocked on a losing position");
    assert(!passesChartExitPnlGate({}), "chart exit must be blocked when PnL unknown");
    assert(!passesChartExitPnlGate({ pnl_pct: 2, pnl_pct_suspicious: true }), "chart exit must be blocked on suspicious PnL");

    console.log("  chart-exit gate: 0.07% blocked, 0.6% allowed, loss/unknown/suspicious blocked OK");
  } finally {
    config.indicators.chartExitMinPnlPct = savedMin;
  }
}

function main() {
  testOorRisk();
  testStrategyMatrix();
  testCooldownStacking();
  testChartExitPnlGate();
  console.log("test-strategy-matrix: OK");
}

main();
