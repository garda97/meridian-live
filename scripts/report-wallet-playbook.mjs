#!/usr/bin/env node
/**
 * Human-readable report of gacor wallet strategy patterns by coin regime.
 * Usage: node scripts/report-wallet-playbook.mjs [--json]
 */
import "../envcrypt.js";
import { getPlaybookSummary } from "../utils/wallet-playbook.js";

const asJson = process.argv.includes("--json");
const summary = getPlaybookSummary();

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`=== Gacor Wallet Playbook @ ${summary.updated_at || "never"} ===`);
console.log(`Open positions tracked: ${summary.open_positions}`);
console.log("");

if (summary.wallets.length === 0) {
  console.log("No data yet — watcher will log opens/closes automatically.");
  process.exit(0);
}

for (const w of summary.wallets) {
  console.log(`── ${w.wallet} (opens: ${w.total_opens}, closes: ${w.total_closes}, dominant: ${w.dominant_strategy || "?"})`);
  if (w.regimes.length === 0) {
    console.log("   (no regime data)");
    continue;
  }
  for (const r of w.regimes) {
    const styles = Object.entries(r.range_styles || {}).map(([k, v]) => `${k}:${v}`).join(", ");
    console.log(
      `   ${r.regime} → ${r.dominant_strategy || "?"} (${r.opens}x)` +
        (r.avg_width_bins != null ? `, ~${r.avg_width_bins} bins` : "") +
        (styles ? `, range[${styles}]` : "") +
        (r.win_rate != null ? `, win=${(r.win_rate * 100).toFixed(0)}%` : ""),
    );
  }
  console.log("");
}

if (summary.recent_events.length > 0) {
  console.log("Recent events:");
  for (const e of summary.recent_events) {
    const tag = e.event_type.toUpperCase();
    const name = e.pool_name || e.pool_address?.slice(0, 8) || "?";
    if (e.event_type === "close") {
      console.log(`  [${tag}] ${e.wallet_name} ${name} PnL=${e.outcome?.pnl_pct ?? "?"}%`);
    } else {
      console.log(
        `  [${tag}] ${e.wallet_name} ${name} → ${e.strategy?.inferred_strategy} (${e.conditions?.regime_label})`,
      );
    }
  }
}