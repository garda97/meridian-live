/**
 * Unit tests for the partial take-profit (DCA-out) pure decision function
 * shouldPartialTakeProfit (no network, no state file writes).
 * Run: node test/test-partial-tp.js
 */

import { shouldPartialTakeProfit } from "../state.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const MGMT = {
  partialTpEnabled: true,
  partialTpTriggerPct: 5,
  partialTpClosePct: 50,
  partialTpMinRemainUsd: 10,
};

// Baseline: open tracked position with confirmed peak above trigger
function pos(overrides = {}) {
  return {
    position: "TestPos111",
    closed: false,
    partial_tp_done: false,
    partial_tp_last_attempt_at: null,
    peak_pnl_pct: 6,
    ...overrides,
  };
}

// Baseline: live data over the trigger, in range, big enough remainder
function live(overrides = {}) {
  return {
    pnl_pct: 6,
    pnl_pct_suspicious: false,
    in_range: true,
    total_value_usd: 100,
    ...overrides,
  };
}

function testTriggers() {
  const res = shouldPartialTakeProfit(pos(), live(), MGMT);
  assert(res, "should trigger when pnl and confirmed peak >= trigger");
  assert(res.close_pct === 50, `close_pct should be 50, got ${res.close_pct}`);
  assert(res.reason.includes("Partial TP"), "reason should describe partial TP");
  console.log("  ✓ triggers when pnl + confirmed peak >= trigger, remainder OK");
}

function testDisabled() {
  assert(shouldPartialTakeProfit(pos(), live(), { ...MGMT, partialTpEnabled: false }) === null, "disabled config must not trigger");
  assert(shouldPartialTakeProfit(pos(), live(), null) === null, "missing config must not trigger");
  console.log("  ✓ disabled / missing config → null");
}

function testAlreadyDone() {
  assert(shouldPartialTakeProfit(pos({ partial_tp_done: true }), live(), MGMT) === null, "must fire at most once per position");
  assert(shouldPartialTakeProfit(pos({ closed: true }), live(), MGMT) === null, "closed position must not trigger");
  assert(shouldPartialTakeProfit(null, live(), MGMT) === null, "untracked position must not trigger");
  console.log("  ✓ already-done / closed / untracked → null");
}

function testSuspiciousPnl() {
  assert(shouldPartialTakeProfit(pos(), live({ pnl_pct_suspicious: true }), MGMT) === null, "suspicious pnl tick must not trigger");
  assert(shouldPartialTakeProfit(pos(), live({ pnl_pct: null }), MGMT) === null, "null pnl must not trigger");
  console.log("  ✓ suspicious / null pnl → null");
}

function testBelowTrigger() {
  assert(shouldPartialTakeProfit(pos(), live({ pnl_pct: 4.9 }), MGMT) === null, "pnl below trigger must not trigger");
  // Current tick spiked but the confirmed peak hasn't caught up — anti-noise guard
  assert(shouldPartialTakeProfit(pos({ peak_pnl_pct: 2 }), live({ pnl_pct: 8 }), MGMT) === null, "unconfirmed peak must not trigger");
  console.log("  ✓ below trigger / unconfirmed peak → null");
}

function testOutOfRange() {
  assert(shouldPartialTakeProfit(pos(), live({ in_range: false }), MGMT) === null, "OOR position must not trigger");
  console.log("  ✓ out-of-range → null");
}

function testTooSmallRemainder() {
  // 50% of $15 leaves $7.50 < $10 min remain
  assert(shouldPartialTakeProfit(pos(), live({ total_value_usd: 15 }), MGMT) === null, "remainder below partialTpMinRemainUsd must not trigger");
  assert(shouldPartialTakeProfit(pos(), live({ total_value_usd: null }), MGMT) === null, "unknown value must not trigger");
  // 50% of $30 leaves $15 >= $10 — OK
  assert(shouldPartialTakeProfit(pos(), live({ total_value_usd: 30 }), MGMT) !== null, "remainder above min must trigger");
  console.log("  ✓ too-small / unknown remainder → null, big enough → triggers");
}

function testAttemptBackoff() {
  const recent = new Date(Date.now() - 60_000).toISOString();
  assert(shouldPartialTakeProfit(pos({ partial_tp_last_attempt_at: recent }), live(), MGMT) === null, "recent failed attempt must back off");
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  assert(shouldPartialTakeProfit(pos({ partial_tp_last_attempt_at: old }), live(), MGMT) !== null, "old attempt must retry");
  console.log("  ✓ recent failed attempt backs off 10m, then retries");
}

function testClosePctClamp() {
  // 100% would be a full close — must clamp to 99 and still leave the account open path
  const res = shouldPartialTakeProfit(pos(), live({ total_value_usd: 2000 }), { ...MGMT, partialTpClosePct: 100 });
  assert(res && res.close_pct === 99, `close_pct 100 must clamp to 99, got ${res?.close_pct}`);
  const res2 = shouldPartialTakeProfit(pos(), live({ total_value_usd: 2000 }), { ...MGMT, partialTpClosePct: 0 });
  assert(res2 && res2.close_pct === 1, `close_pct 0 must clamp to 1, got ${res2?.close_pct}`);
  console.log("  ✓ close_pct clamps to 1-99");
}

try {
  console.log("shouldPartialTakeProfit:");
  testTriggers();
  testDisabled();
  testAlreadyDone();
  testSuspiciousPnl();
  testBelowTrigger();
  testOutOfRange();
  testTooSmallRemainder();
  testAttemptBackoff();
  testClosePctClamp();
  console.log("\nAll partial-TP tests passed ✅");
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
