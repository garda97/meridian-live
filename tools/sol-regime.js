import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { config } from "../config.js";

const SNAPSHOT_FILE = repoPath("sol-regime-snapshots.json");
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 3 * ONE_HOUR_MS;

function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    return Array.isArray(data?.snapshots) ? data.snapshots : [];
  } catch {
    return [];
  }
}

function saveSnapshots(snapshots) {
  const pruned = snapshots
    .filter((s) => s?.price > 0 && s?.ts > 0)
    .sort((a, b) => a.ts - b.ts)
    .slice(-500);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ snapshots: pruned }, null, 2));
}

/**
 * Pure function — testable SOL 1h change gate.
 * @param {Array<{ts:number, price:number}>} snapshots
 * @param {number} currentPrice
 * @param {number} thresholdPct e.g. -3 blocks when 1h change <= -3%
 * @param {number} [nowMs]
 */
export function evaluateSolRegimeFromSnapshots(
  snapshots,
  currentPrice,
  thresholdPct,
  nowMs = Date.now(),
) {
  if (!(currentPrice > 0)) {
    return { blocked: false, reason: "no_price", changePct: null };
  }
  const eligible = (snapshots || []).filter((s) => s.price > 0 && s.ts <= nowMs);
  const targetTs = nowMs - ONE_HOUR_MS;
  const past = eligible
    .filter((s) => s.ts <= targetTs)
    .sort((a, b) => b.ts - a.ts)[0];
  if (!past) {
    return { blocked: false, reason: "insufficient_history", changePct: null };
  }
  const changePct = ((currentPrice - past.price) / past.price) * 100;
  const blocked = changePct <= thresholdPct;
  return {
    blocked,
    reason: blocked ? "sol_regime_gate" : "ok",
    changePct: Math.round(changePct * 100) / 100,
    pastPrice: past.price,
    pastTs: past.ts,
    currentPrice,
    thresholdPct,
  };
}

/**
 * Record snapshot and evaluate gate for screening cycle.
 * Uses wallet balance SOL price — no extra API call when caller passes it.
 */
export function checkSolRegimeGate(solPriceUsd, opts = {}) {
  const enabled = opts.enabled ?? config.screening?.solRegimeGateEnabled ?? false;
  const thresholdPct = Number(opts.thresholdPct ?? config.screening?.solDump1hPctThreshold ?? -3);
  const nowMs = opts.nowMs ?? Date.now();
  const price = Number(solPriceUsd);

  const snapshots = loadSnapshots();
  if (price > 0) {
    snapshots.push({ ts: nowMs, price });
    const pruned = snapshots.filter((s) => nowMs - s.ts <= MAX_AGE_MS);
    saveSnapshots(pruned);
  }

  if (!enabled) {
    return { blocked: false, reason: "disabled", changePct: null };
  }

  const result = evaluateSolRegimeFromSnapshots(snapshots, price, thresholdPct, nowMs);
  if (result.blocked) {
    log(
      "screening",
      `SOL regime gate: 1h change ${result.changePct}% <= ${thresholdPct}% — skip deploy this cycle`,
    );
  }
  return result;
}