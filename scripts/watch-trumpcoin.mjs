#!/usr/bin/env node
/**
 * Tight watch on TrumpCoin LP position(s) — log + alert lines every 3 min.
 * Run: node scripts/watch-trumpcoin.mjs
 */
import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMyPositions } from "../tools/dlmm.js";
import { getTokenInfo } from "../tools/token.js";
import { getWalletPositions } from "../tools/dlmm.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, "../notes/TRUMPCOIN_WATCH.log");
const TRUMP_MINT = "F4GpAFr6vrxU3Y887F3XWkXRgybCVjZNk63m72f6pump";
const OUR_POOLS = new Set([
  "FDB6yZWLVw8NKXjTmoXLjLeaShN4cJxHe4jqati6HvZn",
  "D7UzzvygVMY6st2YwhBHbupRbytecwmAWf8XNyPvctW7",
  "5WSv11XVZPak3LxLRAmhFai1t9HNshZ9cXBiFicqrWUk",
]);
const GACOR_ON_SAME_POOL = { name: "gacor-11", address: "3vVLkF2ta9JxuZPcUfPEEDNLggeCkwexiJZ2TEKmKQGH" };
const INTERVAL_MS = 3 * 60 * 1000;

const stopLoss = Number(config.management?.stopLossPct ?? -12);
const takeProfit = Number(config.management?.takeProfitPct ?? 6);

function append(line, loud = false) {
  const prefix = loud ? ">>> ALERT " : "";
  const row = `[${new Date().toISOString()}] ${prefix}${line}\n`;
  fs.appendFileSync(LOG, row);
  process.stdout.write(row);
}

function binHeadroom(p) {
  if (p.lower_bin == null || p.upper_bin == null || p.active_bin == null) return null;
  const width = p.upper_bin - p.lower_bin;
  if (width <= 0) return null;
  const fromLower = ((p.active_bin - p.lower_bin) / width) * 100;
  return { fromLower: Math.round(fromLower), toUpper: Math.round(100 - fromLower) };
}

async function tick() {
  try {
    const [posRes, tokenRes, gacorRes] = await Promise.all([
      getMyPositions({ force: true }),
      getTokenInfo({ query: TRUMP_MINT }),
      getWalletPositions({ wallet_address: GACOR_ON_SAME_POOL.address }).catch(() => ({ positions: [] })),
    ]);

    const ti = tokenRes?.results?.[0] || tokenRes?.result || tokenRes;
    const pump1h = ti?.stats_1h?.price_change;
    const netBuyers = ti?.stats_1h?.net_buyers;
    const mcap = ti?.mcap;

    const ours = (posRes.positions || []).filter(
      (p) => OUR_POOLS.has(p.pool) || /trump/i.test(p.pair || ""),
    );

    if (ours.length === 0) {
      append(`NO TrumpCoin position open | pump1h=${pump1h ?? "?"}% mcap=$${mcap ?? "?"}`);
      return;
    }

    for (const p of ours) {
      const head = binHeadroom(p);
      const line =
        `${p.pair} ${p.pool.slice(0, 8)} | in_range=${p.in_range} pnl=${p.pnl_pct}%` +
        ` val=$${p.total_value_usd} fees=$${p.unclaimed_fees_usd} fee/tvl=${p.fee_per_tvl_24h}` +
        ` | bin ${p.lower_bin}..${p.upper_bin} active=${p.active_bin}` +
        (head ? ` headroom↑${head.toUpper}% ↓${head.fromLower}%` : "") +
        ` | oor=${p.minutes_out_of_range ?? 0}m age=${p.age_minutes ?? "?"}m` +
        ` | token pump1h=${pump1h ?? "?"}% net_buyers=${netBuyers ?? "?"}`;

      append(line);

      if (!p.in_range) {
        append(`${p.pair} OUT OF RANGE ${p.minutes_out_of_range ?? 0}m — manager should act`, true);
      }
      if (Number(p.pnl_pct) <= stopLoss + 2) {
        append(`${p.pair} PnL ${p.pnl_pct}% near stop-loss floor ${stopLoss}%`, true);
      }
      if (Number(p.pnl_pct) >= takeProfit - 1) {
        append(`${p.pair} PnL ${p.pnl_pct}% near take-profit ${takeProfit}%`, true);
      }
      if (head && head.toUpper < 10) {
        append(`${p.pair} price near TOP of range — pump risk / OOR up`, true);
      }
      if (head && head.fromLower < 10) {
        append(`${p.pair} price near BOTTOM of range — dump / reseed zone`, true);
      }
      if (Number(pump1h) > 15) {
        append(`TrumpCoin 1h pump +${pump1h}% > 15% — entry_gate zone, hati-hati chase`, true);
      }
      if (Number(pump1h) < -20) {
        append(`TrumpCoin 1h dump ${pump1h}% — volatile, watch OOR down`, true);
      }
    }

    const gacorOnTrump = (gacorRes.positions || []).filter((p) => OUR_POOLS.has(p.pool));
    for (const g of gacorOnTrump) {
      append(
        `gacor ref ${GACOR_ON_SAME_POOL.name} pool ${g.pool.slice(0, 8)} in_range=${g.in_range} $${g.total_value_usd} bins ${g.lower_bin}..${g.upper_bin}`,
      );
    }
  } catch (e) {
    append(`ERROR ${e.message}`, true);
  }
}

append("watch-trumpcoin started (interval 3m)");
await tick();
setInterval(tick, INTERVAL_MS);