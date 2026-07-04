/**
 * Unit tests for the TVL dilution exit (Gap 3 — pure, no network).
 * Run: node test/test-tvl-dilution.js
 */

import { computeTvlDilution, checkTvlDilutionExit } from "../tools/position-router.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── computeTvlDilution ─────────────────────────────────────────
// $40 position in a $100k pool that grew from $20k → share 0.04%, growth 5x
let d = computeTvlDilution({ positionValueUsd: 40, poolTvlUsd: 100_000, entryTvlUsd: 20_000 });
assert(d.position_share_pct === 0.04, `share expected 0.04, got ${d.position_share_pct}`);
assert(d.tvl_growth_x === 5, `growth expected 5, got ${d.tvl_growth_x}`);

// Healthy share: $4000 in $20k pool → 20%
d = computeTvlDilution({ positionValueUsd: 4000, poolTvlUsd: 20_000, entryTvlUsd: 20_000 });
assert(d.position_share_pct === 20 && d.tvl_growth_x === 1, "healthy case wrong");

// Missing inputs → nulls
d = computeTvlDilution({ positionValueUsd: null, poolTvlUsd: 100_000, entryTvlUsd: 20_000 });
assert(d.position_share_pct === null, "missing value must null share");
d = computeTvlDilution({ positionValueUsd: 40, poolTvlUsd: 0, entryTvlUsd: 20_000 });
assert(d.position_share_pct === null && d.tvl_growth_x === null, "zero TVL must null both");
d = computeTvlDilution({ positionValueUsd: 40, poolTvlUsd: 100_000, entryTvlUsd: null });
assert(d.position_share_pct === 0.04 && d.tvl_growth_x === null, "missing entry TVL must null growth only");

// ── checkTvlDilutionExit — 3-condition rule ───────────────────
const MGMT = { shareExitEnabled: true, shareExitMinPct: 2, shareExitTvlGrowthMin: 3, minFeePerTvl24h: 7 };
const diluted = { position_share_pct: 0.5, tvl_growth_x: 5 };
const lowYield = { fee_per_tvl_24h: 3 };
const goodYield = { fee_per_tvl_24h: 12 };

// All three conditions met → exit
let r = checkTvlDilutionExit(diluted, lowYield, MGMT);
assert(r?.action === "TVL_DILUTION", "all-three case must exit");
assert(r.reason.includes("TVL dilution"), "reason must be classifiable");

// Disabled → never fires
assert(checkTvlDilutionExit(diluted, lowYield, { ...MGMT, shareExitEnabled: false }) === null, "disabled must not fire");

// Share collapsed but yield still good → hold (pool is hot, fees still flow)
assert(checkTvlDilutionExit(diluted, goodYield, MGMT) === null, "good yield must hold");

// Share collapsed + low yield but TVL didn't explode (small from the start) → hold
assert(checkTvlDilutionExit({ position_share_pct: 0.5, tvl_growth_x: 1.2 }, lowYield, MGMT) === null, "no TVL explosion must hold");

// Share still healthy → hold even with growth + low yield (low-yield rule owns it)
assert(checkTvlDilutionExit({ position_share_pct: 5, tvl_growth_x: 5 }, lowYield, MGMT) === null, "healthy share must hold");

// Missing data → hold (fail-open to other rules)
assert(checkTvlDilutionExit({ position_share_pct: null, tvl_growth_x: 5 }, lowYield, MGMT) === null, "null share must hold");
assert(checkTvlDilutionExit(null, lowYield, MGMT) === null, "null dilution must hold");

// Suspicious PnL tick → hold
assert(checkTvlDilutionExit(diluted, { ...lowYield, pnl_pct_suspicious: true }, MGMT) === null, "suspicious tick must hold");

// Boundary: exactly at thresholds must NOT fire (strict < / >)
assert(checkTvlDilutionExit({ position_share_pct: 2, tvl_growth_x: 5 }, lowYield, MGMT) === null, "share == min must hold");
assert(checkTvlDilutionExit({ position_share_pct: 0.5, tvl_growth_x: 3 }, lowYield, MGMT) === null, "growth == min must hold");
assert(checkTvlDilutionExit(diluted, { fee_per_tvl_24h: 7 }, MGMT) === null, "yield == floor must hold");

console.log("  tvl-dilution: math, 3-condition AND, disabled/boundary/missing-data holds OK");
console.log("test-tvl-dilution: OK");
