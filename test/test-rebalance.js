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
  shouldRebalance,
  isRebalanceCandidate,
} from "../tools/position-router.js";
import { trackPosition, recordRebalance, getTrackedPosition } from "../state.js";
import { config } from "../config.js";

const STATE_PATH = repoPath("state.json");

// Pin: buildRebalancePlan reuses buildDeployPlan, so a live user-config with
// spot disabled (owner interim toggle) would turn widen_spot plans into holds.
config.autoStrategy.allowSpot = true;

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
  // 1. OOR upside + pump + volume → widen_spot
  let plan = buildRebalancePlan({ pool: poolAlive, position: posOorUp, tracked: { strategy: "bid_ask" }, signal: bullish, priceChange1h: 25, mgmtConfig: MGMT });
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
  plan = buildRebalancePlan({ pool: { ...poolAlive, volatility: 3 }, position: posInRange, tracked: { strategy: "bid_ask" }, signal: null, priceChange1h: 5, mgmtConfig: MGMT });
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

  console.log("  plan-matrix: widen_spot/close-dead/reseed/convert/drift-flag/breakdown/risk-gate OK");
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

  console.log("  should-rebalance: happy/disabled/knife/budget/cooldown/wait/suspicious/close-passthrough OK");
}

// ── isRebalanceCandidate pre-gate (no network) ─────────────────
function testPreGate() {
  const tracked = { strategy: "bid_ask", rebalance_count: 0 };
  assert(isRebalanceCandidate({ position: posOorDown, tracked, mgmtConfig: MGMT }), "OOR 10m must be a candidate");
  assert(!isRebalanceCandidate({ position: { ...posOorDown, minutes_out_of_range: 1 }, tracked, mgmtConfig: MGMT }), "OOR 1m must not be a candidate");
  assert(!isRebalanceCandidate({ position: posOorDown, tracked: { ...tracked, rebalance_count: 3 }, mgmtConfig: MGMT }), "spent budget must not be a candidate");
  assert(!isRebalanceCandidate({ position: posOorDown, tracked: { ...tracked, last_rebalance_attempt_at: new Date().toISOString() }, mgmtConfig: MGMT }), "cooldown must block the pre-gate");
  assert(isRebalanceCandidate({ position: posInRange, tracked, mgmtConfig: MGMT }), "in-range bid_ask must qualify for drift check");
  assert(!isRebalanceCandidate({ position: posInRange, tracked: { ...tracked, strategy: "spot" }, mgmtConfig: MGMT }), "in-range spot has no drift to check");
  assert(!isRebalanceCandidate({ position: posOorDown, tracked: null, mgmtConfig: MGMT }), "untracked position must not be a candidate");

  console.log("  pre-gate: OOR window, budget, cooldown, drift-only-bid_ask, untracked OK");
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
testShouldRebalance();
testPreGate();
testRecordRebalance();
console.log("test-rebalance: OK");
