/**
 * Unit tests for the pump-chase cap (all strategies) and the universal spot
 * fee floor — the FABLE (-$10.12) and SEMAN (-$3.94) loss patterns.
 * Replays the exact deploy args from logs/actions-2026-07-04.jsonl.
 * No network. Run: node test/test-spot-pump-gates.js
 */

import {
  classifyMarketView,
  buildDeployPlan,
  applyPumpChaseCap,
  applySpotFeeFloor,
  resolveDeployStrategyForCandidate,
} from "../tools/strategy-router.js";
import { config } from "../config.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Pump-chase cap (P1a) ───────────────────────────────────────
function testPumpChaseCap() {
  const saved = config.autoStrategy.maxPumpPct1h;
  const savedSpot = config.autoStrategy.allowSpot;
  try {
    config.autoStrategy.maxPumpPct1h = 20;
    config.autoStrategy.allowSpot = true; // live interim config has spot off

    // FABLE replay 08:29 UTC Jul 4: +34.33% 1h, ST bullish → pump view →
    // spot balanced. The old cap exempted spot; must block now.
    const fableView = classifyMarketView({
      pool: { volatility: 5.2786 },
      priceChange1h: 34.33,
      signal: { supertrendDirection: "bullish" },
    });
    assert(fableView.view === "pump", `FABLE should classify pump, got ${fableView.view}`);
    const fablePlan = buildDeployPlan({
      pool: { volatility: 5.2786, fee_active_tvl_ratio: 0.9208 },
      classification: fableView,
      signal: { supertrendDirection: "bullish" },
      fibHint: null,
    });
    assert(fablePlan.strategy === "spot" && fablePlan.entry_allowed, "FABLE pre-gate plan should be allowed spot");
    const fableCapped = applyPumpChaseCap(fablePlan, { priceChange1h: 34.33 });
    assert(!fableCapped.entry_allowed, "FABLE +34.33% 1h spot must be blocked by pump cap");
    assert(/pump \+34\.3% > 20% cap/.test(fableCapped.entry_reason), `unexpected reason: ${fableCapped.entry_reason}`);

    // Regression: bid_ask sol_below over the cap stays blocked (old behavior)
    const bidAskCapped = applyPumpChaseCap(
      { strategy: "bid_ask", deposit_side: "sol_below", entry_allowed: true, entry_reason: "ok" },
      { priceChange1h: 25 },
    );
    assert(!bidAskCapped.entry_allowed, "bid_ask below over cap must stay blocked");

    // Under the cap → untouched
    const underCap = applyPumpChaseCap(
      { strategy: "spot", entry_allowed: true, entry_reason: "ok" },
      { priceChange1h: 18 },
    );
    assert(underCap.entry_allowed, "under-cap pump must pass");

    // Already-blocked plan keeps its original reason
    const preBlocked = applyPumpChaseCap(
      { strategy: "spot", entry_allowed: false, entry_reason: "RSI extended" },
      { priceChange1h: 50 },
    );
    assert(preBlocked.entry_reason === "RSI extended", "pre-blocked reason must be preserved");

    // Cap disabled (0) → untouched
    config.autoStrategy.maxPumpPct1h = 0;
    const disabled = applyPumpChaseCap(
      { strategy: "spot", entry_allowed: true, entry_reason: "ok" },
      { priceChange1h: 50 },
    );
    assert(disabled.entry_allowed, "cap 0 must disable the gate");

    console.log("  pump-chase cap: FABLE +34.3% spot blocked, bid_ask regression, under-cap pass, disable OK");
  } finally {
    config.autoStrategy.maxPumpPct1h = saved;
    config.autoStrategy.allowSpot = savedSpot;
  }
}

// ── Spot fee floor (P1b) ───────────────────────────────────────
function testSpotFeeFloor() {
  const saved = config.autoStrategy.spotFeeTvlMin;
  try {
    config.autoStrategy.spotFeeTvlMin = 2;

    // SEMAN replay 05:30 UTC Jul 4 (SL -9.5%): sideways spot, fee/TVL 0.3674
    // → must fall back to bid_ask sol_below, entry still allowed.
    const semanPlan = {
      market_view: "sideways", strategy: "spot", deposit_side: "sol_balanced",
      bins_below: 48, bins_above: 16, entry_allowed: true, entry_reason: "ok", notes: [],
    };
    const semanFloored = applySpotFeeFloor(semanPlan, { pool: { fee_active_tvl_ratio: 0.3674, volatility: 3 } });
    assert(semanFloored.strategy === "bid_ask", `SEMAN low-fee spot must fall back to bid_ask, got ${semanFloored.strategy}`);
    assert(semanFloored.deposit_side === "sol_below" && semanFloored.bins_above === 0, "fallback must be SOL below");
    assert(semanFloored.entry_allowed, "sideways fallback keeps entry allowed");

    // FABLE shape: pump-view spot at fee/TVL 0.9208 — matrix forbids bid_ask
    // below on pump, so the floor must block instead of convert.
    const fableFloored = applySpotFeeFloor(
      { market_view: "pump", strategy: "spot", bins_below: 55, bins_above: 55, entry_allowed: true, entry_reason: "ok", notes: [] },
      { pool: { fee_active_tvl_ratio: 0.9208, volatility: 5.2786 } },
    );
    assert(!fableFloored.entry_allowed, "pump-view spot below floor must be blocked");
    assert(fableFloored.strategy === "spot", "blocked pump plan must not be converted to bid_ask");

    // Volatile recall below floor → blocked (recall forbids bid_ask redeploy)
    const recallFloored = applySpotFeeFloor(
      { market_view: "retracement", strategy: "spot", entry_allowed: true, entry_reason: "ok", notes: [] },
      { pool: { fee_active_tvl_ratio: 0.5 }, volatileRecall: true },
    );
    assert(!recallFloored.entry_allowed, "volatile-recall spot below floor must be blocked");

    // At/above the floor → untouched
    const highFee = applySpotFeeFloor(
      { market_view: "sideways", strategy: "spot", entry_allowed: true, entry_reason: "ok", notes: [] },
      { pool: { fee_active_tvl_ratio: 2.826 } },
    );
    assert(highFee.strategy === "spot" && highFee.entry_allowed, "fee above floor must pass untouched");

    // Unknown fee → fail-open with a note
    const unknownFee = applySpotFeeFloor(
      { market_view: "sideways", strategy: "spot", entry_allowed: true, entry_reason: "ok", notes: [] },
      { pool: {} },
    );
    assert(unknownFee.entry_allowed && unknownFee.strategy === "spot", "unknown fee must fail open");
    assert(unknownFee.notes.some((n) => /fail-open/.test(n)), "fail-open must be noted");

    // TGE plans keep their own gate; bid_ask plans out of scope
    const tge = applySpotFeeFloor(
      { market_view: "pump", strategy: "spot", tge: true, entry_allowed: true, entry_reason: "ok", notes: [] },
      { pool: { fee_active_tvl_ratio: 0.1 } },
    );
    assert(tge.entry_allowed, "TGE plan must be exempt from the spot floor");
    const bidAsk = applySpotFeeFloor(
      { market_view: "breakdown", strategy: "bid_ask", entry_allowed: true, entry_reason: "ok", notes: [] },
      { pool: { fee_active_tvl_ratio: 0.1 } },
    );
    assert(bidAsk.strategy === "bid_ask" && bidAsk.entry_allowed, "bid_ask plan must be untouched");

    console.log("  spot fee floor: SEMAN 0.37 fallback, FABLE pump 0.92 blocked, recall blocked, exemptions OK");
  } finally {
    config.autoStrategy.spotFeeTvlMin = saved;
  }
}

// ── End-to-end through resolveDeployStrategyForCandidate ──────
async function testResolveIntegration() {
  const savedFetch = config.autoStrategy.fetchIndicators;
  const savedFee = config.autoStrategy.spotFeeTvlMin;
  const savedPump = config.autoStrategy.maxPumpPct1h;
  const savedSpot = config.autoStrategy.allowSpot;
  try {
    config.autoStrategy.fetchIndicators = false; // no network → no signal
    config.autoStrategy.spotFeeTvlMin = 2;
    config.autoStrategy.maxPumpPct1h = 20;
    config.autoStrategy.allowSpot = true; // live interim config has spot off

    // SEMAN sideways shape end-to-end: vol 3, +5% 1h, fee 0.37 → sideways
    // native-spot converted to bid_ask below by the floor.
    const seman = await resolveDeployStrategyForCandidate({
      pool: { pool: "TEST_POOL_SEMAN_555555555555555555555555555", volatility: 3, price_change_1h: 5, fee_active_tvl_ratio: 0.3674 },
    });
    assert(seman.strategy === "bid_ask", `SEMAN e2e should end bid_ask, got ${seman.strategy}`);

    // Over-cap 1h move end-to-end: whatever the view resolves to, the chase
    // cap must block it (no signal → retracement bid_ask below here).
    const chased = await resolveDeployStrategyForCandidate({
      pool: { pool: "TEST_POOL_CHASE_444444444444444444444444444", volatility: 5, price_change_1h: 34.33, fee_active_tvl_ratio: 3 },
    });
    assert(!chased.entry_allowed, "e2e +34.33% 1h must be blocked");
    assert(/pump \+34\.3% > 20% cap/.test(chased.entry_reason), `unexpected e2e reason: ${chased.entry_reason}`);

    console.log("  resolve e2e: SEMAN sideways→bid_ask fallback, +34.3% chase blocked OK");
  } finally {
    config.autoStrategy.fetchIndicators = savedFetch;
    config.autoStrategy.spotFeeTvlMin = savedFee;
    config.autoStrategy.maxPumpPct1h = savedPump;
    config.autoStrategy.allowSpot = savedSpot;
  }
}

try {
  testPumpChaseCap();
  testSpotFeeFloor();
  await testResolveIntegration();
  console.log("test-spot-pump-gates: OK");
} catch (e) {
  console.error("test-spot-pump-gates: FAIL —", e.message);
  process.exit(1);
}
