/**
 * Wiring test for the pre-deploy holder gate (no network).
 *
 * The gate reads its mint and holder count off `args._auto_strategy_plan`,
 * which applyPendingPlanToDeployArgs attaches from the pending-plan store. If
 * either field stops being carried, the gate degrades to a silent no-op that
 * still looks installed — the exact failure this test exists to catch.
 *
 * Run: node test/test-holder-gate-wiring.js
 */

import {
  setPendingDeployPlan,
  applyPendingPlanToDeployArgs,
  attachCandidateIdentity,
} from "../tools/strategy-router.js";
import { checkHolderQuality } from "../utils/holder-quality-gate.js";
import { config } from "../config.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

config.autoStrategy = { ...(config.autoStrategy ?? {}), enabled: true };

const POOL = "PoolAddr1111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111";

// Step 1: the candidate -> plan copy that resolveDeployPlansForCandidates does.
// A plan that loses either field turns the gate into a silent no-op.
{
  const plan = attachCandidateIdentity(
    { strategy: "bid_ask", bins_below: 69, bins_above: 0 },
    { pool: { pool: POOL, base: { mint: MINT } }, ti: { holders: 1000 } },
  );
  assert(plan.base_mint === MINT, `attachCandidateIdentity must set base_mint, got ${plan.base_mint}`);
  assert(
    plan.base_token_holders === 1000,
    `attachCandidateIdentity must set base_token_holders, got ${plan.base_token_holders}`,
  );

  // Falls back to the pool when token info is missing.
  const fallback = attachCandidateIdentity({}, {
    pool: { pool: POOL, base_mint: MINT, base_token_holders: 42 },
  });
  assert(fallback.base_mint === MINT, "must fall back to pool.base_mint");
  assert(fallback.base_token_holders === 42, "must fall back to pool.base_token_holders");

  // Absent everywhere resolves to null, never undefined — the gate tests `!= null`.
  const empty = attachCandidateIdentity({}, { pool: {} });
  assert(empty.base_mint === null, "missing mint must be null");
  assert(empty.base_token_holders === null, "missing holder count must be null");

  setPendingDeployPlan(POOL, plan);
}

const args = applyPendingPlanToDeployArgs({ pool_address: POOL, amount_y: 0.5, amount_x: 0 });
const plan = args._auto_strategy_plan;

assert(plan, "applyPendingPlanToDeployArgs must attach _auto_strategy_plan");
assert(plan.base_mint === MINT, `plan must carry base_mint, got ${plan.base_mint}`);
assert(
  plan.base_token_holders === 1000,
  `plan must carry base_token_holders for the ratio rules, got ${plan.base_token_holders}`,
);

// The values the executor reads must drive a real verdict, not a silent pass.
{
  const mint = plan.base_mint ?? args.base_mint ?? null;
  assert(mint === MINT, "executor's mint resolution must find the plan mint");

  const holderCount = Number(
    plan.base_token_holders ?? args.base_token_holders ?? args.holders,
  ) || null;
  assert(holderCount === 1000, `executor's holder-count resolution failed, got ${holderCount}`);

  // 400 bundled of 1000 holders = 40%, over a 30% cap -> must block.
  const verdict = checkHolderQuality(
    { bundlers_in_top_100: 400 },
    holderCount,
    { maxBundledWalletHolderPct: 30 },
  );
  assert(!verdict.pass, "wired-through holder count must let the ratio rule block");
  assert(verdict.checked, "verdict must report checked=true when data was present");
}

// Missing holder count must not silently disable the supply-share rule.
{
  const verdict = checkHolderQuality({ bundlers_pct_in_top_100: 90 }, null, { maxBundlerTop100Pct: 25 });
  assert(!verdict.pass, "supply-share rule must survive a missing holder count");
}

console.log("  holder-gate-wiring: plan carries base_mint + base_token_holders into the gate OK");
console.log("test-holder-gate-wiring: OK");
