/**
 * Holder-quality gate for deploy_position.
 *
 * These three rules used to run in the screening fan-out, over every candidate
 * that survived the cheap filters. The GMGN holders quota is small, so a fan-out
 * that wide consumed it on pools that mostly never got deployed into. Each rule
 * is guarded by `!= null`, so once the quota was gone they stopped applying
 * rather than blocking.
 *
 * Running the same rules at the deploy decision spends the scarce quota on
 * pools the agent actually intends to enter.
 *
 * Ratios come from computeHolderRatios rather than a local copy:
 * bundled_wallet_holder_pct is derived from `bundlers_in_top_100`, not from any
 * `bundled_*` field, and a drifting duplicate would silently never fire.
 */
import { computeHolderRatios } from "../tools/gmgn.js";

/**
 * @returns {{pass: boolean, checked: boolean, reason: string}}
 *   checked=false means no holder data was available (budget exhausted, no API
 *   key, or lookup failure). The gate passes then — the same fail-open
 *   behaviour screening already had — but callers should log it, because a pass
 *   without data is not the same as a pass on data.
 */
export function checkHolderQuality(stats, holderCount, cfg = {}) {
  if (!stats) {
    return { pass: true, checked: false, reason: "no GMGN holder data available" };
  }

  const { maxBundlerTop100Pct, maxFreshWalletHolderPct, maxBundledWalletHolderPct } = cfg;

  const bundlerPct = num(stats.bundlers_pct_in_top_100);
  if (bundlerPct != null && maxBundlerTop100Pct != null && bundlerPct > maxBundlerTop100Pct) {
    return {
      pass: false,
      checked: true,
      reason: `GMGN bundlers ${bundlerPct}% of top-100 supply exceeds max ${maxBundlerTop100Pct}%`,
    };
  }

  const ratios = computeHolderRatios(stats, holderCount);

  if (
    ratios.fresh_wallet_holder_pct != null
    && maxFreshWalletHolderPct != null
    && ratios.fresh_wallet_holder_pct > maxFreshWalletHolderPct
  ) {
    return {
      pass: false,
      checked: true,
      reason: `GMGN fresh wallets ${ratios.fresh_wallet_holder_pct}% of holders exceeds max ${maxFreshWalletHolderPct}%`,
    };
  }

  if (
    ratios.bundled_wallet_holder_pct != null
    && maxBundledWalletHolderPct != null
    && ratios.bundled_wallet_holder_pct > maxBundledWalletHolderPct
  ) {
    return {
      pass: false,
      checked: true,
      reason: `GMGN bundled wallets ${ratios.bundled_wallet_holder_pct}% of holders exceeds max ${maxBundledWalletHolderPct}%`,
    };
  }

  return { pass: true, checked: true, reason: "holder quality within limits" };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
