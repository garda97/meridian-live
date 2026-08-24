/**
 * Offline check for the free-tier 429 classifier (agent.js).
 *
 * 2026-08-06: the screening/management agent loop was pinned to `Hermes-free`,
 * which answered every call with `429 FreeUsageLimitError`. The old handler
 * slept 30s and retried the SAME exhausted model once per step, so every cycle
 * burned maxSteps × 30s and produced no decision. A free-tier quota 429 has to
 * be told apart from an ordinary per-minute 429: the first means "switch model
 * / give up this cycle", the second means "back off and retry".
 *
 * Run: node test/test-llm-rate-limit.js
 */

import { isFreeQuotaError } from "../agent.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Verbatim shape the OpenAI SDK raises for the 9router response we observed
// (the SDK folds the response body into error.message).
const freeQuota429 = Object.assign(
  new Error('429 {"error":{"message":"[429]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"FreeUsageLimitError\\",\\"message\\":\\"Rate limit exceeded. Please try again later.\\"}}"}}'),
  { status: 429 },
);
assert(isFreeQuotaError(freeQuota429), "FreeUsageLimitError 429 must be classified as free-tier quota");

// An ordinary throttle must NOT be classified as quota exhaustion — it should
// keep using the backoff path, not soft-fail the cycle.
const plain429 = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
assert(!isFreeQuotaError(plain429), "plain 429 must stay on the backoff path, not soft-fail");

// Status is part of the test: a non-429 that merely mentions quota is unrelated.
const notRateLimited = Object.assign(new Error("400 quota field is invalid"), { status: 400 });
assert(!isFreeQuotaError(notRateLimited), "non-429 must never classify as free-tier quota");

// Errors carrying status on .response (some SDK/proxy shapes) still classify.
const nested = Object.assign(new Error("FreeUsageLimitError: Rate limit exceeded"), {
  response: { status: 429 },
});
assert(isFreeQuotaError(nested), "429 on error.response.status must classify too");

// Junk must not throw.
assert(!isFreeQuotaError(null), "null must not classify or throw");
assert(!isFreeQuotaError(undefined), "undefined must not classify or throw");

console.log("test-llm-rate-limit: OK");
