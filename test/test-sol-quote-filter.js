/**
 * Unit tests: SOL-quote deploy gate + Token-2022 allow (misdiagnosis fix).
 * Run: node test/test-sol-quote-filter.js
 */
import assert from "assert";
import {
  SOL_MINT,
  isSolQuotePool,
  filterUnsupportedDeployPools,
} from "../tools/screening.js";

function testIsSolQuotePool() {
  assert.strictEqual(isSolQuotePool({ quote: { mint: SOL_MINT, symbol: "SOL" } }), true);
  assert.strictEqual(
    isSolQuotePool({ quote: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" } }),
    false,
  );
  assert.strictEqual(isSolQuotePool({ token_y: { address: SOL_MINT } }), true);
  assert.strictEqual(isSolQuotePool({}), false);
  assert.strictEqual(isSolQuotePool(null), false);
  console.log("  isSolQuotePool OK");
}

function testFilterUnsupportedDeployPools() {
  const eligible = [
    { name: "Jotchua-SOL", quote: { mint: SOL_MINT, symbol: "SOL" }, pool: "jot1" },
    { name: "KINS-USDC", quote: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" }, pool: "kins1" },
    { name: "febu-SOL", quote: { mint: SOL_MINT, symbol: "SOL" }, pool: "feb1" }, // T22 base still allowed
  ];
  const filteredOut = [];
  filterUnsupportedDeployPools(eligible, filteredOut);
  assert.strictEqual(eligible.length, 2, "should keep 2 SOL-quote pools");
  assert.deepStrictEqual(
    eligible.map((p) => p.name).sort(),
    ["Jotchua-SOL", "febu-SOL"].sort(),
  );
  assert.strictEqual(filteredOut.length, 1);
  assert.match(filteredOut[0].reason || filteredOut[0].reason === undefined ? (filteredOut[0].reason ?? "") : "", /./);
  // filteredOut shape from pushFilteredReason — accept name/reason objects
  const reasonText = JSON.stringify(filteredOut[0]);
  assert.match(reasonText, /USDC|not SOL/i);
  console.log("  filterUnsupportedDeployPools OK");
}

console.log("=== test-sol-quote-filter ===");
testIsSolQuotePool();
testFilterUnsupportedDeployPools();
console.log("=== PASS ===");
