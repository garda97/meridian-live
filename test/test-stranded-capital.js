/**
 * Test for the stranded-capital ledger (fees-maxi "stranded wallet capital"
 * port, #4 of the review): base tokens left unsold after a failed auto-swap
 * (FROGBULL/NYAN dust failure mode) previously vanished from all accounting.
 * Covers:
 *  1. recordStranded / getUnrecoveredStrandedUsd / markStrandedRecovered
 *     lifecycle, incl. same-mint dedup (repeated failures = one stuck lot).
 *  2. strandedEntriesDueForRetry cooldown logic (pure).
 *  3. checkDailyLossGate counts stranded USD toward the limit: realized -$60
 *     + stranded $25 trips an $80 limit that realized alone would not.
 *  4. Gate unchanged when strandedUsd is 0/omitted (backward compat).
 * Run: node test/test-stranded-capital.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import {
  recordStranded,
  markStrandedRecovered,
  markStrandedRetry,
  getUnrecoveredStranded,
  getUnrecoveredStrandedUsd,
  strandedEntriesDueForRetry,
} from "../stranded-capital.js";
import { checkDailyLossGate } from "../utils/daily-loss.js";

const STORE = repoPath("stranded-capital.json");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const saved = fs.existsSync(STORE) ? fs.readFileSync(STORE, "utf8") : null;

try {
  fs.writeFileSync(STORE, JSON.stringify({ entries: [] }));

  // 1. Ledger lifecycle + dedup.
  recordStranded({ mint: "MINT_A", symbol: "FROGBULL", amount: 1000, usd_at_strand: 12.5, label: "after close", pool_name: "FROGBULL-SOL" });
  recordStranded({ mint: "MINT_B", symbol: "NYAN", amount: 500, usd_at_strand: 12.5, label: "after claim" });
  recordStranded({ mint: "MINT_A", symbol: "FROGBULL", amount: 990, usd_at_strand: 11.0, label: "after close" }); // dedup, keeps max usd
  assert(getUnrecoveredStranded().length === 2, `dedup by mint must hold: ${getUnrecoveredStranded().length}`);
  assert(getUnrecoveredStrandedUsd() === 25, `sum must be 25: ${getUnrecoveredStrandedUsd()}`);
  markStrandedRecovered("MINT_B", { usd_recovered: 8.1 });
  assert(getUnrecoveredStrandedUsd() === 12.5, `recovered entry must leave the sum: ${getUnrecoveredStrandedUsd()}`);
  const recovered = JSON.parse(fs.readFileSync(STORE, "utf8")).entries.find((e) => e.mint === "MINT_B");
  assert(recovered.usd_recovered === 8.1 && recovered.recovered_at, "recovered entry must carry realized value");
  console.log("  ✓ ledger record/dedup/recover lifecycle");

  // 2. Retry cooldown (pure).
  const now = Date.now();
  const entries = [
    { mint: "X", stranded_at: new Date(now - 60 * 60000).toISOString(), last_retry_at: null },
    { mint: "Y", stranded_at: new Date(now - 60 * 60000).toISOString(), last_retry_at: new Date(now - 5 * 60000).toISOString() },
    { mint: "Z", stranded_at: new Date(now - 60 * 60000).toISOString(), last_retry_at: new Date(now - 20 * 60000).toISOString(), recovered_at: null },
    { mint: "W", stranded_at: new Date(now - 60 * 60000).toISOString(), recovered_at: new Date().toISOString() },
  ];
  const due = strandedEntriesDueForRetry(entries, now, 15).map((e) => e.mint);
  assert(due.includes("X") && due.includes("Z"), `X (never retried) and Z (20m ago) must be due: ${due}`);
  assert(!due.includes("Y"), "Y retried 5m ago must respect 15m cooldown");
  assert(!due.includes("W"), "recovered entries are never due");
  markStrandedRetry("MINT_A");
  assert(strandedEntriesDueForRetry(getUnrecoveredStranded(), Date.now(), 15).length === 0,
    "fresh retry stamp must push the entry out of the due set");
  console.log("  ✓ retry cooldown selection");

  // 3. Daily-loss gate counts stranded capital.
  const decisions = [
    { type: "close", ts: new Date().toISOString(), metrics: { pnl_usd: -60 } },
  ];
  let gate = checkDailyLossGate({ decisions, limitUsd: 80, strandedUsd: 25 });
  assert(gate.blocked === true, `realized -60 + stranded 25 must trip an 80 limit: ${JSON.stringify(gate)}`);
  assert(gate.effectiveLossUsd === -85, `effective loss must be -85: ${gate.effectiveLossUsd}`);
  console.log("  ✓ gate trips on realized + stranded");

  // 4. Backward compat: same numbers without stranded do NOT trip.
  gate = checkDailyLossGate({ decisions, limitUsd: 80 });
  assert(gate.blocked === false && gate.strandedUsd === 0,
    `realized -60 alone must not trip 80: ${JSON.stringify(gate)}`);
  console.log("  ✓ gate unchanged without stranded (backward compat)");

  console.log("\nAll stranded-capital tests passed ✅");
} finally {
  if (saved == null) fs.unlinkSync(STORE);
  else fs.writeFileSync(STORE, saved);
}
process.exit(0);
