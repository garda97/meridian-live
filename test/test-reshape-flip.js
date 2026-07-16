import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeWalletBalanceDelta,
  applyDepositSafetyBps,
  humanToLamports,
} from "../tools/dlmm/balance-delta.js";
import { shouldReshape, shouldFlipToCurve } from "../tools/position-router.js";
import { computeTokenValueShare } from "../tools/dlmm/rules.js";

describe("balance-delta", () => {
  it("computes wallet delta after withdraw", () => {
    const before = { sol: 1, tokens: [{ mint: "MINT", amount: 0 }] };
    const after = { sol: 1.5, tokens: [{ mint: "MINT", amount: 1000 }] };
    const d = computeWalletBalanceDelta(before, after, "MINT");
    assert.equal(d.delta_sol, 0.5);
    assert.equal(d.delta_x, 1000);
  });

  it("applies deposit safety bps", () => {
    const s = applyDepositSafetyBps(100, 2, 9950);
    assert.ok(s.amount_x < 100);
    assert.ok(s.amount_y < 2);
  });

  it("humanToLamports", () => {
    const l = humanToLamports({ amount_x: 1, amount_y: 0.5, decimals_x: 6 });
    assert.equal(l.amount_x_lamports, "1000000");
    assert.equal(l.amount_y_lamports, "500000000");
  });
});

describe("shouldReshape", () => {
  it("triggers on bin drift", () => {
    const r = shouldReshape({
      position: { in_range: true, active_bin: 100 },
      tracked: { strategy: "curve", last_reshape_bin: 90 },
      activeBin: 100,
      cfg: { reshape: { enabled: true, binTrigger: 3, minIntervalMs: 0 } },
    });
    assert.equal(r.reshape, true);
  });

  it("skips when disabled", () => {
    const r = shouldReshape({
      position: { in_range: true, active_bin: 100 },
      tracked: { strategy: "curve" },
      cfg: { reshape: { enabled: false } },
    });
    assert.equal(r.reshape, false);
  });
});

describe("shouldFlipToCurve", () => {
  it("flips when share in band", () => {
    const r = shouldFlipToCurve({
      position: { in_range: true, token_x_value_usd: 50, token_y_value_usd: 50 },
      tracked: { strategy: "bid_ask" },
      cfg: { flip: { enabled: true, ratioLow: 0.4, ratioHigh: 0.6 }, management: {} },
    });
    assert.equal(r.flip, true);
  });

  it("computeTokenValueShare", () => {
    assert.equal(computeTokenValueShare({ token_x_value_usd: 40, token_y_value_usd: 60 }), 0.4);
  });
});