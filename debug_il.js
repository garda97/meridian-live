/**
 * Manual diagnostic: theoretical impermanent loss vs real PnL for open
 * positions right now. Read-only — no deploys, no closes, no config writes.
 * Run: node debug_il.js
 *
 * pnl_pct (from pnl.js) is REAL PnL: price move + fees claimed + fees
 * unclaimed, all net of cost basis. il_pct here is the PRICE-ONLY component
 * (entry range vs current price, ignoring fees). The gap between the two is
 * roughly "how much fee income is offsetting the IL" — useful to see whether
 * a losing position lost because of range breakage (IL) or because fees
 * never caught up.
 *
 * Formula ported from CLMM-Liquidity-Provider (Rust) — see utils/impermanent-loss.js.
 */
import "./envcrypt.js"; // decrypts .env into process.env (same as index.js) — must be first
import { getMyPositions } from "./tools/dlmm.js";
import { getTrackedPosition } from "./state.js";
import { calculateIlConcentrated } from "./utils/impermanent-loss.js";

let _getPriceOfBinByBinId = null;
async function binPrice(binId, binStep) {
  if (_getPriceOfBinByBinId == null) {
    const mod = await import("@meteora-ag/dlmm");
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
  }
  return Number(_getPriceOfBinByBinId(binId, binStep).toString());
}

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

async function main() {
  const result = await getMyPositions({ silent: true });
  if (result.error) {
    console.error(`getMyPositions failed: ${result.error}`);
    process.exit(1);
  }
  if (!result.positions.length) {
    console.log("No open positions.");
    return;
  }

  console.log(pad("POOL", 22), pad("STRATEGY", 10), pad("PNL%", 8), pad("IL%", 8), pad("GAP%", 8), "NOTE");
  console.log("-".repeat(70));

  for (const pos of result.positions) {
    const tracked = getTrackedPosition(pos.position);
    const binStep = tracked?.bin_step;
    const entryBin = tracked?.active_bin_at_deploy;
    const strategy = tracked?.strategy || "?";

    if (binStep == null || entryBin == null || pos.lower_bin == null || pos.upper_bin == null || pos.active_bin == null) {
      console.log(pad(pos.pair, 22), pad(strategy, 10), pad(pos.pnl_pct ?? "?", 8), pad("n/a", 8), pad("n/a", 8), "missing bin data — skip");
      continue;
    }

    const [entryPrice, currentPrice, priceLower, priceUpper] = await Promise.all([
      binPrice(entryBin, binStep),
      binPrice(pos.active_bin, binStep),
      binPrice(pos.lower_bin, binStep),
      binPrice(pos.upper_bin, binStep),
    ]);

    const il = calculateIlConcentrated(entryPrice, currentPrice, priceLower, priceUpper);
    if (il == null) {
      console.log(pad(pos.pair, 22), pad(strategy, 10), pad(pos.pnl_pct ?? "?", 8), pad("n/a", 8), pad("n/a", 8), "IL calc failed (bad range)");
      continue;
    }

    const ilPct = il * 100;
    const pnlPct = Number(pos.pnl_pct ?? 0);
    const gap = pnlPct - ilPct;

    console.log(
      pad(pos.pair, 22),
      pad(strategy, 10),
      pad(pnlPct.toFixed(2), 8),
      pad(ilPct.toFixed(2), 8),
      pad(gap.toFixed(2), 8),
      pos.in_range ? "" : "OUT OF RANGE",
    );
  }
}

main().catch((e) => {
  console.error("debug_il failed:", e.message);
  process.exit(1);
});
