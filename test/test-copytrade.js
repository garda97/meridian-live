/**
 * Unit tests for copytrade.js pure logic: position diffing (new/closed
 * entries) and mirror bin-math, both no-chain. Also covers the
 * "first observation = baseline snapshot, never mirror pre-existing
 * positions" invariant via smart-wallets type filtering.
 * Run: node test/test-copytrade.js
 */

import { diffWalletPositions, computeMirrorBins, getCopyTradeWallets } from "../copytrade.js";
import { addSmartWallet, removeSmartWallet } from "../smart-wallets.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── diffWalletPositions ─────────────────────────────────────────
function testDiffEmpty() {
  const { opened, closed } = diffWalletPositions([], []);
  assert(opened.length === 0, "no positions, no opens");
  assert(closed.length === 0, "no positions, no closes");
}

function testDiffAllNewOnFirstObservation() {
  // Simulates what would happen if a freshly-tracked wallet's existing
  // positions were diffed against an empty baseline — everything looks
  // "opened". This is exactly why runCopyTradePoll special-cases the
  // first observation instead of feeding [] into diffWalletPositions.
  const live = [{ position: "P1" }, { position: "P2" }];
  const { opened, closed } = diffWalletPositions([], live);
  assert(opened.length === 2, "diff alone treats all live positions as opened when prev is empty");
  assert(closed.length === 0, "no closes");
}

function testDiffDetectsNewEntry() {
  const prev = ["P1", "P2"];
  const live = [{ position: "P1" }, { position: "P2" }, { position: "P3" }];
  const { opened, closed } = diffWalletPositions(prev, live);
  assert(opened.length === 1 && opened[0].position === "P3", "must detect exactly the new position");
  assert(closed.length === 0, "no closes when nothing vanished");
}

function testDiffDetectsClosedEntry() {
  const prev = ["P1", "P2", "P3"];
  const live = [{ position: "P1" }, { position: "P3" }];
  const { opened, closed } = diffWalletPositions(prev, live);
  assert(opened.length === 0, "no opens when nothing new appeared");
  assert(closed.length === 1 && closed[0] === "P2", "must detect exactly the vanished position");
}

function testDiffSimultaneousOpenAndClose() {
  const prev = ["P1", "P2"];
  const live = [{ position: "P1" }, { position: "P3" }];
  const { opened, closed } = diffWalletPositions(prev, live);
  assert(opened.length === 1 && opened[0].position === "P3", "P3 is new");
  assert(closed.length === 1 && closed[0] === "P2", "P2 closed");
}

// ── computeMirrorBins ────────────────────────────────────────────
function testMirrorBinsFromLiveRange() {
  const theirs = { active_bin: 1000, lower_bin: 940, upper_bin: 1020 };
  const { binsBelow, binsAbove } = computeMirrorBins(theirs, 35, 69);
  assert(binsBelow === 60, `expected 60 bins below (1000-940), got ${binsBelow}`);
  assert(binsAbove === 20, `expected 20 bins above (1020-1000), got ${binsAbove}`);
}

function testMirrorBinsClampsToMinBelow() {
  // Their range is narrower than our safety floor — never deploy tighter
  // than minBinsBelow (mirrors deployPosition's own MIN_SAFE_BINS_BELOW guard).
  const theirs = { active_bin: 1000, lower_bin: 990, upper_bin: 1000 };
  const { binsBelow, binsAbove } = computeMirrorBins(theirs, 35, 69);
  assert(binsBelow === 35, `expected clamp to minBinsBelow=35, got ${binsBelow}`);
  assert(binsAbove === 0, "single-sided range (upper == active) means zero bins above");
}

function testMirrorBinsFallsBackOnMissingBinData() {
  // RPC gap: no bin_range on the source position — fall back to config
  // defaults rather than crashing or deploying a degenerate 0-bin range.
  const theirs = { active_bin: null, lower_bin: null, upper_bin: null };
  const { binsBelow, binsAbove } = computeMirrorBins(theirs, 35, 69);
  assert(binsBelow === 69, `expected fallback to defaultBinsBelow=69, got ${binsBelow}`);
  assert(binsAbove === 0, "no upside data means zero bins above by default");
}

// ── getCopyTradeWallets: only "copytrade"-typed wallets, never "lp"/"holder" ──
function testGetCopyTradeWalletsFiltersType() {
  // Base58 (no 0/O/I/lowercase-l) — Solana address shape for addSmartWallet's format check.
  const addr1 = "CTwa11et1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const addr2 = "CTwa11et2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  try {
    const add1 = addSmartWallet({ name: "ct-test", address: addr1, type: "copytrade" });
    const add2 = addSmartWallet({ name: "lp-test", address: addr2, type: "lp" });
    assert(add1.success, `test wallet 1 must be added: ${add1.error || ""}`);
    assert(add2.success, `test wallet 2 must be added: ${add2.error || ""}`);
    const wallets = getCopyTradeWallets();
    assert(wallets.some((w) => w.address === addr1), "copytrade-typed wallet must be included");
    assert(!wallets.some((w) => w.address === addr2), "lp-typed wallet must NOT be included");
  } finally {
    removeSmartWallet({ address: addr1 });
    removeSmartWallet({ address: addr2 });
  }
}

// ── tryMirrorEntry integration (DRY_RUN only — must never touch a real tx) ──
// Skipped (not failed) when run without DRY_RUN=true, since this is the only
// test in the suite that needs live RPC + the DRY_RUN guard together. Run
// explicitly with: DRY_RUN=true node test/test-copytrade.js
async function testTryMirrorEntryBlocksDuplicatePool() {
  if (process.env.DRY_RUN !== "true") {
    console.log("testTryMirrorEntryBlocksDuplicatePool: skipped (needs DRY_RUN=true node test/test-copytrade.js)");
    return;
  }
  const { tryMirrorEntry } = await import("../copytrade.js");
  const { getMyPositions } = await import("../tools/dlmm.js");
  const live = await getMyPositions({ force: true, silent: true });
  const openPool = live?.positions?.[0]?.pool;
  if (!openPool) {
    console.log("testTryMirrorEntryBlocksDuplicatePool: skipped (no open position to reuse as a duplicate-pool target)");
    return;
  }

  const fakeWallet = { name: "dupe-test", address: "CTwa11et3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" };
  const theirPosition = {
    position: "FAKE_MIRROR_SOURCE_POSITION",
    pool: openPool,
    lower_bin: -608,
    upper_bin: -568,
    active_bin: -571,
    total_value_usd: 100,
  };
  const entry = { mirrors: {} };
  const result = await tryMirrorEntry(fakeWallet, theirPosition, entry);
  // The pool safety check (duplicate-pool guard) must fire BEFORE
  // deployPosition's own DRY_RUN short-circuit — this proves the mirror
  // path goes through the same executeTool safety gates as a normal deploy.
  assert(result.skipped, `expected the duplicate-pool guard to block this mirror, got: ${JSON.stringify(result)}`);
  assert(Object.keys(entry.mirrors).length === 0, "a skipped mirror must not be recorded");
}

testDiffEmpty();
testDiffAllNewOnFirstObservation();
testDiffDetectsNewEntry();
testDiffDetectsClosedEntry();
testDiffSimultaneousOpenAndClose();
testMirrorBinsFromLiveRange();
testMirrorBinsClampsToMinBelow();
testMirrorBinsFallsBackOnMissingBinData();
testGetCopyTradeWalletsFiltersType();
await testTryMirrorEntryBlocksDuplicatePool();

console.log("test-copytrade: OK");
