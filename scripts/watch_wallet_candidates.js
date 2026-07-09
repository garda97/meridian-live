#!/usr/bin/env node
/**
 * watch_wallet_candidates.js
 * --------------------------------------------------------------------------
 * INTIP KOLEKSI WALLET, BUKAN MIRROR.
 *
 * Polls every `type=copytrade` wallet in smart-wallets.json. When a wallet
 * OPENS a NEW DLMM position, this script injects that pool as a *candidate*
 * into discord-signals.json (status: "pending"). The Meridian screening
 * pipeline then picks it up on the next cycle and DECIDES strategy / range /
 * deploy entirely on its own rules — it does NOT copy the wallet's range or
 * size. This decouples "which coin" (alpha from the wallet) from "how to
 * play it" (Meridian's bid_ask / rugcheck / fee-TVL gates).
 *
 * Safety:
 *  - Never deploys. Never calls deploy_position. Only writes a candidate row.
 *  - First poll only baselines (existing positions are never injected).
 *  - Dedupe: a pool already pending/seen is not re-injected.
 *  - Idempotent: safe to run alongside the daemon.
 *
 * Usage:
 *   node scripts/watch_wallet_candidates.js [--once] [--interval-sec 60]
 *   --once    : single poll + exit (good for cron / manual check)
 *   default   : loops forever (run under systemd/tmux if you want 24/7)
 *
 * Env: MERIDIAN_DEBUG=1 for verbose logs.
 * --------------------------------------------------------------------------
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getWalletPositions } from "../tools/dlmm.js";
import { repoPath } from "../repo-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SMART_WALLETS_FILE = repoPath("smart-wallets.json");
const SIGNALS_FILE = repoPath("discord-signals.json");

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const intervalSec = Number(args[args.indexOf("--interval-sec") + 1] || 60);

function log(msg) {
  if (process.env.MERIDIAN_DEBUG) console.log(`[watch_wallet_candidates] ${msg}`);
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function getCopytradeWallets() {
  const data = loadJson(SMART_WALLETS_FILE, { wallets: [] });
  return (data.wallets || []).filter((w) => w.type === "copytrade" && w.address);
}

function readSignals() {
  return loadJson(SIGNALS_FILE, []);
}

function writeSignals(arr) {
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(arr, null, 2));
}

function pendingPoolSet(signals) {
  return new Set(
    signals.filter((s) => s.status === "pending" && s.pool_address).map((s) => s.pool_address)
  );
}

async function pollWallet(wallet, state) {
  const { address, name } = wallet;
  let positions = [];
  try {
    const res = await getWalletPositions({ wallet_address: address });
    positions = res?.positions || [];
  } catch (e) {
    log(`poll ${name} err: ${e.message}`);
    return;
  }

  const liveAddrs = new Set(positions.map((p) => p.position));

  // First poll: baseline only, never inject.
  if (!state.baselined.has(address)) {
    state.baselined.add(address);
    state.seen.set(address, liveAddrs);
    log(`${name}: baseline ${liveAddrs.size} position(s) — skipping (no inject)`);
    return;
  }

  const prev = state.seen.get(address) || new Set();
  const fresh = [...liveAddrs].filter((a) => !prev.has(a));

  if (fresh.length === 0) {
    state.seen.set(address, liveAddrs);
    return;
  }

  // Map new position addresses -> pool addresses
  const newPools = positions.filter((p) => fresh.includes(p.position)).map((p) => p.pool);

  const signals = readSignals();
  const pending = pendingPoolSet(signals);
  let injected = 0;

  for (const pool of newPools) {
    if (pending.has(pool)) {
      log(`${name}: pool ${pool.slice(0, 8)} already pending — skip`);
      continue;
    }
    signals.push({
      status: "pending",
      pool_address: pool,
      queued_at: new Date().toISOString(),
      source: `copytrade:${name}`,
      note: "auto-injected from watched wallet opening a new DLMM position",
    });
    pending.add(pool);
    injected++;
    log(`${name}: INJECTED pool ${pool.slice(0, 8)} as candidate`);
  }

  if (injected > 0) writeSignals(signals);
  state.seen.set(address, liveAddrs);
}

async function runOnce() {
  const wallets = getCopytradeWallets();
  if (wallets.length === 0) {
    console.log("[watch_wallet_candidates] no copytrade wallets configured — nothing to watch");
    return;
  }
  console.log(`[watch_wallet_candidates] watching ${wallets.length} wallet(s)...`);
  const state = { baselined: new Set(), seen: new Map() };
  for (const w of wallets) {
    await pollWallet(w, state);
  }
}

async function loop() {
  console.log(`[watch_wallet_candidates] loop mode, interval=${intervalSec}s`);
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[watch_wallet_candidates] loop err:", e.message);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

if (ONCE) {
  runOnce().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  loop();
}

export { runOnce, getCopytradeWallets };
