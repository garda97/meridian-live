import fs from "fs";
import os from "os";
import path from "path";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";

const DATA_DIR = path.join(os.homedir(), ".meridian");
const KEYS_PATH = path.join(DATA_DIR, "helius-keys.json");
const STATE_PATH = path.join(DATA_DIR, "helius-rotator-state.json");
const BACKUP_KEYS_PATH = "/root/.config/screening_g97/secrets/api_keys.json";

const ROTATABLE_HTTP = new Set([401, 403, 429]);
const DEFAULT_COOLDOWN_MS = {
  429: 90_000,
  401: 300_000,
  403: 300_000,
  default: 60_000,
};

let _keysCache = null;
let _stateCache = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function parseKeysFromEnv() {
  const multi = process.env.HELIUS_API_KEYS?.trim();
  if (multi) {
    return multi.split(",").map((k) => k.trim()).filter(Boolean);
  }
  const single = process.env.HELIUS_API_KEY?.trim();
  return single ? [single] : [];
}

function parseKeysFromFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (Array.isArray(raw.keys)) return raw.keys.filter(Boolean);
    const helius = raw.helius?.keys;
    if (Array.isArray(helius)) return helius.filter(Boolean);
    if (typeof helius === "string") {
      try {
        const parsed = JSON.parse(helius);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch {
        return helius.split(",").map((k) => k.trim()).filter(Boolean);
      }
    }
  } catch (err) {
    log("helius_rotator", `Failed to read ${filePath}: ${err.message}`);
  }
  return [];
}

function dedupe(keys) {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function loadState() {
  if (_stateCache) return _stateCache;
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    _stateCache = { currentIndex: 0, cooldowns: {}, stats: {} };
    return _stateCache;
  }
  try {
    _stateCache = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    _stateCache = { currentIndex: 0, cooldowns: {}, stats: {} };
  }
  _stateCache.cooldowns ??= {};
  _stateCache.stats ??= {};
  return _stateCache;
}

function saveState() {
  ensureDataDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(loadState(), null, 2));
}

function keyHint(key) {
  return `${key.slice(0, 8)}…`;
}

function isOnCooldown(key, state) {
  const entry = state.cooldowns[key];
  if (!entry?.until) return false;
  return Date.now() < entry.until;
}

export function getHeliusKeys() {
  if (_keysCache?.length) return _keysCache;

  let keys = parseKeysFromFile(KEYS_PATH);
  if (!keys.length) keys = parseKeysFromEnv();
  if (!keys.length) keys = parseKeysFromFile(BACKUP_KEYS_PATH);
  keys = dedupe(keys);

  if (!keys.length) {
    throw new Error("No Helius API keys found (.meridian/helius-keys.json, HELIUS_API_KEYS, or backup)");
  }

  _keysCache = keys;
  return keys;
}

export function reloadHeliusKeys() {
  _keysCache = null;
  return getHeliusKeys();
}

export function saveHeliusKeys(keys, source = "manual") {
  ensureDataDir();
  const payload = {
    keys: dedupe(keys),
    source,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(KEYS_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  _keysCache = payload.keys;
  loadState().currentIndex = 0;
  saveState();
  syncEnvPrimaryKey(payload.keys[0], payload.keys);
  try {
    persistEnvKeys();
  } catch (err) {
    log("helius_rotator", `persistEnvKeys skipped: ${err.message}`);
  }
  return payload.keys;
}

export function syncEnvPrimaryKey(primaryKey, allKeys = null) {
  const keys = allKeys ?? getHeliusKeys();
  process.env.HELIUS_API_KEY = primaryKey ?? keys[0];
  process.env.HELIUS_API_KEYS = keys.join(",");
  process.env.RPC_URL = buildHeliusRpcUrl(process.env.HELIUS_API_KEY);
}

export function persistEnvKeys(envPath = repoPath(".env")) {
  if (!fs.existsSync(envPath)) return false;
  const keys = getHeliusKeys();
  const primary = getCurrentHeliusKey();
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  const fields = {
    HELIUS_API_KEY: primary,
    HELIUS_API_KEYS: keys.join(","),
    RPC_URL: buildHeliusRpcUrl(primary),
  };
  const seen = new Set();
  const out = lines.map((line) => {
    for (const [k, v] of Object.entries(fields)) {
      if (line.startsWith(`${k}=`)) {
        seen.add(k);
        return `${k}=${v}`;
      }
    }
    return line;
  });
  for (const [k, v] of Object.entries(fields)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, out.join("\n") + "\n", { mode: 0o600 });
  return true;
}

export function buildHeliusRpcUrl(key) {
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export function getCurrentHeliusKey() {
  const keys = getHeliusKeys();
  const state = loadState();
  const start = state.currentIndex % keys.length;

  for (let offset = 0; offset < keys.length; offset++) {
    const idx = (start + offset) % keys.length;
    const key = keys[idx];
    if (!isOnCooldown(key, state)) {
      state.currentIndex = idx;
      saveState();
      syncEnvPrimaryKey(key, keys);
      return key;
    }
  }

  // All on cooldown — use round-robin anyway
  const key = keys[state.currentIndex % keys.length];
  syncEnvPrimaryKey(key, keys);
  return key;
}

export function rotateHeliusKey(reason = "rotate") {
  const keys = getHeliusKeys();
  const state = loadState();
  const current = keys[state.currentIndex % keys.length];
  const codeMatch = String(reason).match(/\b(401|403|429)\b/);
  const code = codeMatch ? Number(codeMatch[1]) : "default";
  const cooldownMs = DEFAULT_COOLDOWN_MS[code] ?? DEFAULT_COOLDOWN_MS.default;

  state.cooldowns[current] = {
    until: Date.now() + cooldownMs,
    reason: String(reason),
    at: new Date().toISOString(),
  };
  state.stats[current] ??= { success: 0, fail: 0 };
  state.stats[current].fail += 1;

  const nextIndex = (state.currentIndex + 1) % keys.length;
  state.currentIndex = nextIndex;
  saveState();

  const nextKey = keys[nextIndex];
  syncEnvPrimaryKey(nextKey, keys);
  log("helius_rotate", `${keyHint(current)} → ${keyHint(nextKey)} (${reason})`);
  return nextKey;
}

export function markHeliusSuccess(key = getCurrentHeliusKey()) {
  const state = loadState();
  state.stats[key] ??= { success: 0, fail: 0 };
  state.stats[key].success += 1;
  saveState();
}

export function shouldRotateHeliusError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("429")
    || msg.includes("403")
    || msg.includes("401")
    || msg.includes("rate limit")
    || msg.includes("too many requests")
    || msg.includes("unauthorized")
    || msg.includes("forbidden")
  );
}

export async function heliusFetch(urlBuilder, { maxAttempts } = {}) {
  const keys = getHeliusKeys();
  const attempts = maxAttempts ?? keys.length;
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    const key = getCurrentHeliusKey();
    const url = typeof urlBuilder === "function" ? urlBuilder(key) : urlBuilder;
    try {
      const res = await fetch(url);
      if (res.ok) {
        markHeliusSuccess(key);
        return res;
      }
      if (ROTATABLE_HTTP.has(res.status)) {
        rotateHeliusKey(String(res.status));
        lastError = new Error(`Helius HTTP ${res.status}`);
        continue;
      }
      throw new Error(`Helius HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
      if (shouldRotateHeliusError(err)) {
        rotateHeliusKey(err.message);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Helius fetch failed after rotation");
}

export function getRotatorStatus() {
  const keys = getHeliusKeys();
  const state = loadState();
  const current = keys[state.currentIndex % keys.length];
  const now = Date.now();
  return {
    dataDir: DATA_DIR,
    keysPath: KEYS_PATH,
    statePath: STATE_PATH,
    totalKeys: keys.length,
    currentIndex: state.currentIndex,
    currentKey: keyHint(current),
    rpcUrl: buildHeliusRpcUrl(current),
    cooldowns: Object.fromEntries(
      Object.entries(state.cooldowns ?? {}).map(([k, v]) => [
        keyHint(k),
        {
          reason: v.reason,
          remainingMs: Math.max(0, (v.until ?? 0) - now),
        },
      ]),
    ),
    stats: Object.fromEntries(
      Object.entries(state.stats ?? {}).map(([k, v]) => [keyHint(k), v]),
    ),
  };
}

export function importKeysFromBackup() {
  const keys = parseKeysFromFile(BACKUP_KEYS_PATH);
  if (!keys.length) {
    throw new Error(`No keys in backup: ${BACKUP_KEYS_PATH}`);
  }
  return saveHeliusKeys(keys, "screening_g97_backup");
}

// Bootstrap on first import
try {
  if (!fs.existsSync(KEYS_PATH)) {
    const fromEnv = parseKeysFromEnv();
    if (fromEnv.length > 1) {
      saveHeliusKeys(fromEnv, "env_bootstrap");
    } else if (fs.existsSync(BACKUP_KEYS_PATH)) {
      importKeysFromBackup();
      log("helius_rotator", `Imported ${getHeliusKeys().length} keys from backup`);
    }
  } else {
    getHeliusKeys();
    getCurrentHeliusKey();
  }
} catch (err) {
  log("helius_rotator", `Bootstrap skipped: ${err.message}`);
}