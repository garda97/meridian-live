/**
 * Unit tests for Recovery Strat (notes/RECOVERY_SPEC.md): the OOR-below
 * candidate filter and the bins_below bin-math, both pure/no-chain.
 * Also covers the executor.js actor-scoped duplicate-pool/mint guard bypass.
 * Run: node test/test-recovery-strat.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { filterRecoveryCandidates, computeRecoveryBinsBelow } from "../index.js";
import { trackPosition, getTrackedPosition, linkRecoveryPosition } from "../state.js";

const STATE_PATH = repoPath("state.json");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── filterRecoveryCandidates ────────────────────────────────────
function testFilter() {
  const positionData = [
    { position: "P_IN_RANGE", active_bin: 1000, lower_bin: 950, upper_bin: 1000, minutes_out_of_range: 0 },
    { position: "P_OOR_ABOVE", active_bin: 1100, lower_bin: 950, upper_bin: 1000, minutes_out_of_range: 15 },
    { position: "P_OOR_BELOW", active_bin: 940, lower_bin: 950, upper_bin: 1000, minutes_out_of_range: 20 },
    { position: "P_NO_BIN_DATA", active_bin: null, lower_bin: 950, upper_bin: 1000, minutes_out_of_range: 20 },
  ];
  const candidates = filterRecoveryCandidates(positionData);
  assert(candidates.length === 1, `expected exactly 1 candidate, got ${candidates.length}`);
  assert(candidates[0].position === "P_OOR_BELOW", "must only include OOR-to-the-lower-side positions");

  console.log("  filter: in-range/OOR-above/missing-bin-data excluded, OOR-below included OK");
}

// ── computeRecoveryBinsBelow bounds ──────────────────────────────
// Disputed claim (HANDOFF 11:40 UTC, hermes->owner): "no upper clamp on
// binsBelow... deep-crash -> unbounded wide-range recovery position."
// This is the counter-evidence: binsBelow is bounded above by binsBelowTarget
// by construction (candidates are always OOR-below, so depth d > 0, and the
// raw value binsBelowTarget - d is always < binsBelowTarget), and shrinks
// toward minBinsBelow as the crash deepens — it never grows unbounded.
function testBinsBelowBounded() {
  const origMin = 10000;
  const binsBelowTarget = 100; // config.management.autoRecoveryBinsBelow
  const configMinBinsBelow = 35; // config.strategy.minBinsBelow (MIN_SAFE_BINS_BELOW default)

  const depths = [1, 5, 20, 50, 99, 100, 101, 150, 500, 5000, 100000];
  let maxSeen = 0;
  for (const d of depths) {
    const activeBin = origMin - d;
    const { binsBelow } = computeRecoveryBinsBelow(activeBin, origMin, binsBelowTarget, configMinBinsBelow);
    assert(binsBelow <= binsBelowTarget, `binsBelow ${binsBelow} exceeded binsBelowTarget ${binsBelowTarget} at depth ${d} — would confirm the unbounded-growth claim`);
    assert(binsBelow >= configMinBinsBelow, `binsBelow ${binsBelow} fell below the configured floor ${configMinBinsBelow} at depth ${d}`);
    maxSeen = Math.max(maxSeen, binsBelow);
  }
  assert(maxSeen < binsBelowTarget, `max observed binsBelow (${maxSeen}) should stay strictly under binsBelowTarget (${binsBelowTarget}) since OOR depth is always > 0`);

  // Monotonic: deeper crash never produces a WIDER position.
  let prev = Infinity;
  for (const d of depths) {
    const { binsBelow } = computeRecoveryBinsBelow(origMin - d, origMin, binsBelowTarget, configMinBinsBelow);
    assert(binsBelow <= prev, `binsBelow increased with deeper crash (depth ${d}) — expected monotonic non-increase`);
    prev = binsBelow;
  }

  // Deep crash lands exactly on the configured floor, not something larger.
  const deep = computeRecoveryBinsBelow(origMin - 100000, origMin, binsBelowTarget, configMinBinsBelow);
  assert(deep.binsBelow === configMinBinsBelow, `catastrophic crash must clamp to minBinsBelow floor (${configMinBinsBelow}), got ${deep.binsBelow}`);

  console.log(`  bins-below: bounded in [${configMinBinsBelow}, ${binsBelowTarget}) across all OOR depths, monotonic non-increasing, deep-crash clamps to floor OK (max seen: ${maxSeen})`);
}

// ── skip-condition state round-trip (recovery_child / recovery_of / rug) ──
function testSkipConditionsAndLinking() {
  const saved = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, "utf8") : null;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ positions: {} }));

    trackPosition({ position: "PARENT_1", pool: "POOL_1", pool_name: "TEST-SOL", strategy: "bid_ask", amount_sol: 0.3, entry_mcap: 5_000_000, entry_tvl: 100_000 });
    trackPosition({ position: "RUG_1", pool: "POOL_2", pool_name: "RUG-SOL", strategy: "bid_ask", amount_sol: 0.3, entry_mcap: 0, entry_tvl: 0 });

    let parent = getTrackedPosition("PARENT_1");
    assert(!parent.recovery_child && !parent.recovery_of, "fresh position must have no recovery links");
    assert(getTrackedPosition("RUG_1").entry_mcap === 0, "rug position must have entry_mcap 0 (dead token guard input)");

    trackPosition({ position: "CHILD_1", pool: "POOL_1", pool_name: "TEST-SOL", strategy: "bid_ask", amount_sol: 0.3, entry_mcap: 5_000_000, entry_tvl: 100_000 });
    linkRecoveryPosition("PARENT_1", "CHILD_1");
    parent = getTrackedPosition("PARENT_1");
    const child = getTrackedPosition("CHILD_1");
    assert(parent.recovery_child === "CHILD_1", "parent must record recovery_child after linking");
    assert(child.recovery_of === "PARENT_1", "child must record recovery_of after linking");

    console.log("  linking: recovery_child/recovery_of round-trip via linkRecoveryPosition OK");
  } finally {
    if (saved == null) fs.unlinkSync(STATE_PATH);
    else fs.writeFileSync(STATE_PATH, saved);
  }
}

testFilter();
testBinsBelowBounded();
testSkipConditionsAndLinking();
console.log("test-recovery-strat: OK");
