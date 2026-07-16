/**
 * Unit tests for transaction submit helpers (no network).
 * Run: node test/test-tx-submit.js
 */

import { isSignatureExpiredError } from "../tools/dlmm/sdk.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(isSignatureExpiredError(new Error("Signature expired: block height exceeded")), "block height exceeded");
assert(isSignatureExpiredError(new Error("Transaction signature expired")), "signature expired phrase");
assert(isSignatureExpiredError(new Error("Blockhash not found")), "blockhash not found");
assert(!isSignatureExpiredError(new Error("insufficient funds")), "unrelated error must not match");
assert(!isSignatureExpiredError(null), "null must not match");

console.log("  tx-submit: expiry detection OK");
console.log("test-tx-submit: OK");