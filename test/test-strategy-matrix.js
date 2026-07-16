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
  applySpotDumpGate,
  applyBidAskWideRange,
  resolveAthGateOutcome,
  resolveDeployStrategyForCandidate,
} from "../tools/strategy-router.js";
import { recordPoolDeploy, isPoolOnCooldown, getPoolCooldownReason } from "../pool-memory.js";
import { passesChartExitPnlGate, isNewAthFromCandles, evaluateAthEntryGate, evaluatePreset, computeMacdFromCandles } from "../tools/chart-indicators.js";
import { computeHolderRatios } from "../tools/gmgn.js";
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
  // Pin: live user-config may run with spot disabled (owner interim toggle)
  const savedSpot = config.autoStrategy.allowSpot;
  config.autoStrategy.allowSpot = true;
  try {
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
  } finally {
    config.autoStrategy.allowSpot = savedSpot;
  }
}

// ── Vladimir-style bid_ask wide range ─────────────────────────
function testBidAskWideRange() {
  const saved = config.autoStrategy.bidAskWideRangeEnabled;
  config.autoStrategy.bidAskWideRangeEnabled = true;
  try {
    const young = applyBidAskWideRange(
      { strategy: "bid_ask", deposit_side: "sol_below", bins_below: 100, bins_above: 0, notes: [] },
      { pool: { token_age_hours: 12, price_change_1h: 5 }, priceChange1h: 5 },
    );
    assert(young.downside_pct === 90, `young token should get 90% downside, got ${young.downside_pct}`);
    assert(young.bins_below === undefined, "wide range should clear bins_below");

    const mature = applyBidAskWideRange(
      { strategy: "bid_ask", deposit_side: "sol_below", bins_below: 100, bins_above: 0, notes: [] },
      { pool: { token_age_hours: 200, price_change_1h: 2 }, priceChange1h: 2 },
    );
    assert(mature.downside_pct === 65, `mature token should get 65%, got ${mature.downside_pct}`);

    const spotUntouched = applyBidAskWideRange(
      { strategy: "spot", bins_below: 50, bins_above: 50, notes: [] },
      { pool: { token_age_hours: 12 } },
    );
    assert(spotUntouched.downside_pct == null, "spot must not get wide range");

    console.log("  bid_ask wide range: young=90% mature=65% spot=untouched OK");
  } finally {
    config.autoStrategy.bidAskWideRangeEnabled = saved;
  }
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
  const savedHours = config.management.winRedeployCooldownHours;
  try {
    // Pin config — live user-config may disable this (e.g. hours: 0)
    config.management.winRedeployCooldownEnabled = true;
    config.management.winRedeployCooldownHours = 3;
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
    config.management.winRedeployCooldownHours = savedHours;
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

// ── MACD histogram + evil panda MACD trigger ───────────────────
function testMacdExit() {
  const mkCandles = (closes) => closes.map((close) => ({ close }));

  // Not enough candles → null
  assert(computeMacdFromCandles(mkCandles([1, 2, 3])) == null, "short series must return null");
  assert(computeMacdFromCandles(null) == null, "null candles must return null");

  // Downtrend then sharp reversal: histogram must flip negative → positive,
  // and turnedGreen must be true exactly on the first positive bar.
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 - i); // decline to 61
  for (let i = 0; i < 15; i++) closes.push(61 + i * 4); // sharp bounce

  let sawGreenFlip = false;
  let prevHistSign = null;
  for (let len = 36; len <= closes.length; len++) {
    const m = computeMacdFromCandles(mkCandles(closes.slice(0, len)));
    if (!m) continue;
    assert(
      m.turnedGreen === (m.hist > 0 && m.prevHist <= 0),
      `turnedGreen must match hist sign flip at len ${len}`,
    );
    if (m.turnedGreen) {
      assert(prevHistSign === "neg", "green flip must follow a negative bar");
      sawGreenFlip = true;
    }
    prevHistSign = m.hist > 0 ? "pos" : "neg";
  }
  assert(sawGreenFlip, "reversal series must produce exactly one green flip");

  // Pure decline: histogram never turns green
  const declineOnly = mkCandles(closes.slice(0, 40));
  const md = computeMacdFromCandles(declineOnly);
  assert(md && md.hist <= 0 && !md.turnedGreen, "pure decline must not flip green");

  // evil_panda_exit MACD trigger honors the enable flag
  const savedFlag = config.indicators.evilPandaMacdExitEnabled;
  try {
    // Find a prefix where the flip happens and build a payload around it
    let flipLen = null;
    for (let len = 36; len <= closes.length; len++) {
      if (computeMacdFromCandles(mkCandles(closes.slice(0, len)))?.turnedGreen) { flipLen = len; break; }
    }
    assert(flipLen != null, "flip length must exist");
    const payload = {
      candles: mkCandles(closes.slice(0, flipLen)),
      latest: {
        candle: { close: 100 },
        previousCandle: { close: 100 },
        rsi: { value: 50 }, // quiet — RSI must not be the trigger
        bollinger: { upper: 200, middle: 150, lower: 100 }, // far below upper
        supertrend: { value: 110, direction: "bearish" },
        states: { supertrendBreakDown: false },
      },
    };

    config.indicators.evilPandaMacdExitEnabled = true;
    let r = evaluatePreset("exit", "evil_panda_exit", payload);
    assert(r.confirmed && r.reason.includes("MACD"), `MACD flip must confirm when enabled, got: ${r.reason}`);

    config.indicators.evilPandaMacdExitEnabled = false;
    r = evaluatePreset("exit", "evil_panda_exit", payload);
    assert(!r.confirmed, "MACD flip must be ignored when disabled");

    console.log("  macd-exit: hist flip detected once, decline stays red, flag gates trigger OK");
  } finally {
    config.indicators.evilPandaMacdExitEnabled = savedFlag;
  }
}

// ── GMGN holder ratios ─────────────────────────────────────────
function testHolderRatios() {
  const stats = { fresh_wallet_count: 30, bundlers_in_top_100: 12 };

  let r = computeHolderRatios(stats, 600);
  assert(r.fresh_wallet_holder_pct === 5, `expected fresh 5%, got ${r.fresh_wallet_holder_pct}`);
  assert(r.bundled_wallet_holder_pct === 2, `expected bundled 2%, got ${r.bundled_wallet_holder_pct}`);

  // Rounding to 2 decimals
  r = computeHolderRatios({ fresh_wallet_count: 1, bundlers_in_top_100: 1 }, 300);
  assert(r.fresh_wallet_holder_pct === 0.33, `expected 0.33, got ${r.fresh_wallet_holder_pct}`);

  // Missing sides → nulls (gate stays open)
  r = computeHolderRatios(null, 600);
  assert(r.fresh_wallet_holder_pct == null && r.bundled_wallet_holder_pct == null, "missing stats must yield nulls");
  r = computeHolderRatios(stats, 0);
  assert(r.fresh_wallet_holder_pct == null, "zero holders must yield nulls");
  r = computeHolderRatios(stats, null);
  assert(r.bundled_wallet_holder_pct == null, "null holders must yield nulls");
  r = computeHolderRatios({ }, 600);
  assert(r.fresh_wallet_holder_pct == null, "missing counts must yield nulls");

  console.log("  holder-ratios: pct math, rounding, missing-side nulls OK");
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

// ── Spot dump gate (P1c, SPOT_LOSS_ANALYSIS.md — SEMAN lesson) ─────
function testSpotDumpGate() {
  const savedCap = config.autoStrategy.maxPumpPct1h;
  try {
    config.autoStrategy.maxPumpPct1h = 15;

    // Replay: SEMAN spot 62/20 deployed while token was actively dumping
    // -28.65% 1h (SPOT_LOSS_ANALYSIS.md) — must now be blocked.
    const seman = applySpotDumpGate(
      { strategy: "spot", market_view: "retracement", entry_allowed: true, entry_reason: "ok", notes: [] },
      { priceChange1h: -28.65 },
    );
    assert(!seman.entry_allowed, "spot entry during -28.65% 1h dump must be blocked");
    assert(/dump/i.test(seman.entry_reason), `entry_reason should mention the dump, got: ${seman.entry_reason}`);

    // Mild dump within cap → spot still allowed.
    const mild = applySpotDumpGate(
      { strategy: "spot", market_view: "sideways", entry_allowed: true, entry_reason: "ok", notes: [] },
      { priceChange1h: -5 },
    );
    assert(mild.entry_allowed, "mild -5% dump (within 15% cap) must not block spot");

    // bid_ask (ladder buy into a dip) is by design — gate is spot-only.
    const bidAsk = applySpotDumpGate(
      { strategy: "bid_ask", market_view: "retracement", entry_allowed: true, entry_reason: "ok", notes: [] },
      { priceChange1h: -28.65 },
    );
    assert(bidAsk.entry_allowed, "bid_ask ladder-buy must not be touched by the spot-only dump gate");

    // Missing price data fails open, consistent with the other indicator gates.
    const noData = applySpotDumpGate(
      { strategy: "spot", market_view: "retracement", entry_allowed: true, entry_reason: "ok", notes: [] },
      { priceChange1h: null },
    );
    assert(noData.entry_allowed, "missing priceChange1h must fail open (consistent with other gates)");

    console.log("  spot dump gate: SEMAN -28.65% replay blocked, mild dump allowed, bid_ask untouched, missing-data fail-open OK");
  } finally {
    config.autoStrategy.maxPumpPct1h = savedCap;
  }
}

// ── ATH gate fail-open/fail-closed (P2a, SPOT_LOSS_ANALYSIS.md) ────
function testAthGateFailMode() {
  // Indicators available, gate passes → never blocked, regardless of fail mode.
  const passResult = { pass: true };
  assert(!resolveAthGateOutcome(passResult, "open").blocked, "passing gate must not block (open)");
  assert(!resolveAthGateOutcome(passResult, "closed").blocked, "passing gate must not block (closed)");

  // Indicators available, gate fails → always blocked, regardless of fail mode.
  const failResult = { pass: false, reason: "no fresh ATH" };
  const openFail = resolveAthGateOutcome(failResult, "open");
  assert(openFail.blocked && openFail.reason === "no fresh ATH", "failing gate must block and carry its reason (open)");
  const closedFail = resolveAthGateOutcome(failResult, "closed");
  assert(closedFail.blocked && closedFail.reason === "no fresh ATH", "failing gate must block and carry its reason (closed)");

  // Indicators unavailable (athGate === null) — this is the actual fail-mode split.
  const openUnavailable = resolveAthGateOutcome(null, "open");
  assert(!openUnavailable.blocked, "unavailable indicators must NOT block in fail-open (default) mode");
  assert(/fail-open/.test(openUnavailable.note), "fail-open must leave an explanatory note");

  const closedUnavailable = resolveAthGateOutcome(null, "closed");
  assert(closedUnavailable.blocked, "unavailable indicators must block in fail-closed mode");
  assert(/fail-closed/.test(closedUnavailable.reason), "fail-closed must carry an explanatory reason");

  // Undefined/missing failMode must default to the safe "open" behavior (backward compat).
  assert(!resolveAthGateOutcome(null, undefined).blocked, "missing failMode must default to fail-open");

  console.log("  ath-gate fail-mode: pass/fail always deterministic, unavailable splits open-vs-closed, default is open OK");
}

// ── Volatile-pool recall (force spot on recent pump-OOR close) ─
async function testVolatileRecall() {
  const saved = backup(POOL_MEMORY_PATH);
  const savedFetch = config.autoStrategy.fetchIndicators;
  const savedSpot = config.autoStrategy.allowSpot;
  const savedFee = config.autoStrategy.spotFeeTvlMin;
  const savedPreferSpot = config.autoStrategy.preferSpotHighFee;
  const pool = "TEST_POOL_VOLATILE_RECALL_333333333333333333";
  try {
    fs.writeFileSync(POOL_MEMORY_PATH, "{}");
    config.autoStrategy.fetchIndicators = false; // no network in tests
    config.autoStrategy.allowSpot = true; // live user-config may run with spot off
    config.autoStrategy.spotFeeTvlMin = 0.4; // below the 0.5 test fee — floor exercised separately
    config.autoStrategy.preferSpotHighFee = false; // isolate the recall-forces-spot path from the unrelated high-fee-prefers-spot path

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
    config.autoStrategy.allowSpot = savedSpot;
    config.autoStrategy.spotFeeTvlMin = savedFee;
    config.autoStrategy.preferSpotHighFee = savedPreferSpot;
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
  testBidAskWideRange();
  testCooldownStacking();
  testWinRedeployCooldown();
  testChartExitPnlGate();
  testEvilPandaExit();
  testMacdExit();
  testHolderRatios();
  testPumpUpsideCoverGate();
  testSpotDumpGate();
  testAthGateFailMode();
  await testVolatileRecall();
  testAthEntryGate();
  console.log("test-strategy-matrix: OK");
}

await main();
