/**
 * Auto-relax screening thresholds when consecutive cycles produce no deploy.
 * Complements evolveThresholds() in lessons.js (which learns from closed positions).
 */

import fs from "fs";
import { log } from "./logger.js";
import { reloadScreeningThresholds } from "./config.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe } from "./screening-scales.js";
import { repoPath } from "./repo-root.js";
import { atomicWriteFileSync } from "./utils/atomic-write.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const STATE_PATH = repoPath("filter-autotune-state.json");

const DEFAULT_CONSECUTIVE_THRESHOLD = 2;
const DEFAULT_MAX_RELAXATIONS = 8;
const RELAX_FACTOR = 0.85;

// Quality bar keys are owned by evolveThresholds() — never auto-relax them.
const EVOLVE_OWNED_KEYS = new Set(["minOrganic", "minQuoteOrganic", "minFeeActiveTvlRatio"]);

// Floors sit at the profit-preset line (mcap $250K, holders 300) so a dry
// spell can't erode the preset back to learning-phase looseness. By 2026-07-03
// autotune had already walked minVolume 15000→5658 and minMcap 250K→150K live.
const STATIC_FLOORS = {
  minMcap: 250_000,
  minHolders: 300,
  minTokenFeesSolPer100kMcap: 6,
  minTokenFeesSol: 30, // Evil Panda hard floor — <30 SOL total fees = bundled/scam signal
};

/** Floors scale with screening timeframe — minVolume floor is the full scaled default (1h = 10000), not half. */
export function getFloorsForConfig(userConfig = {}) {
  const tf = normalizeTimeframe(userConfig.timeframe);
  const scaled = getScreeningDefaultsForTimeframe(tf);
  return {
    ...STATIC_FLOORS,
    minVolume: Math.max(250, Math.round(scaled.minVolume)),
  };
}

function getRelaxKeys(floors) {
  return Object.keys(floors).filter((key) => !EVOLVE_OWNED_KEYS.has(key));
}

const DEFAULT_STATE = {
  consecutiveNoDeploy: 0,
  totalRelaxations: 0,
  lastRelaxAt: null,
  lastRelaxChanges: null,
  warnedAtMax: false,
  warnedAtFloor: false,
};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  atomicWriteFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function isAutotuneEnabled(userConfig) {
  return userConfig.filterAutotuneEnabled !== false;
}

function getConsecutiveThreshold(userConfig) {
  const n = Number(userConfig.filterAutotuneAfterCycles);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_CONSECUTIVE_THRESHOLD;
}

function getMaxRelaxations(userConfig) {
  const n = Number(userConfig.filterAutotuneMaxSteps);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_MAX_RELAXATIONS;
}

function roundKey(key, value) {
  if (key === "minFeeActiveTvlRatio") return Number(value.toFixed(3));
  if (key === "minVolume" || key === "minMcap" || key === "minHolders") return Math.round(value);
  if (key === "minOrganic" || key === "minQuoteOrganic") return Math.round(value);
  return Math.round(value);
}

/**
 * Compute one relaxation step from current user-config values.
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function computeRelaxation(userConfig) {
  const floors = getFloorsForConfig(userConfig);
  const changes = {};
  const rationale = {};

  for (const key of getRelaxKeys(floors)) {
    const current = Number(userConfig[key]);
    const floor = floors[key];
    if (!Number.isFinite(current)) continue;
    if (current <= floor) continue;

    let next;
    if (key === "minOrganic" || key === "minQuoteOrganic" || key === "minTokenFeesSolPer100kMcap" || key === "minTokenFeesSol") {
      next = current - (key.startsWith("minTokenFees") ? 1 : 5);
    } else {
      next = current * RELAX_FACTOR;
    }
    next = roundKey(key, Math.max(floor, next));
    if (next >= current) continue;

    changes[key] = next;
    rationale[key] = `${current} → ${next} (floor ${floor})`;
  }

  if (Object.keys(changes).length === 0) return null;
  return { changes, rationale };
}

function applyChangesToUserConfig(userConfig, changes) {
  Object.assign(userConfig, changes);
  userConfig._lastFilterRelaxed = new Date().toISOString();
  userConfig._filterRelaxCount = (userConfig._filterRelaxCount ?? 0) + 1;
  atomicWriteFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  reloadScreeningThresholds();
}

/**
 * Record screening cycle outcome and relax filters if streak threshold is hit.
 * @param {{ executed: boolean, deployed: boolean, skipped: boolean }} outcome
 * @param {Object} liveConfig - config object (unused but kept for API symmetry)
 * @returns {{ relaxed: boolean, changes?: Object, streak: number } | null}
 */
export function recordScreeningOutcome(outcome, liveConfig = null) {
  void liveConfig;
  const userConfig = loadUserConfig();
  if (!isAutotuneEnabled(userConfig)) return null;

  const state = loadState();

  if (outcome.skipped || !outcome.executed) {
    return { relaxed: false, streak: state.consecutiveNoDeploy, skipped: true };
  }

  if (outcome.deployed) {
    if (state.consecutiveNoDeploy > 0 || state.warnedAtMax || state.warnedAtFloor) {
      state.consecutiveNoDeploy = 0;
      state.warnedAtMax = false;
      state.warnedAtFloor = false;
      saveState(state);
      log("config", "Filter autotune: streak reset after successful deploy");
    }
    return { relaxed: false, streak: 0, deployed: true };
  }

  state.consecutiveNoDeploy += 1;
  const threshold = getConsecutiveThreshold(userConfig);
  const maxSteps = getMaxRelaxations(userConfig);
  const relaxCount = userConfig._filterRelaxCount ?? 0;

  if (state.consecutiveNoDeploy < threshold) {
    saveState(state);
    log("config", `Filter autotune: no-deploy streak ${state.consecutiveNoDeploy}/${threshold}`);
    return { relaxed: false, streak: state.consecutiveNoDeploy };
  }

  if (relaxCount >= maxSteps) {
    // Profit lock: hold thresholds, warn once (not every cycle), and stop
    // growing a dead streak counter — resuming needs an owner decision.
    state.consecutiveNoDeploy = Math.min(state.consecutiveNoDeploy, threshold);
    if (!state.warnedAtMax) {
      state.warnedAtMax = true;
      log("warn", `Filter autotune: max relaxation steps (${maxSteps}) reached — thresholds LOCKED at current values. To resume: raise filterAutotuneMaxSteps or reset _filterRelaxCount in user-config (owner decision).`);
    }
    saveState(state);
    return { relaxed: false, streak: state.consecutiveNoDeploy, atMax: true };
  }

  const result = computeRelaxation(userConfig);
  if (!result) {
    state.consecutiveNoDeploy = Math.min(state.consecutiveNoDeploy, threshold);
    if (!state.warnedAtFloor) {
      state.warnedAtFloor = true;
      log("warn", "Filter autotune: all thresholds at floor — LOCKED, cannot relax further. Floors are the profit-preset line; loosening them is an owner decision.");
    }
    saveState(state);
    return { relaxed: false, streak: state.consecutiveNoDeploy, atFloor: true };
  }

  applyChangesToUserConfig(userConfig, result.changes);
  state.consecutiveNoDeploy = 0;
  state.warnedAtMax = false;
  state.warnedAtFloor = false;
  state.totalRelaxations += 1;
  state.lastRelaxAt = new Date().toISOString();
  state.lastRelaxChanges = result.changes;
  saveState(state);

  const summary = Object.entries(result.changes).map(([k, v]) => `${k}=${v}`).join(", ");
  log("config", `Filter autotune: relaxed thresholds after ${threshold} no-deploy cycles — ${summary}`);
  log("config", Object.values(result.rationale).join("; "));

  return { relaxed: true, changes: result.changes, streak: 0, rationale: result.rationale };
}

export function getAutotuneStatus() {
  const userConfig = loadUserConfig();
  const state = loadState();
  return {
    enabled: isAutotuneEnabled(userConfig),
    consecutiveNoDeploy: state.consecutiveNoDeploy,
    threshold: getConsecutiveThreshold(userConfig),
    totalRelaxations: state.totalRelaxations,
    relaxCount: userConfig._filterRelaxCount ?? 0,
    maxSteps: getMaxRelaxations(userConfig),
    lastRelaxAt: state.lastRelaxAt,
    lastRelaxChanges: state.lastRelaxChanges,
    timeframe: userConfig.timeframe ?? null,
    floors: getFloorsForConfig(userConfig),
    current: Object.keys(getFloorsForConfig(userConfig)).reduce((acc, key) => {
      if (userConfig[key] != null) acc[key] = userConfig[key];
      return acc;
    }, {}),
  };
}