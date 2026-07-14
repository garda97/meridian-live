import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { config } from "../config.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";

const SNAPSHOT_FILE = repoPath("sol-regime-snapshots.json");
const BTC_SNAPSHOT_FILE = repoPath("btc-regime-snapshots.json");
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 3 * ONE_HOUR_MS;
// Reject single-tick price spikes (bad Helius/Jupiter reads) from poisoning 1h lookback.
const OUTLIER_MAX_JUMP_PCT = 12;
const OUTLIER_LOOKBACK_MS = 20 * 60 * 1000;

function medianPrice(snapshots) {
  const prices = snapshots.map((s) => s.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

function pruneOutlierSnapshots(snapshots) {
  const med = medianPrice(snapshots);
  if (!(med > 0)) return snapshots;
  const kept = snapshots.filter((s) => {
    const dev = (Math.abs(s.price - med) / med) * 100;
    if (dev > OUTLIER_MAX_JUMP_PCT * 2) {
      log("screening", `SOL regime: pruned outlier snapshot $${s.price} (${dev.toFixed(1)}% off median $${med})`);
      return false;
    }
    return true;
  });
  return kept.length ? kept : snapshots;
}

function shouldRecordSnapshot(snapshots, price, nowMs) {
  const recent = snapshots
    .filter((s) => s.price > 0 && nowMs - s.ts <= OUTLIER_LOOKBACK_MS)
    .sort((a, b) => b.ts - a.ts)[0];
  if (!recent) return true;
  const jumpPct = (Math.abs(price - recent.price) / recent.price) * 100;
  if (jumpPct > OUTLIER_MAX_JUMP_PCT) {
    log(
      "screening",
      `SOL regime: ignored outlier tick $${price} (${jumpPct.toFixed(1)}% jump from $${recent.price} ${Math.round((nowMs - recent.ts) / 1000)}s ago)`,
    );
    return false;
  }
  return true;
}

function loadSnapshotsFrom(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data?.snapshots) ? data.snapshots : [];
  } catch {
    return [];
  }
}

function saveSnapshotsTo(file, snapshots) {
  const pruned = snapshots
    .filter((s) => s?.price > 0 && s?.ts > 0)
    .sort((a, b) => a.ts - b.ts)
    .slice(-500);
  atomicWriteFileSync(file, JSON.stringify({ snapshots: pruned }, null, 2));
}

const loadSnapshots = () => loadSnapshotsFrom(SNAPSHOT_FILE);
const saveSnapshots = (snapshots) => saveSnapshotsTo(SNAPSHOT_FILE, snapshots);
const loadBtcSnapshots = () => loadSnapshotsFrom(BTC_SNAPSHOT_FILE);
const saveBtcSnapshots = (snapshots) => saveSnapshotsTo(BTC_SNAPSHOT_FILE, snapshots);

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
 * Pure — 1h % change for an arbitrary snapshot series (same "closest snapshot
 * at least 1h old" logic as evaluateSolRegimeFromSnapshots, factored out so
 * BTC can reuse it without duplicating the lookup).
 */
export function computeChangePctFromSnapshots(snapshots, currentPrice, nowMs = Date.now()) {
  if (!(currentPrice > 0)) return null;
  const eligible = (snapshots || []).filter((s) => s.price > 0 && s.ts <= nowMs);
  const targetTs = nowMs - ONE_HOUR_MS;
  const past = eligible.filter((s) => s.ts <= targetTs).sort((a, b) => b.ts - a.ts)[0];
  if (!past) return null;
  const changePct = ((currentPrice - past.price) / past.price) * 100;
  return { changePct: Math.round(changePct * 100) / 100, pastPrice: past.price, pastTs: past.ts };
}

/**
 * Pure — LP Army "Deep Winter" doctrine: SOL dumping less than BTC over the
 * same window is relative strength, not confirmed weakness.
 * @param {number} solChangePct
 * @param {number} btcChangePct
 * @param {number} minOutperformPct SOL must beat BTC by at least this many points
 */
export function evaluateRelativeStrength(solChangePct, btcChangePct, minOutperformPct) {
  if (!Number.isFinite(solChangePct) || !Number.isFinite(btcChangePct)) {
    return { isRelativelyStrong: false, relativeStrengthPct: null };
  }
  const relativeStrengthPct = Math.round((solChangePct - btcChangePct) * 100) / 100;
  return { isRelativelyStrong: relativeStrengthPct >= minOutperformPct, relativeStrengthPct };
}

/**
 * Record snapshot and evaluate gate for screening cycle.
 * Uses wallet balance SOL price — no extra API call when caller passes it.
 *
 * Optional relative-strength softening (opt-in, config.screening.solRelativeStrengthEnabled):
 * pass btcPriceUsd to soften the block threshold when SOL is outperforming BTC over the same
 * 1h window (LP Army "Deep Winter" doctrine — relative strength signals a forming floor).
 * Missing/stale BTC price fails open to the plain SOL-only gate, same as insufficient history.
 */
export function checkSolRegimeGate(solPriceUsd, opts = {}) {
  const enabled = opts.enabled ?? config.screening?.solRegimeGateEnabled ?? false;
  const thresholdPct = Number(opts.thresholdPct ?? config.screening?.solDump1hPctThreshold ?? -3);
  const nowMs = opts.nowMs ?? Date.now();
  const price = Number(solPriceUsd);

  let snapshots = pruneOutlierSnapshots(loadSnapshots());
  if (price > 0 && shouldRecordSnapshot(snapshots, price, nowMs)) {
    snapshots.push({ ts: nowMs, price });
    const pruned = pruneOutlierSnapshots(snapshots.filter((s) => nowMs - s.ts <= MAX_AGE_MS));
    saveSnapshots(pruned);
    snapshots = pruned;
  }

  const rsEnabled = opts.relativeStrengthEnabled ?? config.screening?.solRelativeStrengthEnabled ?? false;
  const btcPrice = Number(opts.btcPriceUsd);
  let btcSnapshots = null;
  if (rsEnabled) {
    btcSnapshots = loadBtcSnapshots();
    if (btcPrice > 0) {
      btcSnapshots.push({ ts: nowMs, price: btcPrice });
      const prunedBtc = btcSnapshots.filter((s) => nowMs - s.ts <= MAX_AGE_MS);
      saveBtcSnapshots(prunedBtc);
    }
  }

  if (!enabled) {
    return { blocked: false, reason: "disabled", changePct: null };
  }

  let effectiveThresholdPct = thresholdPct;
  let relativeStrength = null;
  if (rsEnabled && btcSnapshots) {
    const solChange = computeChangePctFromSnapshots(snapshots, price, nowMs);
    const btcChange = computeChangePctFromSnapshots(btcSnapshots, btcPrice, nowMs);
    if (solChange && btcChange) {
      const minOutperformPct = Number(
        opts.relativeStrengthMinOutperformPct ?? config.screening?.solRelativeStrengthMinOutperformPct ?? 3,
      );
      relativeStrength = evaluateRelativeStrength(solChange.changePct, btcChange.changePct, minOutperformPct);
      if (relativeStrength.isRelativelyStrong) {
        const softenPct = Number(
          opts.relativeStrengthSoftenPct ?? config.screening?.solRelativeStrengthSoftenPct ?? 2,
        );
        effectiveThresholdPct = thresholdPct - softenPct;
      }
    }
  }

  const result = evaluateSolRegimeFromSnapshots(snapshots, price, effectiveThresholdPct, nowMs);
  if (relativeStrength) result.relativeStrength = relativeStrength;
  if (result.blocked) {
    const rsNote = relativeStrength?.isRelativelyStrong
      ? ` (relative-strength softened threshold to ${effectiveThresholdPct}%, still blocked)`
      : "";
    log(
      "screening",
      `SOL regime gate: 1h change ${result.changePct}% <= ${effectiveThresholdPct}%${rsNote} — skip deploy this cycle`,
    );
  }
  return result;
}