/**
 * Regression: Meteora closed API can report phantom -60% PnL when withdrawals
 * have not aggregated yet (BULLCAT 2026-07-16). Guard waits for settled
 * withdrawals and can override extreme API pnl when IL was ~0.
 * Run: node --test test/test-closed-pnl-settlement.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClosedWithdrawalSettled,
  applySettledWithdrawalPnlOverride,
} from "../tools/dlmm/rules.js";

describe("isClosedWithdrawalSettled", () => {
  it("rejects partial withdrawal right after close", () => {
    assert.equal(isClosedWithdrawalSettled(58.13, 22.82), false);
  });

  it("accepts fully settled withdrawal", () => {
    assert.equal(isClosedWithdrawalSettled(58.13, 58.13), true);
  });
});

describe("applySettledWithdrawalPnlOverride", () => {
  it("replaces phantom -60% with breakeven when IL was tiny", () => {
    const out = applySettledWithdrawalPnlOverride({
      pnlPct: -60.68,
      pnlUsd: -35.27,
      ilPct: -0.64,
      finalValueUsd: 58.126,
      initialUsd: 58.129,
      feesUsd: 0.037,
    });
    assert.equal(out.overridden, true);
    assert.ok(out.pnlPct > -1 && out.pnlPct < 1, `expected ~0%, got ${out.pnlPct}`);
    assert.ok(out.pnlUsd > -1 && out.pnlUsd < 1, `expected ~$0, got ${out.pnlUsd}`);
  });

  it("does not override real stop-loss disasters", () => {
    const out = applySettledWithdrawalPnlOverride({
      pnlPct: -62,
      pnlUsd: -36,
      ilPct: -55,
      finalValueUsd: 22,
      initialUsd: 58,
      feesUsd: 0.1,
    });
    assert.equal(out.overridden, false);
    assert.equal(out.pnlPct, -62);
  });
});