#!/usr/bin/env node
/**
 * Apply a Meridian config preset (partial overrides) onto user-config.json.
 *
 * Usage:
 *   node scripts/apply-preset.js evil-panda.strict          # apply + backup
 *   node scripts/apply-preset.js evil-panda.strict --dry-run
 *   node scripts/apply-preset.js --list
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { reloadScreeningThresholds } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const USER_CONFIG_PATH = path.join(ROOT, "user-config.json");
const PRESETS_DIR = path.join(ROOT, "presets");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (isPlainObject(val) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function flattenForDiff(obj, prefix = "") {
  const rows = [];
  for (const [key, val] of Object.entries(obj)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) {
      rows.push(...flattenForDiff(val, pathKey));
    } else {
      rows.push([pathKey, val]);
    }
  }
  return rows;
}

function formatVal(v) {
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

function listPresets() {
  if (!fs.existsSync(PRESETS_DIR)) die(`Presets dir missing: ${PRESETS_DIR}`);
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) die("No presets found.");
  console.log("Available presets:\n");
  for (const file of files) {
    const preset = loadJson(path.join(PRESETS_DIR, file));
    const meta = preset._meta || {};
    console.log(`  ${path.basename(file, ".json")}`);
    console.log(`    ${meta.label || meta.name || file}`);
    if (meta.description) console.log(`    ${meta.description}`);
    if (meta.requires_min_wallet_sol != null) {
      console.log(`    min wallet: ~${meta.requires_min_wallet_sol} SOL per deploy slot`);
    }
    console.log("");
  }
}

function resolvePresetPath(name) {
  const base = name.endsWith(".json") ? name : `${name}.json`;
  const full = path.join(PRESETS_DIR, base);
  if (!fs.existsSync(full)) die(`Preset not found: ${full}`);
  return full;
}

function buildMergedConfig(current, preset) {
  const preserve = new Set(preset.preserve || []);
  const overrides = { ...(preset.overrides || {}) };
  const preserved = {};
  for (const key of preserve) {
    if (current[key] !== undefined) preserved[key] = current[key];
  }
  const merged = deepMerge(current, overrides);
  for (const [key, val] of Object.entries(preserved)) {
    merged[key] = val;
  }
  merged._presetApplied = {
    name: preset._meta?.name || "unknown",
    at: new Date().toISOString(),
    previousPreset: current.preset ?? "custom",
  };
  return merged;
}

function printDiff(before, after) {
  const beforeMap = new Map(flattenForDiff(before));
  const afterMap = new Map(flattenForDiff(after));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changed = [...keys]
    .filter((k) => JSON.stringify(beforeMap.get(k)) !== JSON.stringify(afterMap.get(k)))
    .sort();

  if (changed.length === 0) {
    console.log("No changes.");
    return;
  }

  console.log(`Changes (${changed.length} keys):\n`);
  for (const key of changed) {
    const oldVal = beforeMap.get(key);
    const newVal = afterMap.get(key);
    if (oldVal === undefined) {
      console.log(`  + ${key}: ${formatVal(newVal)}`);
    } else if (newVal === undefined) {
      console.log(`  - ${key}: ${formatVal(oldVal)}`);
    } else {
      console.log(`  ~ ${key}`);
      console.log(`      was: ${formatVal(oldVal)}`);
      console.log(`      now: ${formatVal(newVal)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/apply-preset.js <preset-name> [--dry-run]");
    console.log("       node scripts/apply-preset.js --list");
    process.exit(0);
  }
  if (args.includes("--list")) {
    listPresets();
    return;
  }

  const dryRun = args.includes("--dry-run");
  const presetName = args.find((a) => !a.startsWith("--"));
  if (!presetName) die("Missing preset name. Use --list to see options.");

  if (!fs.existsSync(USER_CONFIG_PATH)) die(`user-config.json not found: ${USER_CONFIG_PATH}`);

  const preset = loadJson(resolvePresetPath(presetName));
  const current = loadJson(USER_CONFIG_PATH);
  const merged = buildMergedConfig(current, preset);

  console.log(`Preset: ${preset._meta?.label || presetName}`);
  if (preset._meta?.notes?.length) {
    console.log("\nNotes:");
    for (const note of preset._meta.notes) console.log(`  • ${note}`);
  }
  console.log("");

  printDiff(current, merged);

  if (dryRun) {
    console.log("\n[dry-run] No files written.");
    return;
  }

  const backup = `${USER_CONFIG_PATH}.bak.${Date.now()}`;
  fs.copyFileSync(USER_CONFIG_PATH, backup);
  fs.writeFileSync(USER_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);

  try {
    reloadScreeningThresholds();
  } catch {
    // config reload is best-effort when daemon is not importing this script path
  }

  console.log(`\nApplied → ${USER_CONFIG_PATH}`);
  console.log(`Backup  → ${backup}`);
  console.log("Restart meridian daemon (pm2 restart meridian) to pick up schedule/opportunity changes.");
}

main().catch((err) => die(err.message));