/**
 * Unit tests for real-time IL tracking (computeIlMetrics, checkIlGapExit,
 * updatePnlAndCheckExits persistence, syncOpenPositions snapshot) and the
 * default-OFF config wiring. Pure math + local state.json — no network.
 * Fixtures follow test-impermanent-loss.js (same range geometry / sign expectations).
 * Run: node test/test-il-tracking.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  trackPosition,
  updatePnlAndCheckExits,
  getTrackedPosition,
  syncOpenPositions,
  computeIlMetrics,
  checkIlGapExit,
} from "../state.js";
import { calculateIlConcentrated } from "../utils/impermanent-loss.js";
import { config } from "../config.js";

const STATE_PATH = repoPath("state.json");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function close(a, b, eps = 0.011) { // metrics are rounded to 2 decimals
  return Math.abs(a - b) < eps;
}
function binPrice(binId, binStep) {
  return Math.pow(1 + binStep / 10000, binId);
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

// Shared fixture: bin_step 100 (1%/bin), entry at bin 0, range [-10, +10] —
// bin-space version of the 100/90-110 range in test-impermanent-loss.js.
const STEP = 100;
const TRACKED = { bin_step: STEP, active_bin_at_deploy: 0 };
const RANGE = { lower_bin: -10, upper_bin: 10 };
function expectedIlPct(activeBin) {
  const il = calculateIlConcentrated(
    binPrice(0, STEP),
    binPrice(activeBin, STEP),
    binPrice(RANGE.lower_bin, STEP),
    binPrice(RANGE.upper_bin, STEP),
  );
  return il * 100;
}

// ── computeIlMetrics ───────────────────────────────────────────
function testComputeIlMetrics() {
  // No price movement → IL ~0, gap ~pnl
  let m = computeIlMetrics(TRACKED, { ...RANGE, active_bin: 0, pnl_pct: 1.5 });
  assert(m && close(m.il_pct, 0), `no movement must give ~0 IL, got ${m?.il_pct}`);
  assert(close(m.fee_vs_il_gap_pct, 1.5), `gap must be ~pnl when IL is 0, got ${m?.fee_vs_il_gap_pct}`);

  // In-range move up → negative IL, matching calculateIlConcentrated on the same prices
  m = computeIlMetrics(TRACKED, { ...RANGE, active_bin: 5, pnl_pct: 2 });
  assert(m.il_pct < 0, `in-range move must give negative IL, got ${m.il_pct}`);
  assert(close(m.il_pct, expectedIlPct(5)), `il_pct must match calculateIlConcentrated: expected ${expectedIlPct(5)}, got ${m.il_pct}`);
  assert(close(m.fee_vs_il_gap_pct, 2 - m.il_pct), `gap must be pnl - il, got ${m.fee_vs_il_gap_pct}`);

  // Price exits above range → IL more negative than the in-range move
  const oor = computeIlMetrics(TRACKED, { ...RANGE, active_bin: 30, pnl_pct: 0 });
  assert(oor.il_pct < m.il_pct, `OOR-above IL must exceed in-range IL: ${oor.il_pct} < ${m.il_pct}`);
  assert(close(oor.il_pct, expectedIlPct(30)), `OOR il_pct must match reference, got ${oor.il_pct}`);

  // pnl unavailable → il computed, gap null
  m = computeIlMetrics(TRACKED, { ...RANGE, active_bin: 5, pnl_pct: null });
  assert(m.il_pct < 0 && m.fee_vs_il_gap_pct === null, `null pnl must null the gap only, got ${JSON.stringify(m)}`);

  // Missing bin data fails closed → null
  assert(computeIlMetrics({ active_bin_at_deploy: 0 }, { ...RANGE, active_bin: 5, pnl_pct: 1 }) === null, "missing bin_step must return null");
  assert(computeIlMetrics({ bin_step: 0, active_bin_at_deploy: 0 }, { ...RANGE, active_bin: 5, pnl_pct: 1 }) === null, "bin_step 0 must return null");
  assert(computeIlMetrics({ bin_step: STEP }, { ...RANGE, active_bin: 5, pnl_pct: 1 }) === null, "missing entry bin must return null");
  assert(computeIlMetrics(TRACKED, { active_bin: 5, upper_bin: 10, pnl_pct: 1 }) === null, "missing lower_bin must return null");
  assert(computeIlMetrics(TRACKED, { ...RANGE, pnl_pct: 1 }) === null, "missing active_bin must return null");
  assert(computeIlMetrics(null, { ...RANGE, active_bin: 5, pnl_pct: 1 }) === null, "null tracked must return null");

  console.log("  computeIlMetrics: zero/in-range/OOR match reference, fail-closed on missing data OK");
}

// ── checkIlGapExit gating ──────────────────────────────────────
function testCheckIlGapExit() {
  // Position dumped below range: strongly negative IL
  const dumped = { ...RANGE, active_bin: -60 };
  const il = expectedIlPct(-60);
  const posAtGap = (gap) => ({ ...dumped, pnl_pct: il + gap });
  const MGMT = { ilGapCloseEnabled: true, ilGapCloseThresholdPct: 15 };

  // Default OFF: flag absent or false never fires, even on a huge gap
  assert(checkIlGapExit(TRACKED, posAtGap(-40), {}) === null, "flag absent must not fire");
  assert(checkIlGapExit(TRACKED, posAtGap(-40), { ilGapCloseEnabled: false, ilGapCloseThresholdPct: 15 }) === null, "flag false must not fire");

  // Enabled + gap below -threshold → fires with classifiable reason
  const hit = checkIlGapExit(TRACKED, posAtGap(-20), MGMT);
  assert(hit != null, "gap -20 vs threshold 15 must fire");
  assert(close(hit.gap_pct, -20), `gap_pct expected ~-20, got ${hit.gap_pct}`);
  assert(close(hit.il_pct, il), `il_pct expected ~${il}, got ${hit.il_pct}`);
  assert(hit.reason.includes("IL gap"), `reason must be classifiable, got: ${hit.reason}`);

  // Enabled + gap above -threshold → holds
  assert(checkIlGapExit(TRACKED, posAtGap(-10), MGMT) === null, "gap -10 vs threshold 15 must hold");

  // Boundary: exactly -threshold must NOT fire (strict <)
  assert(checkIlGapExit(TRACKED, posAtGap(-15), MGMT) === null, "gap exactly -15 must hold");

  // Suspicious PnL tick → holds
  assert(checkIlGapExit(TRACKED, { ...posAtGap(-40), pnl_pct_suspicious: true }, MGMT) === null, "suspicious tick must hold");

  // Missing bin data → holds (fail-open to other rules)
  assert(checkIlGapExit({ bin_step: STEP }, posAtGap(-40), MGMT) === null, "missing entry bin must hold");
  assert(checkIlGapExit(TRACKED, { pnl_pct: -40 }, MGMT) === null, "missing live bins must hold");

  // Unusable threshold → holds
  assert(checkIlGapExit(TRACKED, posAtGap(-40), { ilGapCloseEnabled: true, ilGapCloseThresholdPct: 0 }) === null, "threshold 0 must hold");
  assert(checkIlGapExit(TRACKED, posAtGap(-40), { ilGapCloseEnabled: true, ilGapCloseThresholdPct: "x" }) === null, "garbage threshold must hold");

  console.log("  checkIlGapExit: default off, strict threshold, suspicious/missing-data holds OK");
}

// ── updatePnlAndCheckExits persistence + syncOpenPositions ─────
function testStatePersistence() {
  const saved = backup(STATE_PATH);
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));
    trackPosition({
      position: "IL_POS_1",
      pool: "IL_POOL_1",
      pool_name: "IL-SOL",
      strategy: "bid_ask",
      amount_sol: 0.5,
      active_bin: 0,
      bin_step: STEP,
      volatility: 2.2,
    });

    // Neutral mgmt config: no exit rule can trigger on this tick
    const mgmt = {
      stopLossPct: -50,
      trailingTakeProfit: false,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 1,
      minAgeBeforeYieldCheck: 60,
    };
    const tick = { ...RANGE, active_bin: 5, pnl_pct: 2, in_range: true, fee_per_tvl_24h: 50, age_minutes: 5 };
    const exit = updatePnlAndCheckExits("IL_POS_1", tick, mgmt);
    assert(exit === null, `neutral tick must not exit, got ${JSON.stringify(exit)}`);

    let tracked = getTrackedPosition("IL_POS_1");
    assert(tracked.il_pct != null && tracked.il_pct < 0, `il_pct must persist negative, got ${tracked.il_pct}`);
    assert(close(tracked.il_pct, expectedIlPct(5)), `persisted il_pct must match reference, got ${tracked.il_pct}`);
    assert(close(tracked.fee_vs_il_gap_pct, 2 - tracked.il_pct), `persisted gap must be pnl - il, got ${tracked.fee_vs_il_gap_pct}`);

    // Stop-loss tick: exit still fires AND IL fields refresh first
    const slExit = updatePnlAndCheckExits("IL_POS_1", { ...RANGE, active_bin: -60, pnl_pct: -60, in_range: false, fee_per_tvl_24h: 50, age_minutes: 30 }, mgmt);
    assert(slExit?.action === "STOP_LOSS", `pnl -60 must stop-loss, got ${JSON.stringify(slExit)}`);
    tracked = getTrackedPosition("IL_POS_1");
    assert(close(tracked.il_pct, expectedIlPct(-60)), `il_pct must refresh on exit tick, got ${tracked.il_pct}`);

    // Tick without bin data: last known IL values stay untouched
    updatePnlAndCheckExits("IL_POS_1", { pnl_pct: -1, in_range: false, fee_per_tvl_24h: 50, age_minutes: 31 }, mgmt);
    const after = getTrackedPosition("IL_POS_1");
    assert(after.il_pct === tracked.il_pct && after.fee_vs_il_gap_pct === tracked.fee_vs_il_gap_pct, "missing bin data must not clobber stored IL");

    // External-close snapshot carries il_pct (like volatility)
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.positions.IL_POS_1.deployed_at = new Date(Date.now() - 60 * 60_000).toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    const closed = syncOpenPositions([]);
    assert(closed.length === 1 && closed[0].position === "IL_POS_1", `expected 1 external close, got ${closed.length}`);
    assert(closed[0].il_pct === after.il_pct, `snapshot must carry il_pct ${after.il_pct}, got ${closed[0].il_pct}`);
    assert(closed[0].volatility === 2.2, "snapshot must still carry volatility");

    console.log("  state persistence: il_pct/gap saved per tick, kept on blind ticks, in close snapshot OK");
  } finally {
    restore(STATE_PATH, saved);
  }
}

// ── config wiring: new keys exist and default OFF ──────────────
function testConfigDefaults() {
  const savedEnabled = config.management.ilGapCloseEnabled;
  const savedThreshold = config.management.ilGapCloseThresholdPct;
  try {
    assert(config.management.ilGapCloseEnabled === false, `ilGapCloseEnabled must default false, got ${config.management.ilGapCloseEnabled}`);
    assert(config.management.ilGapCloseThresholdPct === 15, `ilGapCloseThresholdPct must default 15, got ${config.management.ilGapCloseThresholdPct}`);

    // Flipping the live flag arms the rule through the same config object
    config.management.ilGapCloseEnabled = true;
    const dumped = { ...RANGE, active_bin: -60, pnl_pct: expectedIlPct(-60) - 20 };
    assert(checkIlGapExit(TRACKED, dumped, config.management) != null, "enabled live config must arm the rule");
  } finally {
    config.management.ilGapCloseEnabled = savedEnabled;
    config.management.ilGapCloseThresholdPct = savedThreshold;
  }
  console.log("  config: ilGapCloseEnabled=false / ilGapCloseThresholdPct=15 defaults, live toggle OK");
}

testComputeIlMetrics();
testCheckIlGapExit();
testStatePersistence();
testConfigDefaults();
console.log("test-il-tracking: OK");
