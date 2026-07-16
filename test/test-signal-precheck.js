import assert from "node:assert/strict";
import { isSolQuoteDiscoveryPool } from "../discord-listener/pre-checks.js";

const SOL = "So11111111111111111111111111111111111111112";

assert.equal(
  isSolQuoteDiscoveryPool({ token_y: { address: SOL, symbol: "SOL" } }),
  true,
  "SOL quote pool must pass",
);
assert.equal(
  isSolQuoteDiscoveryPool({ token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }),
  false,
  "USDC quote pool must fail",
);

console.log("test-signal-precheck: OK");