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
  assert(r1.changes.minVolume >= 300_000, "minVolume should respect floor");
  assert(r1.changes.minOrganic < strict.minOrganic, "minOrganic should drop");

  const floors1h = getFloorsForConfig({ timeframe: "1h" });
  assert(floors1h.minVolume === 5000, `1h minVolume floor should be 5000, got ${floors1h.minVolume}`);
  const floors5m = getFloorsForConfig({ timeframe: "5m" });
  assert(floors5m.minVolume === 250, `5m minVolume floor should be 250, got ${floors5m.minVolume}`);

  const atFloor = { timeframe: "1h", ...strict, minVolume: floors1h.minVolume, minMcap: 150_000, minOrganic: 45, minQuoteOrganic: 45, minHolders: 200, minFeeActiveTvlRatio: floors1h.minFeeActiveTvlRatio, minTokenFeesSolPer100kMcap: 6, minTokenFeesSol: 5 };
  const r2 = computeRelaxation(atFloor);
  assert(r2 === null, "at-floor config should not relax further");

  console.log("test-filter-autotune: OK");
  console.log("  1h floors:", JSON.stringify(floors1h));
  console.log("  sample relax:", JSON.stringify(r1.changes));
}

main();