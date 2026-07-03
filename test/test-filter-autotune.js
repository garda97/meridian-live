/**
 * Unit tests for filter-autotune (no network).
 * Run: node test/test-filter-autotune.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { computeRelaxation, getFloorsForConfig } from "../filter-autotune.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const STATE_PATH = repoPath("filter-autotune-state.json");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function backup(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
}

function restore(path, data) {
  if (data == null) {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } else {
    fs.writeFileSync(path, data);
  }
}

function main() {
  const strict = {
    minVolume: 800_000,
    minMcap: 250_000,
    minOrganic: 60,
    minQuoteOrganic: 60,
    minHolders: 380,
    minFeeActiveTvlRatio: 0.015,
    minTokenFeesSolPer100kMcap: 12,
    minTokenFeesSol: 10,
  };

  const r1 = computeRelaxation(strict);
  assert(r1, "should produce relaxation for strict config");
  assert(r1.changes.minVolume < strict.minVolume, "minVolume should drop");
  assert(!("minOrganic" in r1.changes), "minOrganic is evolve-owned — must not relax");
  assert(!("minFeeActiveTvlRatio" in r1.changes), "minFeeActiveTvlRatio is evolve-owned — must not relax");
  assert(!("minMcap" in r1.changes), "minMcap already at profit-preset floor 250K — must not relax");

  // Floors sit at the profit-preset line: full scaled minVolume, mcap 250K, holders 300
  const floors1h = getFloorsForConfig({ timeframe: "1h" });
  assert(floors1h.minVolume === 10_000, `1h minVolume floor should be 10000, got ${floors1h.minVolume}`);
  assert(floors1h.minMcap === 250_000, `minMcap floor should be 250000, got ${floors1h.minMcap}`);
  assert(floors1h.minHolders === 300, `minHolders floor should be 300, got ${floors1h.minHolders}`);
  const floors5m = getFloorsForConfig({ timeframe: "5m" });
  assert(floors5m.minVolume === 500, `5m minVolume floor should be 500, got ${floors5m.minVolume}`);

  // Profit-preset erosion scenario: values at/below the new floors must not relax further
  const atFloor = { timeframe: "1h", ...strict, minVolume: floors1h.minVolume, minMcap: 250_000, minOrganic: 45, minQuoteOrganic: 45, minHolders: 300, minFeeActiveTvlRatio: 0.04, minTokenFeesSolPer100kMcap: 6, minTokenFeesSol: 5 };
  const r2 = computeRelaxation(atFloor);
  assert(r2 === null, "at-floor config should not relax further");

  // Already-eroded live values (below new floors) must never be relaxed deeper
  const eroded = { timeframe: "1h", minVolume: 5658, minMcap: 150_000, minHolders: 200, minTokenFeesSolPer100kMcap: 6, minTokenFeesSol: 5 };
  const r3 = computeRelaxation(eroded);
  assert(r3 === null, `already-eroded config must not relax deeper, got ${JSON.stringify(r3?.changes)}`);

  console.log("test-filter-autotune: OK");
  console.log("  1h floors:", JSON.stringify(floors1h));
  console.log("  sample relax:", JSON.stringify(r1.changes));
}

main();