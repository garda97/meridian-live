/**
 * Adversarial review of a deploy decision.
 *
 * The SCREENER both picks the winner and justifies it, so nothing in the cycle
 * argues the other side. This runs a second model over the chosen candidate
 * with the opposite job — find the reason not to enter — and blocks the deploy
 * only on a clear verdict.
 *
 * Design constraints, in order of importance:
 *
 *   1. It runs last. Every deterministic gate (plan, thresholds, bin step,
 *      holder quality, balance) is cheaper and more reliable, so the LLM call
 *      only happens for a candidate that already passed all of them.
 *   2. It fails open. A router timeout, a bad key, or an unparseable answer
 *      must not block trading — infrastructure trouble is not a risk signal.
 *      Every such case is logged, because passing without a verdict is not the
 *      same as passing on one.
 *   3. It must be able to say no. A reviewer that never blocks is theatre, and
 *      one that always blocks halts the bot, so the verdict is a strict token
 *      match rather than sentiment: only an explicit BLOCK line blocks.
 */

const VERDICT_RE = /^\s*VERDICT:\s*(BLOCK|PASS)\b/im;
const REASON_RE = /^\s*REASON:\s*(.+)$/im;

export function buildReviewPrompt({ candidateBlock, plan, args }) {
  const facts = [
    `pool: ${args?.pool_address ?? "unknown"}`,
    `strategy: ${plan?.strategy ?? args?.strategy ?? "unknown"}`,
    plan?.downside_pct != null
      ? `range: downside ${plan.downside_pct}% / upside ${plan.upside_pct ?? 0}%`
      : `bins: ${args?.bins_below ?? "?"} below / ${args?.bins_above ?? 0} above`,
    `size: ${args?.amount_y ?? args?.amount_sol ?? "?"} SOL`,
    plan?.market_view ? `router view: ${plan.market_view} (${plan.view_reason ?? "no reason given"})` : null,
  ].filter(Boolean).join("\n");

  return `You are reviewing a Solana DLMM liquidity position that another agent has decided to open. Your job is the opposite of theirs: find the strongest reason NOT to open it.

PROPOSED POSITION
${facts}

CANDIDATE DATA THE DECISION WAS BASED ON
${candidateBlock || "(candidate detail unavailable)"}

Argue against this entry. Consider: is the token's holder base healthy, is the fee/TVL edge real or an artefact of thin liquidity, does the range leave the position stranded if price keeps falling, does the narrative rest on anything verifiable, and is the pool's own deploy history a warning.

Then decide. Block only for a concrete, specific danger you can point at in the data above — not for generic memecoin risk, which is priced in. If the data is merely thin or unremarkable, that is a PASS.

Answer in exactly this format, nothing else:
VERDICT: BLOCK or PASS
REASON: one sentence, naming the specific figure or fact that drove it`;
}

/**
 * Parse a reviewer reply into a decision.
 *
 * Unparseable output is a PASS: the model failing to follow a format says
 * nothing about the trade, and treating confusion as danger would let a flaky
 * provider halt deploys.
 *
 * @returns {{block: boolean, reason: string, parsed: boolean}}
 */
export function parseReviewVerdict(text) {
  const body = String(text ?? "");
  const verdict = VERDICT_RE.exec(body);
  if (!verdict) {
    return { block: false, parsed: false, reason: "reviewer returned no VERDICT line" };
  }
  const reasonMatch = REASON_RE.exec(body);
  const reason = reasonMatch ? reasonMatch[1].trim() : "no reason given";
  if (verdict[1].toUpperCase() !== "BLOCK") {
    return { block: false, parsed: true, reason };
  }
  // A BLOCK with no reason is not actionable and reads as a formatting slip
  // rather than a finding, so it does not stop the deploy on its own.
  if (!reasonMatch || reason.length < 12) {
    return { block: false, parsed: true, reason: "reviewer blocked without a usable reason" };
  }
  return { block: true, parsed: true, reason };
}
