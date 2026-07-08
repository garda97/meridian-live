/**
 * Unit tests for volatility-adaptive rebalance timing and volatility-aware
 * bin-step screening (pure, no network).
 * Run: node test/test-volatility-adaptive.js
 */

import { volatilityScaledRebalanceTiming, shouldRebalance } from "../tools/position-router.js";
import { volatilityScaledBinStepWindow, getRawPoolScreeningRejectReason } from "../tools/screening.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const BASES = { baseOorMinutes: 5, baseCooldownMinutes: 15 };

// ── volatilityScaledRebalanceTiming ────────────────────────────
function testRebalanceTimingScaling() {
  // Invalid/missing volatility → flat base passthrough
  for (const vol of [null, undefined, 0, -1, "garbage", NaN]) {
    const t = volatilityScaledRebalanceTiming(vol, BASES);
    assert(t.oorMinutes === 5 && t.cooldownMinutes === 15, `vol=${vol} must pass bases through, got ${JSON.stringify(t)}`);
  }

  // High volatility → faster timing (scaled DOWN)
  const fast = volatilityScaledRebalanceTiming(5, BASES);
  assert(fast.oorMinutes < 5 && fast.cooldownMinutes < 15, `vol=5 must shrink timers, got ${JSON.stringify(fast)}`);

  // Low volatility → slower timing (scaled UP)
  const slow = volatilityScaledRebalanceTiming(0.5, BASES);
  assert(slow.oorMinutes > 5 && slow.cooldownMinutes > 15, `vol=0.5 must stretch timers, got ${JSON.stringify(slow)}`);

  // Monotonic: more volatility never waits longer
  const mid = volatilityScaledRebalanceTiming(2.5, BASES);
  assert(fast.cooldownMinutes < mid.cooldownMinutes && mid.cooldownMinutes < slow.cooldownMinutes,
    `cooldown must fall as vol rises: ${fast.cooldownMinutes} < ${mid.cooldownMinutes} < ${slow.cooldownMinutes}`);

  // Bounds: never below 30% or above 200% of base
  const extreme = volatilityScaledRebalanceTiming(100, BASES);
  assert(extreme.cooldownMinutes >= 15 * 0.3 - 1e-9, `vol=100 must clamp at 30% of base, got ${extreme.cooldownMinutes}`);
  const calm = volatilityScaledRebalanceTiming(0.001, BASES);
  assert(calm.cooldownMinutes <= 15 * 2 + 1e-9, `vol→0 must clamp at 200% of base, got ${calm.cooldownMinutes}`);

  console.log(`  timing: flat passthrough, fast=${fast.cooldownMinutes}m mid=${mid.cooldownMinutes}m slow=${slow.cooldownMinutes}m, bounds OK`);
}

// ── shouldRebalance timing gates (flag off vs on) ──────────────
function testShouldRebalanceTimingGates() {
  const mgmtFlat = {
    autoRebalanceEnabled: true,
    rebalanceMinOorMinutes: 5,
    rebalanceMaxPerPosition: 3,
    rebalanceCooldownMinutes: 15,
    rebalanceMinPnlPct: -8,
  };
  const mgmtScaled = { ...mgmtFlat, rebalanceVolatilityScalingEnabled: true };
  const plan = (volatility) => ({ action: "rebalance", reason: "test", oor_direction: "up", volatility });

  // Cooldown gate: 6 minutes since last attempt vs 15m base cooldown
  const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
  const tracked = { rebalance_count: 0, last_rebalance_attempt_at: sixMinAgo };
  const position = { pnl_pct: 1, minutes_out_of_range: 10 };

  // Flag OFF: flat 15m cooldown holds even with high volatility on the plan
  const off = shouldRebalance({ plan: plan(5), position, tracked, mgmtConfig: mgmtFlat });
  assert(off.action === "hold" && off.reason.includes("cooldown"), `flag off must hold on flat cooldown, got ${off.action}: ${off.reason}`);

  // Flag ON + high vol: cooldown shrinks to 4.5m → 6m elapsed clears it
  const on = shouldRebalance({ plan: plan(5), position, tracked, mgmtConfig: mgmtScaled });
  assert(on.action === "rebalance", `flag on + vol 5 must clear shrunk cooldown, got ${on.action}: ${on.reason}`);

  // Flag ON but volatility unavailable: identical to flag off
  const onNoVol = shouldRebalance({ plan: plan(null), position, tracked, mgmtConfig: mgmtScaled });
  assert(onNoVol.action === "hold" && onNoVol.reason.includes("cooldown"), `flag on without vol must behave flat, got ${onNoVol.action}: ${onNoVol.reason}`);

  // OOR gate: 6m OOR vs 5m base window
  const posOor6 = { pnl_pct: 1, minutes_out_of_range: 6 };
  const freshTracked = { rebalance_count: 0 };

  // Flag OFF: 6 >= 5 → rebalance
  const offOor = shouldRebalance({ plan: plan(0.5), position: posOor6, tracked: freshTracked, mgmtConfig: mgmtFlat });
  assert(offOor.action === "rebalance", `flag off 6m OOR >= 5m must rebalance, got ${offOor.action}: ${offOor.reason}`);

  // Flag ON + LOW vol: window stretches past 6m → wait
  const onOorSlow = shouldRebalance({ plan: plan(0.5), position: posOor6, tracked: freshTracked, mgmtConfig: mgmtScaled });
  assert(onOorSlow.action === "hold" && onOorSlow.reason.includes("rebalanceMinOorMinutes"), `flag on + low vol must stretch OOR wait, got ${onOorSlow.action}: ${onOorSlow.reason}`);

  // Flag ON + HIGH vol: window shrinks → 3m OOR already enough
  const posOor3 = { pnl_pct: 1, minutes_out_of_range: 3 };
  const onOorFast = shouldRebalance({ plan: plan(5), position: posOor3, tracked: freshTracked, mgmtConfig: mgmtScaled });
  assert(onOorFast.action === "rebalance", `flag on + vol 5 must shrink OOR wait, got ${onOorFast.action}: ${onOorFast.reason}`);

  console.log("  shouldRebalance: flat when off/no-vol, faster on high vol, slower on low vol OK");
}

// ── volatilityScaledBinStepWindow ──────────────────────────────
function testBinStepWindow() {
  const sOff = { minBinStep: 80, maxBinStep: 125 };
  const sOn = { ...sOff, binStepVolatilityScalingEnabled: true };

  // Flag off (absent or explicit false) → static window regardless of vol
  for (const s of [sOff, { ...sOff, binStepVolatilityScalingEnabled: false }]) {
    const w = volatilityScaledBinStepWindow(5, s);
    assert(w.minBinStep === 80 && w.maxBinStep === 125, `flag off must be static, got ${JSON.stringify(w)}`);
  }

  // Flag on but volatility unusable → static window
  for (const vol of [null, 0, -2, "x"]) {
    const w = volatilityScaledBinStepWindow(vol, sOn);
    assert(w.minBinStep === 80 && w.maxBinStep === 125, `flag on + vol=${vol} must be static, got ${JSON.stringify(w)}`);
  }

  // Flag on + high vol → window widens both ways
  const wide = volatilityScaledBinStepWindow(5, sOn);
  assert(wide.minBinStep < 80 && wide.maxBinStep > 125, `vol=5 must widen window, got ${JSON.stringify(wide)}`);
  assert(wide.minBinStep === 40 && wide.maxBinStep === 188, `vol=5 saturates at ±50%: expected {40,188}, got ${JSON.stringify(wide)}`);

  // Saturation: absurd volatility widens no further than vol=5
  const extreme = volatilityScaledBinStepWindow(100, sOn);
  assert(extreme.minBinStep === wide.minBinStep && extreme.maxBinStep === wide.maxBinStep,
    `vol=100 must saturate at the vol=5 window, got ${JSON.stringify(extreme)}`);

  // Moderate vol → partial widening, ordered between static and saturated
  const mid = volatilityScaledBinStepWindow(2.5, sOn);
  assert(mid.minBinStep > wide.minBinStep && mid.minBinStep < 80, `vol=2.5 min must sit between, got ${mid.minBinStep}`);
  assert(mid.maxBinStep < wide.maxBinStep && mid.maxBinStep > 125, `vol=2.5 max must sit between, got ${mid.maxBinStep}`);

  // Min bound can never collapse below 1
  const tiny = volatilityScaledBinStepWindow(5, { minBinStep: 1, maxBinStep: 10, binStepVolatilityScalingEnabled: true });
  assert(tiny.minBinStep >= 1, `min bound must floor at 1, got ${tiny.minBinStep}`);

  console.log(`  bin-step window: static off, {${wide.minBinStep},${wide.maxBinStep}} at vol=5, saturation + floor OK`);
}

// ── getRawPoolScreeningRejectReason respects the window ────────
function testRejectReasonRespectsWindow() {
  const mkPool = (binStep, volatility) => ({
    pool_type: "dlmm",
    tvl: 50_000,
    volume: 100_000,
    fee_active_tvl_ratio: 1,
    volatility,
    base_token_holders: 1_000,
    dlmm_params: { bin_step: binStep },
    token_x: { market_cap: 500_000, organic_score: 99 },
    token_y: { organic_score: 99 },
  });
  const sBase = {
    excludeHighSupplyConcentration: false,
    minMcap: 1, maxMcap: 1e13,
    minHolders: 1, minVolume: 1, minTvl: 1, maxTvl: null,
    minBinStep: 80, maxBinStep: 125,
    minFeeActiveTvlRatio: 0,
    minEstimatedSharePct: null,
    minOrganic: 1, minQuoteOrganic: 1,
    allowedLaunchpads: [], blockedLaunchpads: [],
    minTokenAgeHours: null, maxTokenAgeHours: null,
  };
  const sOn = { ...sBase, binStepVolatilityScalingEnabled: true };

  // Sanity: an in-window pool passes everything
  assert(getRawPoolScreeningRejectReason(mkPool(100, 5), sBase) === null, "in-window pool must pass with flag off");

  // Flag off: bin_step 150 rejected regardless of volatility
  const offReason = getRawPoolScreeningRejectReason(mkPool(150, 5), sBase);
  assert(offReason && offReason.includes("above maxBinStep 125"), `flag off must reject 150, got: ${offReason}`);

  // Flag on + high vol: 150 fits the widened window (max 188)
  assert(getRawPoolScreeningRejectReason(mkPool(150, 5), sOn) === null, "flag on + vol 5 must accept bin_step 150");

  // Flag on + high vol also widens the low side (min 40)
  assert(getRawPoolScreeningRejectReason(mkPool(50, 5), sBase) !== null, "flag off must reject bin_step 50");
  assert(getRawPoolScreeningRejectReason(mkPool(50, 5), sOn) === null, "flag on + vol 5 must accept bin_step 50");

  // Flag on but LOW vol: barely widened window still rejects 150
  const lowVolReason = getRawPoolScreeningRejectReason(mkPool(150, 0.5), sOn);
  assert(lowVolReason && lowVolReason.includes("above maxBinStep"), `flag on + low vol must still reject 150, got: ${lowVolReason}`);

  console.log("  reject reason: static off, widened only when flag on + vol high OK");
}

testRebalanceTimingScaling();
testShouldRebalanceTimingGates();
testBinStepWindow();
testRejectReasonRespectsWindow();
console.log("test-volatility-adaptive: OK");
