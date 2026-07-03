/**
 * Unit tests for sanitizeToolName — model-mangled tool name recovery.
 * Run: node test/test-tool-sanitize.js
 */

import { sanitizeToolName } from "../tools/executor.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Exact name untouched
let r = sanitizeToolName("get_top_candidates");
assert(r.known && r.name === "get_top_candidates" && !r.corrected, "exact name must pass through");

// Channel artifact stripped
r = sanitizeToolName("get_top_candidates<|channel|>commentary");
assert(r.known && r.name === "get_top_candidates", `artifact strip failed: ${r.name}`);

// Namespace prefix stripped
r = sanitizeToolName("functions.get_top_candidates");
assert(r.known && r.name === "get_top_candidates", `prefix strip failed: ${r.name}`);

// Compat camel-case alias with numeric suffix → fuzzy match
r = sanitizeToolName("CompatGetTopCandidates8964");
assert(r.known && r.name === "get_top_candidates" && r.corrected, `compat fuzzy match failed: ${r.name}`);

// Camel-case without prefix
r = sanitizeToolName("GetWalletBalance");
assert(r.known && r.name === "get_wallet_balance", `camelCase fuzzy match failed: ${r.name}`);

// Unknown stays unknown
r = sanitizeToolName("TotallyBogusTool");
assert(!r.known, "bogus tool must not resolve");

// Empty/garbage safe
r = sanitizeToolName("");
assert(!r.known, "empty name must not resolve");
r = sanitizeToolName(null);
assert(!r.known, "null name must not resolve");

console.log("  tool-sanitize: exact/artifact/prefix/compat/camel resolved, bogus rejected OK");
console.log("test-tool-sanitize: OK");
