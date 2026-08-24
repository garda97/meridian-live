/**
 * Unit tests for the pre-deploy holder-quality gate (no network).
 * Run: node test/test-holder-quality-gate.js
 */

import { checkHolderQuality } from "../utils/holder-quality-gate.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CFG = {
  maxBundlerTop100Pct: 25,
  maxFreshWalletHolderPct: 40,
  maxBundledWalletHolderPct: 30,
};

// Missing data fails open, but must say so — a pass without data is not a pass
// on data, and the caller logs on `checked === false`.
{
  const v = checkHolderQuality(null, 1000, CFG);
  assert(v.pass, "missing stats must fail open");
  assert(v.checked === false, "missing stats must report checked=false");
}

// Clean token passes with checked=true.
{
  const stats = { bundlers_pct_in_top_100: 5, fresh_wallet_count: 10, bundlers_in_top_100: 12 };
  const v = checkHolderQuality(stats, 1000, CFG);
  assert(v.pass && v.checked, `clean token must pass on data: ${v.reason}`);
}

// Bundler supply share over the cap blocks.
{
  const v = checkHolderQuality({ bundlers_pct_in_top_100: 40.86 }, 1000, CFG);
  assert(!v.pass && v.checked, "40.86% bundlers must block against max 25%");
  assert(/bundlers 40.86%/.test(v.reason), `reason must quote the value: ${v.reason}`);
}

// Boundary: exactly at the cap passes (rules are strictly-greater).
{
  const v = checkHolderQuality({ bundlers_pct_in_top_100: 25 }, 1000, CFG);
  assert(v.pass, "exactly at the cap must pass");
  const over = checkHolderQuality({ bundlers_pct_in_top_100: 25.01 }, 1000, CFG);
  assert(!over.pass, "just over the cap must block");
}

// Fresh-wallet share is a ratio against total holders, not a raw count.
{
  // 500 fresh of 1000 holders = 50% > 40%
  const v = checkHolderQuality({ fresh_wallet_count: 500 }, 1000, CFG);
  assert(!v.pass, "50% fresh wallets must block against max 40%");
  // same raw count against a larger holder base = 5%, passes
  const ok = checkHolderQuality({ fresh_wallet_count: 500 }, 10000, CFG);
  assert(ok.pass, "same count over a larger holder base must pass");
}

// bundled_wallet_holder_pct is derived from bundlers_in_top_100 — the field name
// that a local reimplementation would most easily get wrong.
{
  // 400 of 1000 = 40% > 30%
  const v = checkHolderQuality({ bundlers_in_top_100: 400 }, 1000, CFG);
  assert(!v.pass, "40% bundled wallets must block against max 30%");
  assert(/bundled wallets/.test(v.reason), `reason must name the rule: ${v.reason}`);
}

// Null caps disable individual rules.
{
  const stats = { bundlers_pct_in_top_100: 99, fresh_wallet_count: 999, bundlers_in_top_100: 999 };
  const v = checkHolderQuality(stats, 1000, {});
  assert(v.pass && v.checked, "all-null config must disable every rule but still count as checked");
}

// Unknown holder count disables the ratio rules but not the supply-share rule.
{
  const ratioOnly = checkHolderQuality({ fresh_wallet_count: 999 }, null, CFG);
  assert(ratioOnly.pass, "unknown holder count must disable ratio rules");
  const supply = checkHolderQuality({ bundlers_pct_in_top_100: 90 }, null, CFG);
  assert(!supply.pass, "supply-share rule must still apply without a holder count");
}

// Garbage values must not throw or block.
{
  const v = checkHolderQuality({ bundlers_pct_in_top_100: "n/a", fresh_wallet_count: undefined }, 1000, CFG);
  assert(v.pass, "unparseable stats must not block");
}

console.log("  holder-quality-gate: fail-open/bundler/fresh/bundled/boundaries/null-caps OK");
console.log("test-holder-quality-gate: OK");
