/**
 * Unit tests for the TGE strategy override (Gap 1 — pure, no network).
 * Run: node test/test-tge-override.js
 */

import { applyTgeOverride } from "../tools/strategy-router.js";
import { config } from "../config.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const basePlan = {
  market_view: "retracement",
  strategy: "bid_ask",
  deposit_side: "sol_below",
  bins_below: 60,
  bins_above: 0,
  entry_allowed: true,
  entry_reason: "ok",
  notes: [],
};

const saved = {
  tgeMaxAgeHours: config.autoStrategy.tgeMaxAgeHours,
  tgeMinFeePct: config.autoStrategy.tgeMinFeePct,
  allowSpot: config.autoStrategy.allowSpot,
  maxBins: config.autoStrategy.maxBins,
};
try {
  config.autoStrategy.tgeMinFeePct = 5;
  config.autoStrategy.allowSpot = true;
  config.autoStrategy.maxBins = 200;

  // OFF (null) → untouched
  config.autoStrategy.tgeMaxAgeHours = null;
  let p = applyTgeOverride(basePlan, { pool: { token_age_hours: 1, fee_pct: 10 } });
  assert(p === basePlan, "disabled must return plan untouched");

  config.autoStrategy.tgeMaxAgeHours = 4;

  // Fresh token + high fee → TGE spot wide
  p = applyTgeOverride(basePlan, { pool: { token_age_hours: 1.5, fee_pct: 10 } });
  assert(p.tge === true, "fresh+high-fee must flag tge");
  assert(p.strategy === "spot" && p.deposit_side === "sol_balanced", "TGE must go spot balanced");
  assert(p.bins_below + p.bins_above === 200 && p.wide_range, `TGE must use max width, got ${p.bins_below}/${p.bins_above}`);
  assert(p.entry_allowed === true, "eligible TGE must stay allowed");
  assert(basePlan.strategy === "bid_ask", "input plan must not be mutated");

  // Fresh token + LOW fee → blocked
  p = applyTgeOverride(basePlan, { pool: { token_age_hours: 1.5, fee_pct: 2 } });
  assert(p.tge === true && p.entry_allowed === false, "fresh+low-fee must block");
  assert(p.entry_reason.includes("fee tier"), `block reason should mention fee tier, got: ${p.entry_reason}`);

  // Old token → untouched even with high fee
  p = applyTgeOverride(basePlan, { pool: { token_age_hours: 12, fee_pct: 10 } });
  assert(p === basePlan, "old token must be untouched");

  // Age exactly at threshold → not TGE (strict <)
  p = applyTgeOverride(basePlan, { pool: { token_age_hours: 4, fee_pct: 10 } });
  assert(p === basePlan, "age == threshold must not trigger");

  // Missing age → untouched (fail-open, no false TGE)
  p = applyTgeOverride(basePlan, { pool: { fee_pct: 10 } });
  assert(p === basePlan, "missing age must be untouched");

  // Spot disabled → max-width bid_ask below instead
  config.autoStrategy.allowSpot = false;
  p = applyTgeOverride(basePlan, { pool: { token_age_hours: 1, fee_pct: 10 } });
  assert(p.strategy === "bid_ask" && p.bins_below === 200 && p.bins_above === 0, "no-spot TGE must be max-width bid_ask below");

  console.log("  tge-override: off/fresh-high/fresh-low/old/boundary/missing/no-spot OK");
  console.log("test-tge-override: OK");
} finally {
  config.autoStrategy.tgeMaxAgeHours = saved.tgeMaxAgeHours;
  config.autoStrategy.tgeMinFeePct = saved.tgeMinFeePct;
  config.autoStrategy.allowSpot = saved.allowSpot;
  config.autoStrategy.maxBins = saved.maxBins;
}
