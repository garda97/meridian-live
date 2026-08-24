/**
 * Unit tests for the pre-deploy adversarial review (no network).
 * Run: node test/test-adversarial-review.js
 */

import { buildReviewPrompt, parseReviewVerdict } from "../utils/adversarial-review.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- verdict parsing -------------------------------------------------------

// It must be able to block, or the whole gate is theatre.
{
  const v = parseReviewVerdict(
    "VERDICT: BLOCK\nREASON: bundlers hold 41% of the top-100 supply, so exit liquidity is one wallet cluster",
  );
  assert(v.block && v.parsed, "a well-formed BLOCK must block");
  assert(/bundlers hold 41%/.test(v.reason), `reason must be carried through: ${v.reason}`);
}

// And it must be able to pass, or it halts trading.
{
  const v = parseReviewVerdict("VERDICT: PASS\nREASON: metrics are thin but nothing specific argues against entry");
  assert(!v.block && v.parsed, "a well-formed PASS must not block");
}

// Infrastructure trouble is not a risk signal — unparseable output fails open.
// The empty string is the case that actually occurs: these router combos return
// an empty message on a meaningful fraction of calls, which is why completeOnce
// retries before the verdict is ever parsed.
{
  for (const bad of ["", "   \n  ", null, undefined, "I think this looks risky honestly", "{}"]) {
    const v = parseReviewVerdict(bad);
    assert(!v.block, `unparseable reviewer output must not block: ${JSON.stringify(bad)}`);
    assert(v.parsed === false, "unparseable output must report parsed=false");
  }
}

// A BLOCK with no usable reason is a formatting slip, not a finding.
{
  const v = parseReviewVerdict("VERDICT: BLOCK");
  assert(!v.block, "BLOCK without a REASON line must not block");
  const terse = parseReviewVerdict("VERDICT: BLOCK\nREASON: bad");
  assert(!terse.block, "BLOCK with a too-short reason must not block");
}

// Format tolerance: casing, leading prose, extra whitespace.
{
  assert(parseReviewVerdict("verdict: block\nreason: top-10 concentration is 78% after the dev unlock").block,
    "lowercase verdict must still parse");
  assert(parseReviewVerdict("  VERDICT:   BLOCK  \n  REASON:   fee/TVL edge is an artefact of $900 TVL").block,
    "extra whitespace must still parse");
  assert(parseReviewVerdict("Here is my review.\nVERDICT: BLOCK\nREASON: pool memory shows 3 straight out-of-range closes").block,
    "a preamble before the verdict must still parse");
}

// The word "block" in prose must not be mistaken for a verdict.
{
  const v = parseReviewVerdict("The token could block transfers.\nVERDICT: PASS\nREASON: transfer hook is renounced");
  assert(!v.block, "the word 'block' in prose must not flip the verdict");
}

// --- prompt construction ---------------------------------------------------
{
  const prompt = buildReviewPrompt({
    candidateBlock: "POOL: FOO-SOL (abc123)\n  audit: top10=41%",
    plan: { strategy: "bid_ask", downside_pct: 90, upside_pct: 0, market_view: "dip", view_reason: "1h -32%" },
    args: { pool_address: "abc123", amount_y: 0.5 },
  });
  assert(prompt.includes("top10=41%"), "prompt must carry the candidate evidence");
  assert(prompt.includes("downside 90%"), "prompt must state the proposed range");
  assert(prompt.includes("0.5 SOL"), "prompt must state the position size");
  assert(/VERDICT:\s*BLOCK or PASS/.test(prompt), "prompt must pin the answer format");
  // Generic memecoin risk is always present; if it counted, the gate would
  // block every trade and be switched off within a day.
  assert(/not for generic memecoin risk/i.test(prompt), "prompt must exclude generic risk as a blocking reason");

  const noData = buildReviewPrompt({ candidateBlock: null, plan: null, args: {} });
  assert(noData.includes("candidate detail unavailable"), "missing candidate data must be stated, not silently empty");
}

console.log("  adversarial-review: block/pass/fail-open/format-tolerance/prompt OK");
console.log("test-adversarial-review: OK");
