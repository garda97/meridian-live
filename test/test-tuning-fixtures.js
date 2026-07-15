/**
 * Fixture replay for the 2026-07-15 tuning dispatch (notes/CLAUDE_TUNING_DISPATCH.md).
 * Replays six real deploys through the strategy-router gate pipeline with the
 * live evil-panda config values pinned, so gate tuning has pass/fail tokens:
 *
 *   FABLE  Jul 4  spot -12.28%  -> BLOCK  (pump +34.33% 1h, fee/TVL 0.92)
 *   SEMAN  Jul 4  spot  -9.5%   -> BLOCK  (dump -28.65% 1h)
 *   BABYANSEM     spot  +4.84%  -> ALLOW  (fee/TVL 3.96 pays for exposure)
 *   DR TRUMP      spot  +2.95%  -> ALLOW  (fee/TVL 4.94)
 *   brain-SOL Jul 15 wide       -> bid_ask downside 90% (young), not spot
 *   P0-SOL        spot low fee  -> fallback bid_ask below (fee/TVL 0.32)
 *
 * Pool metrics come from state.json signal_snapshot / logs/actions-*.jsonl.
 * No network. Run: node test/test-tuning-fixtures.js
 */

import {
  classifyMarketView,
  buildDeployPlan,
  applyPumpChaseCap,
  applyTgeOverride,
  applySpotFeeFloor,
  applySpotDumpGate,
  applyDropEntryGate,
  applyPumpUpsideCoverGate,
  applyBidAskWideRange,
} from "../tools/strategy-router.js";
import { config } from "../config.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Mirror of resolveDeployStrategyForCandidate's gate order (strategy-router.js
 * ~617-646) without network, pool-memory, or the ATH gate — pure replay.
 */
function replayPipeline({ pool, priceChange1h, signal = null }) {
  const classification = classifyMarketView({ pool, priceChange1h, signal });
  let plan = buildDeployPlan({ pool, classification, signal, fibHint: null });
  plan = applyPumpChaseCap(plan, { priceChange1h });
  plan = applyTgeOverride(plan, { pool });
  plan = applySpotFeeFloor(plan, { pool });
  plan = applySpotDumpGate(plan, { priceChange1h });
  plan = applyDropEntryGate(plan, { priceChange1h });
  applyPumpUpsideCoverGate(plan);
  plan = applyBidAskWideRange(plan, { pool, priceChange1h });
  return plan;
}

// Pin the config this replay assumes (live evil-panda values, 2026-07-15).
const PINNED = {
  allowSpot: true,
  allowCurve: true,
  preferSpotHighFee: true,
  spotFeeTvlMin: 2,
  spotRatioBelow: 0.65,
  maxPumpPct1h: 15,
  minUpsideCoverPctPump: 30,
  dropEntryGate: true,
  dropEntryMin: -15,
  dropEntryMax: 10,
  bidAskWideRangeEnabled: true,
  bidAskDownsidePctYoung: 90,
  bidAskDownsidePctMature: 65,
  bidAskYoungMaxAgeHours: 48,
  bidAskYoungPumpPct1h: 80,
  maxBins: 200,
  supertrendRange: false, // fixtures carry no candles; ST range needs signal anyway
  tgeMaxAgeHours: null,
  bidAskChillEnabled: false, // fixtures are all young/volatile memes, keep the path out
};

function withPinnedConfig(fn) {
  const saved = {};
  for (const k of Object.keys(PINNED)) saved[k] = config.autoStrategy[k];
  Object.assign(config.autoStrategy, PINNED);
  try {
    fn();
  } finally {
    Object.assign(config.autoStrategy, saved);
  }
}

// ── Losses that must be blocked ────────────────────────────────

function testFableBlocked() {
  // FABLE 2026-07-04 08:29 UTC, closed -12.28% (-$10.12): pump view spot
  // balanced at fee/TVL 0.9208 while the token was +34.33% on the hour.
  const signal = { supertrendDirection: "bullish" };
  const pool = { volatility: 5.2786, fee_active_tvl_ratio: 0.9208, token_age_hours: 30 };
  const view = classifyMarketView({ pool, priceChange1h: 34.33, signal });
  assert(view.view === "pump", `FABLE must classify pump, got ${view.view}`);
  const plan = replayPipeline({ pool, priceChange1h: 34.33, signal });
  assert(!plan.entry_allowed, "FABLE +34.33% 1h spot must be BLOCKED");
  assert(/pump \+34\.3% > 15% cap/.test(plan.entry_reason), `FABLE block must come from the pump cap: ${plan.entry_reason}`);

  // Belt and braces: even with the pump cap off, the spot fee floor
  // (0.92 < 2 on a pump view) must still block the deploy.
  const savedCap = config.autoStrategy.maxPumpPct1h;
  config.autoStrategy.maxPumpPct1h = 0;
  try {
    const uncapped = replayPipeline({ pool, priceChange1h: 34.33, signal });
    assert(!uncapped.entry_allowed, "FABLE must stay blocked with pump cap off (fee floor)");
    assert(/Spot fee floor/.test(uncapped.entry_reason), `expected fee-floor reason: ${uncapped.entry_reason}`);
  } finally {
    config.autoStrategy.maxPumpPct1h = savedCap;
  }
  console.log("  FABLE Jul 4: pump-cap BLOCK, fee-floor backstop BLOCK OK");
}

function testSemanBlocked() {
  // SEMAN 2026-07-04, closed -9.5% (-$3.94): retracement view flipped to spot
  // by the high-fee bias (fee/TVL 2.83 >= 2) while the token dumped -28.65% 1h.
  const pool = { volatility: 3.9496, fee_active_tvl_ratio: 2.826, token_age_hours: 60 };
  const view = classifyMarketView({ pool, priceChange1h: -28.65, signal: null });
  assert(view.view === "retracement", `SEMAN must classify retracement, got ${view.view}`);
  const plan = replayPipeline({ pool, priceChange1h: -28.65 });
  assert(!plan.entry_allowed, "SEMAN spot into a -28.65% 1h dump must be BLOCKED");
  assert(/dump -28\.6% < -15% cap/.test(plan.entry_reason), `SEMAN block must come from the dump gate: ${plan.entry_reason}`);
  console.log("  SEMAN dump: spot dump-gate BLOCK OK");
}

// ── Winners that must stay allowed ─────────────────────────────

function testBabyansemAllowed() {
  // BABYANSEM 2026-07-03, closed +4.84%: sideways spot, fee/TVL 3.9639 —
  // exactly the trade the fee floor is meant to keep.
  const pool = { volatility: 5.7976, fee_active_tvl_ratio: 3.9639, token_age_hours: 40 };
  const view = classifyMarketView({ pool, priceChange1h: 5, signal: null });
  assert(view.view === "sideways", `BABYANSEM must classify sideways, got ${view.view}`);
  const plan = replayPipeline({ pool, priceChange1h: 5 });
  assert(plan.entry_allowed, `BABYANSEM winner must stay ALLOWED, blocked with: ${plan.entry_reason}`);
  assert(plan.strategy === "spot", `BABYANSEM must stay spot, got ${plan.strategy}`);
  console.log("  BABYANSEM: sideways spot fee 3.96 ALLOW OK");
}

function testDrTrumpAllowed() {
  // DR TRUMP 2026-07-02, closed +2.95%: spot at fee/TVL 4.9367.
  const pool = { volatility: 5.7298, fee_active_tvl_ratio: 4.9367, token_age_hours: 40 };
  const plan = replayPipeline({ pool, priceChange1h: 4 });
  assert(plan.entry_allowed, `DR TRUMP winner must stay ALLOWED, blocked with: ${plan.entry_reason}`);
  assert(plan.strategy === "spot", `DR TRUMP must stay spot, got ${plan.strategy}`);
  console.log("  DR TRUMP: spot fee 4.94 ALLOW OK");
}

// ── Range / fallback shapes ────────────────────────────────────

function testBrainWideBidAsk() {
  // brain-SOL 2026-07-15 14:01 UTC deploy: sideways view, native spot plan
  // felled by the fee floor (0.3859 < 2) into bid_ask below, then the young
  // wide range (age < 48h) sets a 90% downside target. Replays the live plan.
  const pool = { volatility: 3.1519, fee_active_tvl_ratio: 0.3859, token_age_hours: 30 };
  const view = classifyMarketView({ pool, priceChange1h: 9, signal: null });
  assert(view.view === "sideways", `brain-SOL must classify sideways, got ${view.view}`);
  const plan = replayPipeline({ pool, priceChange1h: 9 });
  assert(plan.entry_allowed, `brain-SOL must stay ALLOWED, blocked with: ${plan.entry_reason}`);
  assert(plan.strategy === "bid_ask" && plan.deposit_side === "sol_below", `brain-SOL must end bid_ask sol_below, got ${plan.strategy}/${plan.deposit_side}`);
  assert(plan.downside_pct === 90, `brain-SOL young tier must get 90% downside, got ${plan.downside_pct}`);
  assert(plan.upside_pct === 0 && plan.bins_above === 0, "brain-SOL wide plan must have zero upside");
  assert(plan.wide_range === true, "brain-SOL plan must be wide_range (>69-bin class)");
  assert(plan.notes.some((n) => /fell back to bid_ask below/.test(n)), "fee-floor fallback must be noted");
  console.log("  brain-SOL Jul 15: fee-floor fallback + wide bid_ask 90% downside OK");
}

function testP0SolLowFeeFallback() {
  // P0-SOL 2026-07-14: spot at fee/TVL 0.3156 (won +3.89%, but the fee tier
  // cannot pay for two-sided exposure — dispatch expectation is BLOCK or
  // fallback to bid_ask). Mature token -> 65% downside wide range.
  const pool = { volatility: 3.5876, fee_active_tvl_ratio: 0.3156, token_age_hours: 120 };
  const plan = replayPipeline({ pool, priceChange1h: 2 });
  assert(plan.strategy !== "spot", `P0-SOL low-fee spot must not survive as spot, got ${plan.strategy}`);
  assert(plan.strategy === "bid_ask" && plan.deposit_side === "sol_below", `P0-SOL must fall back to bid_ask below, got ${plan.strategy}/${plan.deposit_side}`);
  assert(plan.entry_allowed, `P0-SOL fallback keeps entry allowed, blocked with: ${plan.entry_reason}`);
  assert(plan.downside_pct === 65, `P0-SOL mature tier must get 65% downside, got ${plan.downside_pct}`);
  console.log("  P0-SOL: low-fee spot -> bid_ask below fallback, 65% downside OK");
}

try {
  withPinnedConfig(() => {
    testFableBlocked();
    testSemanBlocked();
    testBabyansemAllowed();
    testDrTrumpAllowed();
    testBrainWideBidAsk();
    testP0SolLowFeeFallback();
  });
  console.log("test-tuning-fixtures: OK");
} catch (e) {
  console.error("test-tuning-fixtures: FAIL —", e.message);
  process.exit(1);
}
