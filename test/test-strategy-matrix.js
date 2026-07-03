/**
 * Unit tests for the strategy matrix, OOR risk score, and pool-memory
 * cooldown stacking (no network).
 * Run: node test/test-strategy-matrix.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  classifyMarketView,
  buildDeployPlan,
  computeOorRisk,
  applyPumpUpsideCoverGate,
  resolveDeployStrategyForCandidate,
} from "../tools/strategy-router.js";
import { recordPoolDeploy, isPoolOnCooldown, getPoolCooldownReason } from "../pool-memory.js";
import { passesChartExitPnlGate, isNewAthFromCandles, evaluateAthEntryGate, evaluatePreset } from "../tools/chart-indicators.js";
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

// ── Win redeploy cooldown (clean in-range win) ─────────────────
function testWinRedeployCooldown() {
  const saved = backup(POOL_MEMORY_PATH);
  const savedEnabled = config.management.winRedeployCooldownEnabled;
  try {
    fs.writeFileSync(POOL_MEMORY_PATH, "{}");

    // 1. Trailing TP win in range → pool + mint cooldown (BABYANSEM round-2 pattern)
    const pool = "TEST_POOL_WIN_TRAILING_111111111111111111111";
    recordPoolDeploy(pool, {
      pool_name: "WINTEST-SOL",
      base_mint: "WINMINT111111111111111111111111111111111111",
      pnl_pct: 3.93,
      close_reason: "Trailing TP: peak 4.84% → current 3.93% (dropped 0.91% >= 0.8%)",
    });
    assert(isPoolOnCooldown(pool), "trailing TP win should set pool cooldown");
    const reason = getPoolCooldownReason(pool) || "";
    assert(reason.includes("in-range win"), `cooldown reason should mention in-range win, got "${reason}"`);
    const db1 = JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"));
    assert(db1[pool].base_mint_cooldown_until != null, "trailing TP win should set base mint cooldown too");

    // 2. Take profit win → cooldown
    const pool2 = "TEST_POOL_WIN_TP_222222222222222222222222222";
    recordPoolDeploy(pool2, { pool_name: "TP-SOL", pnl_pct: 5.1, close_reason: "take profit" });
    assert(isPoolOnCooldown(pool2), "take profit win should set pool cooldown");

    // 3. Win via OOR → win cooldown must NOT claim it (winOor path owns it)
    const pool3 = "TEST_POOL_WIN_OOR_33333333333333333333333333";
    recordPoolDeploy(pool3, { pool_name: "OOR-SOL", pnl_pct: 1.2, close_reason: "pumped far above range (out of range)" });
    const oorReason = getPoolCooldownReason(pool3) || "";
    assert(oorReason.includes("volatile OOR"), `OOR win should keep volatile OOR reason, got "${oorReason}"`);

    // 4. Trailing-worded close that ended in loss → loss cooldown, not win cooldown
    const pool4 = "TEST_POOL_TRAIL_LOSS_44444444444444444444444";
    recordPoolDeploy(pool4, { pool_name: "TL-SOL", pnl_pct: -0.4, close_reason: "Trailing TP: peak 1% → current -0.4%" });
    const lossReason = getPoolCooldownReason(pool4) || "";
    assert(lossReason.includes("loss close"), `trailing loss should get loss cooldown, got "${lossReason}"`);

    // 5. Neutral win (agent decision) → no win cooldown
    const pool5 = "TEST_POOL_NEUTRAL_5555555555555555555555555";
    recordPoolDeploy(pool5, { pool_name: "N-SOL", pnl_pct: 0.8, close_reason: "agent decision" });
    assert(!isPoolOnCooldown(pool5), "neutral win close must not set win cooldown");

    // 6. Disabled → no cooldown
    config.management.winRedeployCooldownEnabled = false;
    const pool6 = "TEST_POOL_DISABLED_666666666666666666666666";
    recordPoolDeploy(pool6, { pool_name: "D-SOL", pnl_pct: 4.0, close_reason: "take profit" });
    assert(!isPoolOnCooldown(pool6), "win cooldown must not fire when disabled");

    console.log("  win-cooldown: trailing/TP win blocks pool+mint, OOR/loss/neutral/disabled untouched OK");
  } finally {
    config.management.winRedeployCooldownEnabled = savedEnabled;
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

// ── Evil Panda exit preset ─────────────────────────────────────
function testEvilPandaExit() {
  const payload = ({ direction, rsi, close, upper, breakDown = false }) => ({
    latest: {
      candle: { close },
      previousCandle: { close },
      rsi: { value: rsi },
      bollinger: { upper, middle: upper * 0.9, lower: upper * 0.8 },
      supertrend: { value: close * 1.05, direction },
      states: { supertrendBreakDown: breakDown },
    },
  });

  // Armed (bearish) + RSI(2) spike ≥ 90 → exit
  let r = evaluatePreset("exit", "evil_panda_exit", payload({ direction: "bearish", rsi: 95, close: 100, upper: 120 }));
  assert(r.confirmed, `bearish + RSI 95 must confirm, got: ${r.reason}`);

  // Armed + close at/above BB upper (RSI quiet) → exit
  r = evaluatePreset("exit", "evil_panda_exit", payload({ direction: "bearish", rsi: 50, close: 125, upper: 120 }));
  assert(r.confirmed, `bearish + BB-upper close must confirm, got: ${r.reason}`);

  // Armed but no strength candle yet → hold
  r = evaluatePreset("exit", "evil_panda_exit", payload({ direction: "bearish", rsi: 50, close: 100, upper: 120 }));
  assert(!r.confirmed, "bearish without RSI/BB spike must not confirm");

  // Not armed: supertrend still bullish, even with RSI spike → hold
  r = evaluatePreset("exit", "evil_panda_exit", payload({ direction: "bullish", rsi: 95, close: 100, upper: 120 }));
  assert(!r.confirmed, "bullish supertrend must keep the position (not armed)");

  // Fresh break-down flag arms it even before direction settles
  r = evaluatePreset("exit", "evil_panda_exit", payload({ direction: "bullish", rsi: 95, close: 100, upper: 120, breakDown: true }));
  assert(r.confirmed, "fresh supertrendBreakDown + RSI spike must confirm");

  // Exit-only preset
  r = evaluatePreset("entry", "evil_panda_exit", payload({ direction: "bearish", rsi: 95, close: 125, upper: 120 }));
  assert(!r.confirmed, "evil_panda_exit must never confirm entries");

  console.log("  evil-panda exit: armed-break + RSI/BB fires, unarmed/quiet/entry held OK");
}

// ── Pump upside-cover gate ─────────────────────────────────────
function testPumpUpsideCoverGate() {
  const savedMin = config.autoStrategy.minUpsideCoverPctPump;
  try {
    config.autoStrategy.minUpsideCoverPctPump = 25;

    // pump view, zero upside cover → blocked
    const blocked = applyPumpUpsideCoverGate({
      market_view: "pump", bins_below: 80, bins_above: 0, entry_allowed: true, entry_reason: "ok",
    });
    assert(!blocked.entry_allowed, "pump with 0% upside cover must be blocked");
    assert(blocked.upside_cover_pct === 0, `cover should be 0, got ${blocked.upside_cover_pct}`);

    // pump view, balanced 50/50 → allowed
    const allowed = applyPumpUpsideCoverGate({
      market_view: "pump", bins_below: 48, bins_above: 48, entry_allowed: true, entry_reason: "ok",
    });
    assert(allowed.entry_allowed, "pump with 50% upside cover must pass");

    // non-pump view with 0 cover → untouched (gate is pump-only)
    const retrace = applyPumpUpsideCoverGate({
      market_view: "retracement", bins_below: 100, bins_above: 0, entry_allowed: true, entry_reason: "ok",
    });
    assert(retrace.entry_allowed, "retracement bid_ask below must not be blocked by pump gate");

    console.log("  pump-cover gate: 0% blocked, 50% allowed, non-pump untouched OK");
  } finally {
    config.autoStrategy.minUpsideCoverPctPump = savedMin;
  }
}

// ── Volatile-pool recall (force spot on recent pump-OOR close) ─
async function testVolatileRecall() {
  const saved = backup(POOL_MEMORY_PATH);
  const savedFetch = config.autoStrategy.fetchIndicators;
  const pool = "TEST_POOL_VOLATILE_RECALL_333333333333333333";
  try {
    fs.writeFileSync(POOL_MEMORY_PATH, "{}");
    config.autoStrategy.fetchIndicators = false; // no network in tests

    // Record a FABLE-style close: win but pumped far above range
    recordPoolDeploy(pool, {
      pool_name: "TESTV-SOL",
      pnl_pct: 0.19,
      close_reason: "pumped far above range",
    });

    // Redeploy attempt on the same pool: plan must be forced to spot
    const plan = await resolveDeployStrategyForCandidate({
      pool: { pool, volatility: 3, price_change_1h: -20, fee_active_tvl_ratio: 0.5 },
    });
    assert(plan.strategy === "spot", `volatile-recall plan must be spot, got ${plan.strategy}`);
    assert(plan.bins_above > 0, `volatile-recall plan needs upside cover, got bins_above=${plan.bins_above}`);

    // Fresh pool with same market data keeps its normal (bid_ask) plan
    const fresh = await resolveDeployStrategyForCandidate({
      pool: { pool: "TEST_POOL_FRESH_4444444444444444444444444444", volatility: 3, price_change_1h: -20, fee_active_tvl_ratio: 0.5 },
    });
    assert(fresh.strategy === "bid_ask", `fresh pool should keep bid_ask retracement plan, got ${fresh.strategy}`);

    console.log(`  volatile recall: forced spot(${plan.bins_below}/${plan.bins_above}), fresh pool keeps bid_ask OK`);
  } finally {
    config.autoStrategy.fetchIndicators = savedFetch;
    restore(POOL_MEMORY_PATH, saved);
  }
}

// ── ATH entry gate (Evil Panda) ────────────────────────────────
function testAthEntryGate() {
  const candle = (high) => ({ high, open: high * 0.99, low: high * 0.98, close: high * 0.995 });

  // Rising series: latest candle sets a new high over the window
  const rising = [...Array(47)].map((_, i) => candle(100 + i)).concat([candle(150)]);
  const athYes = isNewAthFromCandles(rising, 48);
  assert(athYes.isNewAth, `rising series should be new ATH: ${athYes.reason}`);

  // Peak in the middle: latest high below window high
  const peaked = [...Array(20)].map((_, i) => candle(100 + i)).concat([candle(200)], [...Array(27)].map(() => candle(120)));
  const athNo = isNewAthFromCandles(peaked, 48);
  assert(!athNo.isNewAth, `peaked series must not be new ATH: ${athNo.reason}`);

  // Degenerate inputs never pass
  assert(!isNewAthFromCandles([], 48).isNewAth, "empty candles must not pass");
  assert(!isNewAthFromCandles(null, 48).isNewAth, "null candles must not pass");

  // Full gate: ATH + supertrend up → pass
  const bullSignal = { supertrendBreakUp: true, supertrendDirection: "bullish", close: 150, supertrendValue: 140 };
  const gatePass = evaluateAthEntryGate({ candles: rising }, bullSignal, 48);
  assert(gatePass.pass, `ATH + ST-up must pass: ${gatePass.reason}`);

  // ATH but supertrend bearish → blocked
  const bearSignal = { supertrendBreakUp: false, supertrendDirection: "bearish", close: 150, supertrendValue: 160 };
  const gateBearish = evaluateAthEntryGate({ candles: rising }, bearSignal, 48);
  assert(!gateBearish.pass, "ATH without supertrend confirmation must be blocked");

  // Supertrend up but no ATH → blocked
  const gateNoAth = evaluateAthEntryGate({ candles: peaked }, bullSignal, 48);
  assert(!gateNoAth.pass, "supertrend up without new ATH must be blocked");

  console.log("  ath gate: new-ATH+ST pass, no-ATH blocked, bearish blocked, degenerate blocked OK");
}

async function main() {
  testOorRisk();
  testStrategyMatrix();
  testCooldownStacking();
  testWinRedeployCooldown();
  testChartExitPnlGate();
  testEvilPandaExit();
  testPumpUpsideCoverGate();
  await testVolatileRecall();
  testAthEntryGate();
  console.log("test-strategy-matrix: OK");
}

await main();
