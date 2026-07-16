/**
 * Unit tests for the POWER MODE rebalance decision engine (pure, no chain).
 * Covers buildRebalancePlan matrix, shouldRebalance operational gates,
 * isRebalanceCandidate pre-gate, and recordRebalance state round-trip.
 * Run: node test/test-rebalance.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  classifyOorDirection,
  buildRebalancePlan,
  applySpotRebalanceGates,
  shouldRebalance,
  isRebalanceCandidate,
} from "../tools/position-router.js";
import { trackPosition, recordRebalance, getTrackedPosition } from "../state.js";
import { config } from "../config.js";

const STATE_PATH = repoPath("state.json");

// Pin autoStrategy so live user-config knobs don't flip the matrix.
// - allowSpot: owner interim toggle would turn widen_spot / convert_to_spot into holds
// - preferSpotHighFee + bidAskWideRange: live values invent balanced/wide plans and
//   collapse the "one-sided hot re-entry → OOR risk close" fixture
// - maxOorRisk / spotFeeTvlMin: stable thresholds for gate assertions
config.autoStrategy.allowSpot = true;
config.autoStrategy.preferSpotHighFee = false;
config.autoStrategy.bidAskWideRangeEnabled = false;
config.autoStrategy.maxOorRisk = 65;
config.autoStrategy.spotFeeTvlMin = 2;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const MGMT = {
  autoRebalanceEnabled: true,
  minVolumeToRebalance: 1000,
  rebalanceMinOorMinutes: 5,
  rebalanceMaxPerPosition: 3,
  rebalanceCooldownMinutes: 15,
  rebalanceMinPnlPct: -8,
  rebalanceOnStrategyDrift: true,
};

// Position helpers: range [100, 200]
const posOorUp = { active_bin: 250, lower_bin: 100, upper_bin: 200, minutes_out_of_range: 10, pnl_pct: 1.5 };
const posOorDown = { active_bin: 50, lower_bin: 100, upper_bin: 200, minutes_out_of_range: 10, pnl_pct: -2 };
const posInRange = { active_bin: 150, lower_bin: 100, upper_bin: 200, minutes_out_of_range: 0, pnl_pct: 0.5 };

const poolAlive = { volatility: 4, volume: 50_000, fee_active_tvl_ratio: 1 };
const poolDead = { volatility: 4, volume: 200, fee_active_tvl_ratio: 1 };
const bullish = { supertrendDirection: "bullish", close: 100, supertrendValue: 90 };

// ── classifyOorDirection ───────────────────────────────────────
assert(classifyOorDirection(posOorUp) === "up", "active above upper must be up");
assert(classifyOorDirection(posOorDown) === "down", "active below lower must be down");
assert(classifyOorDirection(posInRange) === "in", "active inside range must be in");
assert(classifyOorDirection({}) === "unknown", "missing bins must be unknown");

// ── buildRebalancePlan matrix ──────────────────────────────────
function testPlanMatrix() {
  // 1. OOR upside + pump + volume → widen_spot (fee/TVL must clear spot floor)
  let plan = buildRebalancePlan({ pool: { ...poolAlive, fee_active_tvl_ratio: 2.5 }, position: posOorUp, tracked: { strategy: "bid_ask" }, signal: bullish, priceChange1h: 25, mgmtConfig: MGMT });
  assert(plan.action === "rebalance" && plan.rebalance_type === "widen_spot", `upside pump must widen_spot, got ${plan.action}/${plan.rebalance_type}`);
  assert(plan.strategy === "spot" && plan.bins_above > 0, "widen_spot must carry upside cover");

  // 2. OOR upside + dead volume → close
  plan = buildRebalancePlan({ pool: poolDead, position: posOorUp, tracked: {}, signal: bullish, priceChange1h: 25, mgmtConfig: MGMT });
  assert(plan.action === "close", "upside + dead volume must close");

  // 3. OOR downside + live volume → reseed_below
  plan = buildRebalancePlan({ pool: poolAlive, position: posOorDown, tracked: {}, signal: null, priceChange1h: -10, mgmtConfig: MGMT });
  assert(plan.action === "rebalance" && plan.rebalance_type === "reseed_below", `downside + volume must reseed, got ${plan.action}/${plan.rebalance_type}`);

  // 4. OOR downside + dead volume → close (token dead)
  plan = buildRebalancePlan({ pool: poolDead, position: posOorDown, tracked: {}, signal: null, priceChange1h: -10, mgmtConfig: MGMT });
  assert(plan.action === "close" && plan.reason.includes("dead"), "downside + dead volume must close");

  // 5. In-range strategy drift (bid_ask deployed, sideways market) → convert_to_spot
  plan = buildRebalancePlan({ pool: { ...poolAlive, volatility: 3, fee_active_tvl_ratio: 2.5 }, position: posInRange, tracked: { strategy: "bid_ask" }, signal: null, priceChange1h: 5, mgmtConfig: MGMT });
  assert(plan.action === "rebalance" && plan.rebalance_type === "convert_to_spot", `sideways drift must convert_to_spot, got ${plan.action}/${plan.rebalance_type}`);

  // 6. Same drift with rebalanceOnStrategyDrift=false → hold
  plan = buildRebalancePlan({ pool: { ...poolAlive, volatility: 3 }, position: posInRange, tracked: { strategy: "bid_ask" }, signal: null, priceChange1h: 5, mgmtConfig: { ...MGMT, rebalanceOnStrategyDrift: false } });
  assert(plan.action === "hold", "drift conversion must respect the flag");

  // 7. In-range breakdown (ST break down, live volume) → reseed_below
  plan = buildRebalancePlan({ pool: poolAlive, position: posInRange, tracked: { strategy: "bid_ask" }, signal: { supertrendBreakDown: true }, priceChange1h: -5, mgmtConfig: MGMT });
  assert(plan.action === "rebalance" && plan.rebalance_type === "reseed_below", "in-range breakdown must reseed below");

  // 8. Risky re-plan: hot one-sided re-entry (vol 8, +18% 1h, no upside) → close via OOR-risk gate
  plan = buildRebalancePlan({ pool: { volatility: 8, volume: 50_000, fee_active_tvl_ratio: 1 }, position: posOorDown, tracked: {}, signal: null, priceChange1h: 18, mgmtConfig: MGMT });
  assert(plan.action === "close" && plan.reason.includes("OOR risk"), `risky re-plan must close, got ${plan.action} (${plan.reason})`);

  // 9. maxxing pattern: sideways drift → convert_to_spot blocked on low fee/TVL
  const savedFeeMin = config.autoStrategy.spotFeeTvlMin;
  config.autoStrategy.spotFeeTvlMin = 2;
  plan = buildRebalancePlan({
    pool: { ...poolAlive, volatility: 3, fee_active_tvl_ratio: 0.2337 },
    position: posInRange,
    tracked: { strategy: "bid_ask" },
    signal: null,
    priceChange1h: 5,
    mgmtConfig: MGMT,
  });
  assert(plan.action === "hold" && plan.rebalance_type == null, `low-fee convert_to_spot must hold, got ${plan.action}/${plan.rebalance_type}`);
  assert(/Spot rebalance blocked/i.test(plan.reason), `must cite spot gate, got: ${plan.reason}`);

  // 10. widen_spot on pump still allowed when fee/TVL pays for spot exposure
  plan = buildRebalancePlan({
    pool: { ...poolAlive, fee_active_tvl_ratio: 3.5 },
    position: posOorUp,
    tracked: { strategy: "bid_ask" },
    signal: bullish,
    priceChange1h: 25,
    mgmtConfig: MGMT,
  });
  assert(plan.action === "rebalance" && plan.rebalance_type === "widen_spot", `high-fee widen_spot must proceed, got ${plan.action}/${plan.rebalance_type}`);

  // 11. widen_spot blocked when pump fee/TVL below floor (pump view → block, not fallback)
  plan = buildRebalancePlan({
    pool: { ...poolAlive, fee_active_tvl_ratio: 0.92 },
    position: posOorUp,
    tracked: { strategy: "bid_ask" },
    signal: bullish,
    priceChange1h: 25,
    mgmtConfig: MGMT,
  });
  assert(plan.action === "hold", `low-fee pump widen_spot must hold, got ${plan.action}`);
  assert(/fee\/TVL 0\.92 < 2/i.test(plan.reason), `must cite fee floor, got: ${plan.reason}`);

  config.autoStrategy.spotFeeTvlMin = savedFeeMin;

  console.log("  plan-matrix: widen_spot/close-dead/reseed/convert/drift-flag/breakdown/risk-gate/spot-gates OK");
}

function testSpotRebalanceGates() {
  const savedPumpCap = config.autoStrategy.maxPumpPct1h;
  config.autoStrategy.maxPumpPct1h = 15;
  try {
    const basePlan = {
      action: "rebalance",
      rebalance_type: "convert_to_spot",
      market_view: "sideways",
      strategy: "spot",
      bins_below: 80,
      bins_above: 20,
      deposit_side: "sol_balanced",
      reason: "drift",
      notes: [],
    };
    let gated = applySpotRebalanceGates(basePlan, {
      pool: { fee_active_tvl_ratio: 3 },
      priceChange1h: -28.65,
    });
    assert(gated.action === "hold" && gated.rebalance_type == null, "dump must block convert_to_spot");
    assert(/dump/i.test(gated.reason), `must cite dump gate, got: ${gated.reason}`);

    gated = applySpotRebalanceGates(basePlan, {
      pool: { fee_active_tvl_ratio: 3 },
      priceChange1h: 5,
    });
    assert(gated.action === "rebalance" && gated.rebalance_type === "convert_to_spot", "clean sideways drift must pass gates");
  } finally {
    config.autoStrategy.maxPumpPct1h = savedPumpCap;
  }
  console.log("  spot-rebalance-gates: dump-block + clean-pass OK");
}

// ── shouldRebalance operational gates ──────────────────────────
function testShouldRebalance() {
  const plan = buildRebalancePlan({ pool: poolAlive, position: posOorDown, tracked: {}, signal: null, priceChange1h: -10, mgmtConfig: MGMT });
  assert(plan.action === "rebalance", "precondition: plan wants rebalance");
  const base = { plan, position: posOorDown, tracked: { rebalance_count: 0 }, mgmtConfig: MGMT };

  // 9. Happy path → rebalance
  let d = shouldRebalance(base);
  assert(d.action === "rebalance", `happy path must rebalance, got ${d.action} (${d.reason})`);

  // 10. Disabled → hold
  d = shouldRebalance({ ...base, mgmtConfig: { ...MGMT, autoRebalanceEnabled: false } });
  assert(d.action === "hold", "disabled must hold");

  // 11. PnL below floor → close (don't rebalance into the knife)
  d = shouldRebalance({ ...base, position: { ...posOorDown, pnl_pct: -9 } });
  assert(d.action === "close" && d.reason.includes("knife"), "deep PnL must downgrade to close");

  // 12. Max rebalance budget → close
  d = shouldRebalance({ ...base, tracked: { rebalance_count: 3 } });
  assert(d.action === "close" && d.reason.includes("budget"), "max count must downgrade to close");

  // 13. Cooldown active → hold (wait, not close)
  d = shouldRebalance({ ...base, tracked: { rebalance_count: 1, last_rebalance_at: new Date(Date.now() - 5 * 60_000).toISOString() } });
  assert(d.action === "hold" && d.reason.includes("cooldown"), "cooldown must hold");

  // 14. OOR too fresh → hold
  d = shouldRebalance({ ...base, position: { ...posOorDown, minutes_out_of_range: 2 } });
  assert(d.action === "hold" && d.reason.includes("wait"), "fresh OOR must wait");

  // 15. Suspicious PnL tick → hold
  d = shouldRebalance({ ...base, position: { ...posOorDown, pnl_pct_suspicious: true } });
  assert(d.action === "hold", "suspicious PnL must hold");

  // 16. Close plan passes through
  const closePlan = buildRebalancePlan({ pool: poolDead, position: posOorDown, tracked: {}, signal: null, priceChange1h: -10, mgmtConfig: MGMT });
  d = shouldRebalance({ plan: closePlan, position: posOorDown, tracked: {}, mgmtConfig: MGMT });
  assert(d.action === "close", "close plan must pass through");

  // 17. Post-open quiet window blocks in-range thrash; confirmed OOR bypasses
  const quiet = { ...MGMT, rebalanceMinAgeMinutes: 8 };
  const inRangePlan = buildRebalancePlan({
    pool: poolAlive,
    position: posInRange,
    tracked: { strategy: "bid_ask" },
    signal: { supertrendBreakDown: true },
    priceChange1h: -5,
    mgmtConfig: quiet,
  });
  assert(inRangePlan.action === "rebalance", "precondition: in-range breakdown wants rebalance");
  d = shouldRebalance({
    plan: inRangePlan,
    position: { ...posInRange, age_minutes: 2 },
    tracked: { rebalance_count: 0 },
    mgmtConfig: quiet,
  });
  assert(d.action === "hold" && d.reason.includes("post-open quiet"), `young in-range must quiet-hold, got ${d.action}: ${d.reason}`);

  d = shouldRebalance({
    plan,
    position: { ...posOorDown, age_minutes: 2, minutes_out_of_range: 10 },
    tracked: { rebalance_count: 0 },
    mgmtConfig: quiet,
  });
  assert(d.action === "rebalance", `confirmed OOR must bypass quiet window, got ${d.action}: ${d.reason}`);

  d = shouldRebalance({
    plan: inRangePlan,
    position: { ...posInRange, age_minutes: 10 },
    tracked: { rebalance_count: 0 },
    mgmtConfig: quiet,
  });
  assert(d.action === "rebalance", `age>=min must allow in-range rebalance, got ${d.action}: ${d.reason}`);

  console.log("  should-rebalance: happy/disabled/knife/budget/cooldown/wait/suspicious/close/post-open-quiet OK");
}

// ── isRebalanceCandidate pre-gate (no network) ─────────────────
function testPreGate() {
  // Pin flip/reshape off: live config enables them, which legitimately makes
  // in-range spot/curve reshape candidates — this test covers the base gate.
  const savedFlip = config.flip?.enabled;
  const savedReshape = config.reshape?.enabled;
  if (config.flip) config.flip.enabled = false;
  if (config.reshape) config.reshape.enabled = false;
  try {
  const tracked = { strategy: "bid_ask", rebalance_count: 0 };
  assert(isRebalanceCandidate({ position: posOorDown, tracked, mgmtConfig: MGMT }), "OOR 10m must be a candidate");
  assert(!isRebalanceCandidate({ position: { ...posOorDown, minutes_out_of_range: 1 }, tracked, mgmtConfig: MGMT }), "OOR 1m must not be a candidate");
  assert(!isRebalanceCandidate({ position: posOorDown, tracked: { ...tracked, rebalance_count: 3 }, mgmtConfig: MGMT }), "spent budget must not be a candidate");
  assert(!isRebalanceCandidate({ position: posOorDown, tracked: { ...tracked, last_rebalance_attempt_at: new Date().toISOString() }, mgmtConfig: MGMT }), "cooldown must block the pre-gate");
  assert(isRebalanceCandidate({ position: posInRange, tracked, mgmtConfig: MGMT }), "in-range bid_ask must qualify for drift check");
  assert(!isRebalanceCandidate({ position: posInRange, tracked: { ...tracked, strategy: "spot" }, mgmtConfig: MGMT }), "in-range spot has no drift to check");
  assert(!isRebalanceCandidate({ position: posOorDown, tracked: null, mgmtConfig: MGMT }), "untracked position must not be a candidate");
  assert(
    !isRebalanceCandidate({
      position: { ...posInRange, age_minutes: 1 },
      tracked,
      mgmtConfig: { ...MGMT, rebalanceMinAgeMinutes: 8 },
    }),
    "young in-range must fail pre-gate under min age",
  );
  assert(
    isRebalanceCandidate({
      position: { ...posOorDown, age_minutes: 1, minutes_out_of_range: 10 },
      tracked,
      mgmtConfig: { ...MGMT, rebalanceMinAgeMinutes: 8 },
    }),
    "confirmed OOR must pass pre-gate even if young",
  );
  // Unknown age (no age_minutes / deployed_at) must quiet-block — brand-new
  // poll ticks used to thrash reseed before age was populated.
  assert(
    !isRebalanceCandidate({
      position: { ...posInRange }, // no age_minutes
      tracked,
      mgmtConfig: { ...MGMT, rebalanceMinAgeMinutes: 8 },
    }),
    "unknown age in-range must fail pre-gate under min age",
  );
  {
    const quiet = { ...MGMT, rebalanceMinAgeMinutes: 8 };
    const inRangePlan = buildRebalancePlan({
      pool: poolAlive,
      position: posInRange,
      tracked: { strategy: "bid_ask" },
      signal: { supertrendBreakDown: true },
      priceChange1h: -5,
      mgmtConfig: quiet,
    });
    const d = shouldRebalance({
      plan: inRangePlan,
      position: { ...posInRange }, // age unknown
      tracked: { rebalance_count: 0 },
      mgmtConfig: quiet,
    });
    assert(d.action === "hold" && d.reason.includes("post-open quiet"), `unknown age must quiet-hold, got ${d.action}: ${d.reason}`);
  }

  console.log("  pre-gate: OOR window, budget, cooldown, drift-only-bid_ask, untracked, post-open-quiet OK");
  } finally {
    if (config.flip) config.flip.enabled = savedFlip;
    if (config.reshape) config.reshape.enabled = savedReshape;
  }
}

// ── recordRebalance state round-trip ───────────────────────────
function testRecordRebalance() {
  const saved = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, "utf8") : null;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));
    trackPosition({ position: "REB_POS_1", pool: "REB_POOL", pool_name: "REB-SOL", strategy: "bid_ask", amount_sol: 0.5 });

    // In-place rebalance: count++, range updated, OOR clock reset
    const state1 = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state1.positions.REB_POS_1.out_of_range_since = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state1));
    recordRebalance("REB_POS_1", {
      plan: { rebalance_type: "convert_to_spot", strategy: "spot", bins_below: 40, bins_above: 20, min_bin: 110, max_bin: 170, market_view: "sideways", reason: "drift" },
    });
    let t = getTrackedPosition("REB_POS_1");
    assert(t.rebalance_count === 1, `count must be 1, got ${t.rebalance_count}`);
    assert(t.strategy === "spot" && t.bin_range.min === 110 && t.bin_range.max === 170, "strategy + range must update");
    assert(t.out_of_range_since === null, "OOR clock must reset");
    assert(t.market_view_last === "sideways", "market view must be recorded");

    // Migrate: entry re-keyed to the new account, history preserved
    recordRebalance("REB_POS_1", {
      plan: { rebalance_type: "shift_up", strategy: "spot", bins_below: 30, bins_above: 30, min_bin: 220, max_bin: 280, market_view: "pump", reason: "shift" },
      new_position: "REB_POS_2",
    });
    assert(getTrackedPosition("REB_POS_1") == null, "old key must be gone after migrate");
    t = getTrackedPosition("REB_POS_2");
    assert(t && t.rebalance_count === 2, `migrated entry must keep history, got count ${t?.rebalance_count}`);
    assert(t.position === "REB_POS_2", "position field must be re-keyed");

    console.log("  record-rebalance: in-place count/range/OOR-reset + migrate re-key OK");
  } finally {
    if (saved == null) fs.unlinkSync(STATE_PATH);
    else fs.writeFileSync(STATE_PATH, saved);
  }
}

testPlanMatrix();
testSpotRebalanceGates();
testShouldRebalance();
testPreGate();
testRecordRebalance();
console.log("test-rebalance: OK");
