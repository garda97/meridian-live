/**
 * Stranded-capital ledger (fees-maxi "stranded wallet capital" port, #4 of
 * the review): base tokens left in the wallet after an auto-swap-to-SOL
 * fails (post-close / post-claim dust — the recurring FROGBULL/NYAN failure
 * mode). Before this ledger the value simply vanished from all accounting:
 * the close's pnl_usd was computed assuming full recovery, nothing retried
 * the swap, and the daily-loss kill switch never saw the stuck capital.
 *
 * Entries are recorded at strand time with their USD valuation, retried by
 * the management cycle (executor.retryStrandedSwaps), and marked recovered
 * once a swap lands — the realized-vs-stranded delta is the previously
 * invisible dust-recovery loss. Unrecovered value counts toward the
 * daily-loss gate (conservative: stuck-in-illiquid-memecoin capital is
 * treated as at-risk in full until it is back in SOL).
 *
 * Persisted at repo root as stranded-capital.json:
 *   { entries: [{ mint, symbol, amount, usd_at_strand, label, position,
 *                 pool_name, stranded_at, last_retry_at, recovered_at,
 *                 usd_recovered }] }
 */

import fs from "fs";
import { repoPath } from "./repo-root.js";
import { atomicWriteFileSync } from "./utils/atomic-write.js";
import { log } from "./logger.js";

const STORE = repoPath("stranded-capital.json");
const MAX_ENTRIES = 200;

function load() {
  if (!fs.existsSync(STORE)) return { entries: [] };
  try {
    const data = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!Array.isArray(data.entries)) data.entries = [];
    return data;
  } catch {
    return { entries: [] };
  }
}

function save(data) {
  if (data.entries.length > MAX_ENTRIES) {
    // Keep all unrecovered entries plus the most recent recovered ones.
    const open = data.entries.filter((e) => !e.recovered_at);
    const done = data.entries.filter((e) => e.recovered_at).slice(-(MAX_ENTRIES - open.length));
    data.entries = [...done, ...open];
  }
  atomicWriteFileSync(STORE, JSON.stringify(data, null, 2));
}

function cleanText(v, maxLen = 64) {
  return String(v ?? "").replace(/[<>\n\r]/g, "").slice(0, maxLen) || null;
}

/** Record a failed-to-swap token. Dedupes by mint: an existing unrecovered
 *  entry for the same mint is refreshed (amount/usd updated) instead of
 *  duplicated — repeated failures on the same dust are one stuck lot. */
export function recordStranded({ mint, symbol, amount, usd_at_strand, label, position, pool_name }) {
  if (!mint || !(Number(usd_at_strand) > 0)) return null;
  const data = load();
  const now = new Date().toISOString();
  let entry = data.entries.find((e) => e.mint === mint && !e.recovered_at);
  if (entry) {
    entry.amount = Number(amount) || entry.amount;
    entry.usd_at_strand = Math.max(Number(usd_at_strand), Number(entry.usd_at_strand) || 0);
    entry.last_retry_at = now;
  } else {
    entry = {
      mint,
      symbol: cleanText(symbol, 16),
      amount: Number(amount) || null,
      usd_at_strand: Math.round(Number(usd_at_strand) * 100) / 100,
      label: cleanText(label),
      position: cleanText(position),
      pool_name: cleanText(pool_name),
      stranded_at: now,
      last_retry_at: null,
      recovered_at: null,
      usd_recovered: null,
    };
    data.entries.push(entry);
    log("stranded", `Stranded capital recorded: ${entry.symbol || mint.slice(0, 8)} $${entry.usd_at_strand} (${entry.label || "?"})`);
  }
  save(data);
  return entry;
}

export function markStrandedRetry(mint) {
  const data = load();
  const entry = data.entries.find((e) => e.mint === mint && !e.recovered_at);
  if (!entry) return;
  entry.last_retry_at = new Date().toISOString();
  save(data);
}

/** Mark a stranded lot recovered (swap landed, or balance turned out gone). */
export function markStrandedRecovered(mint, { usd_recovered = null } = {}) {
  const data = load();
  const entry = data.entries.find((e) => e.mint === mint && !e.recovered_at);
  if (!entry) return null;
  entry.recovered_at = new Date().toISOString();
  entry.usd_recovered = usd_recovered != null ? Math.round(Number(usd_recovered) * 100) / 100 : null;
  const delta = entry.usd_recovered != null ? entry.usd_recovered - entry.usd_at_strand : null;
  log("stranded", `Stranded capital recovered: ${entry.symbol || mint.slice(0, 8)} $${entry.usd_recovered ?? "?"} vs stranded $${entry.usd_at_strand}${delta != null ? ` (delta ${delta >= 0 ? "+" : ""}$${Math.round(delta * 100) / 100})` : ""}`);
  save(data);
  return entry;
}

export function getUnrecoveredStranded() {
  return load().entries.filter((e) => !e.recovered_at);
}

/** Total USD stuck in unrecovered stranded tokens (at strand-time valuation). */
export function getUnrecoveredStrandedUsd() {
  const sum = getUnrecoveredStranded().reduce((acc, e) => acc + (Number(e.usd_at_strand) || 0), 0);
  return Math.round(sum * 100) / 100;
}

/** Entries eligible for a retry this cycle (pure — testable). */
export function strandedEntriesDueForRetry(entries, nowMs = Date.now(), cooldownMin = 15) {
  const cooldownMs = Math.max(1, Number(cooldownMin)) * 60_000;
  return (entries || []).filter((e) => {
    if (!e || e.recovered_at) return false;
    const last = e.last_retry_at ? Date.parse(e.last_retry_at) : Date.parse(e.stranded_at);
    return !Number.isFinite(last) || nowMs - last >= cooldownMs;
  });
}
