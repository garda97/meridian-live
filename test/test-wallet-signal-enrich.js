import assert from "node:assert/strict";
import { buildWalletSignal, formatWalletSignalNote, isWalletSignalComplete } from "../utils/wallet-signal-enrich.js";

const solOnly = buildWalletSignal({
  wallet_name: "lp-jago-1",
  wallet_address: "AvtAvV1VtcrHvCQwceZKLLH5i6mdWL5fi64uAW1BVAiG",
  position: {
    position: "FM73VVf4",
    pool: "5WSv11XV",
    lower_bin: -612,
    upper_bin: -450,
    active_bin: -468,
    in_range: true,
    total_value_usd: 152,
    age_minutes: 5,
    unclaimed_fees_usd: 0.08,
  },
  pnlRaw: {
    allTimeDeposits: {
      tokenX: { amount: "0", usd: "0" },
      tokenY: { amount: "2", usd: "151.9" },
    },
    isOutOfRange: false,
  },
});

assert.equal(solOnly.inferred_strategy, "bid_ask");
assert.equal(solOnly.strategy_confidence, "high");
assert.equal(solOnly.deposit_side, "sol_only");
assert.equal(solOnly.range_style, "wide");
assert.equal(solOnly.width_bins, 162);
assert.ok(formatWalletSignalNote(solOnly).includes("bid_ask"));

const dualSpot = buildWalletSignal({
  wallet_name: "test",
  wallet_address: "test",
  position: { lower_bin: 100, upper_bin: 200, active_bin: 150, in_range: true },
  pnlRaw: {
    allTimeDeposits: {
      tokenX: { amount: "1000", usd: "50" },
      tokenY: { amount: "1", usd: "75" },
    },
  },
});
assert.equal(dualSpot.inferred_strategy, "spot");
assert.equal(dualSpot.deposit_side, "dual");
assert.equal(isWalletSignalComplete(solOnly), true);
assert.equal(isWalletSignalComplete(buildWalletSignal({
  wallet_name: "x", wallet_address: "x", position: { lower_bin: 1, upper_bin: 10 }, pnlRaw: null,
})), false);

console.log("test-wallet-signal-enrich: OK");