#!/usr/bin/env node
/**
 * watch_wallet_candidates.js
 * --------------------------------------------------------------------------
 * INTIP KOLEKSI WALLET = SIGNALLING ONLY, BUKAN MIRROR / COPYTRADE.
 *
 * Polls every wallet in smart-wallets.json with type in
 * {signal, alpha, watch, copytrade}. When a wallet OPENS a NEW DLMM position,
 * this script injects that pool as a *candidate* into discord-signals.json
 * (status: "pending"). The Meridian screening pipeline then picks it up on
 * the next cycle and DECIDES strategy / range / deploy entirely on its own
 * rules — it does NOT copy the wallet's range, size, or exit.
 *
 * Safety:
 *  - Never deploys. Never calls deploy_position. Only writes a candidate row.
 *  - First poll only baselines (existing positions are never injected).
 *  - Dedupe: a pool already pending/seen is not re-injected.
 *  - Idempotent: safe to run alongside the daemon.
 *  - copyTrade.enabled in user-config MUST stay false for mirror mode.
 *
 * Usage:
 *   node scripts/watch_wallet_candidates.js [--once] [--interval-sec 60]
 *   --once    : single poll + exit (good for cron / manual check)
 *   default   : loops forever (run under systemd if you want 24/7)
 *
 * Env: MERIDIAN_DEBUG=1 for verbose logs.
 * --------------------------------------------------------------------------
 */
import "../envcrypt.js"; // loads + decrypts .env — must stay early
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getWalletPositions } from "../tools/dlmm.js";
import { fetchDlmmPnlForPool } from "../tools/pnl.js";
import { buildWalletSignal, formatWalletSignalNote, isWalletSignalComplete } from "../utils/wallet-signal-enrich.js";
import {
  recordWalletOpen,
  recordWalletClose,
  recordWalletMigrate,
  seedBaselinePositions,
  loadPlaybookData,
} from "../utils/wallet-playbook.js";
import { repoPath } from "../repo-root.js";
import { runPoolPreChecks } from "../discord-listener/pre-checks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SMART_WALLETS_FILE = repoPath("smart-wallets.json");
const SIGNALS_FILE = repoPath("discord-signals.json");

// Types we WATCH as alpha sources. "copytrade" kept for backward-compat label only —
// this script NEVER mirrors; daemon copyTrade poller is a separate path (must stay OFF).
const SIGNAL_TYPES = new Set(["signal", "alpha", "watch", "copytrade"]);

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const intervalIdx = args.indexOf("--interval-sec");
const intervalSec = Number(intervalIdx >= 0 ? args[intervalIdx + 1] : 30) || 30;

function log(msg) {
  console.log(`[watch_wallet_candidates] ${msg}`);
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function getSignalWallets() {
  const data = loadJson(SMART_WALLETS_FILE, { wallets: [] });
  return (data.wallets || []).filter(
    (w) => w.address && SIGNAL_TYPES.has(String(w.type || "").toLowerCase()) && w.mirror !== true,
  );
}

// backward-compat export name
const getCopytradeWallets = getSignalWallets;

function readSignals() {
  const raw = loadJson(SIGNALS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function writeSignals(arr) {
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(arr, null, 2));
}

function pendingPoolSet(signals) {
  return new Set(
    signals.filter((s) => s.status === "pending" && s.pool_address).map((s) => s.pool_address),
  );
}

async function fetchPnlWithRetry(pool, walletAddress, positionAddress, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const pnlMap = await fetchDlmmPnlForPool(pool, walletAddress);
      const row = pnlMap[positionAddress] || null;
      if (row?.allTimeDeposits) return row;
    } catch {
      /* retry */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  try {
    const pnlMap = await fetchDlmmPnlForPool(pool, walletAddress);
    return pnlMap[positionAddress] || null;
  } catch {
    return null;
  }
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

  const prev = state.seen.get(address) || new Set();
  const closedAddrs = [...prev].filter((a) => !liveAddrs.has(a));
  const freshCandidates = [...liveAddrs].filter((a) => !prev.has(a));
  const migratedNewAddrs = new Set();

  for (const posAddr of closedAddrs) {
    const meta = loadPlaybookData().open_positions[posAddr];
    if (!meta?.pool_address) continue;

    // Rebalance/reshape: old NFT gone, new NFT same pool — don't count as close+open.
    const replacement = positions.find((p) => p.pool === meta.pool_address && p.position !== posAddr);
    if (replacement && freshCandidates.includes(replacement.position)) {
      try {
        const pnlRaw = await fetchPnlWithRetry(replacement.pool, address, replacement.position);
        const signal = buildWalletSignal({ wallet_name: name, wallet_address: address, position: replacement, pnlRaw });
        if (!isWalletSignalComplete(signal)) {
          log(`${name}: migrate ${posAddr.slice(0, 8)} → ${replacement.position.slice(0, 8)} skipped — incomplete range/deposit snapshot`);
          continue;
        }
        await recordWalletMigrate({
          old_position_address: posAddr,
          wallet_name: name,
          wallet_address: address,
          new_position: replacement,
          pnlRaw,
        });
        migratedNewAddrs.add(replacement.position);
        log(`${name}: playbook MIGRATE ${posAddr.slice(0, 8)} → ${replacement.position.slice(0, 8)} (${meta.conditions?.pool_name || "pool"})`);
      } catch (e) {
        log(`${name}: playbook migrate err: ${e.message}`);
      }
      continue;
    }

    try {
      await recordWalletClose({
        position_address: posAddr,
        wallet_address: address,
        pool_address: meta.pool_address,
      });
      log(`${name}: playbook CLOSE ${posAddr.slice(0, 8)} (${meta.conditions?.pool_name || "pool"})`);
    } catch (e) {
      log(`${name}: playbook close err ${posAddr.slice(0, 8)}: ${e.message}`);
    }
  }

  // First poll: baseline only, never inject — but seed playbook for existing positions.
  if (!state.baselined.has(address)) {
    state.baselined.add(address);
    state.seen.set(address, liveAddrs);
    if (positions.length > 0) {
      const seeded = await seedBaselinePositions(wallet, positions);
      log(`${name}: baseline ${liveAddrs.size} position(s) — playbook seeded ${seeded.length}`);
    } else {
      log(`${name}: baseline 0 position(s) — skipping (no inject)`);
    }
    return;
  }

  const fresh = freshCandidates.filter((a) => !migratedNewAddrs.has(a));

  if (fresh.length === 0) {
    state.seen.set(address, liveAddrs);
    return;
  }

  const newPositions = positions.filter((p) => fresh.includes(p.position));
  const signals = readSignals();
  const pending = pendingPoolSet(signals);
  let injected = 0;

  for (const pos of newPositions) {
    const pool = pos.pool;
    if (!pool) continue;
    if (pending.has(pool)) {
      log(`${name}: pool ${String(pool).slice(0, 8)} already pending — skip`);
      continue;
    }

    const pnlRaw = await fetchPnlWithRetry(pool, address, pos.position);
    const walletSignal = buildWalletSignal({
      wallet_name: name,
      wallet_address: address,
      position: pos,
      pnlRaw,
    });

    if (!isWalletSignalComplete(walletSignal)) {
      log(
        `${name}: OPEN ${String(pool).slice(0, 8)} NOT RECORDED — incomplete snapshot` +
        ` (bins=${walletSignal.width_bins}, deposit=${walletSignal.deposit_side}, strategy=${walletSignal.inferred_strategy})`,
      );
      continue;
    }

    const precheck = await runPoolPreChecks(pool);
    if (!precheck.pass) {
      log(`${name}: OPEN ${String(pool).slice(0, 8)} NOT QUEUED — ${precheck.reason}`);
      continue;
    }

    const strategyNote = formatWalletSignalNote(walletSignal);
    signals.push({
      status: "pending",
      pool_address: pool,
      queued_at: new Date().toISOString(),
      source: `signal:${name}`,
      wallet_signal: walletSignal,
      note: strategyNote
        ? `signalling only — ${name} opened DLMM (${strategyNote}); Meridian decides strategy (NOT a mirror)`
        : "signalling only — wallet opened new DLMM; Meridian decides strategy (NOT a mirror)",
    });
    pending.add(pool);
    injected++;
    try {
      await recordWalletOpen({
        wallet_name: name,
        wallet_address: address,
        position: pos,
        pnlRaw,
        event_type: "open",
      });
    } catch (e) {
      log(`${name}: playbook open err: ${e.message}`);
    }

    log(
      `${name}: SIGNAL pool ${String(pool).slice(0, 8)}` +
        (strategyNote ? ` [${strategyNote}]` : "") +
        " (no mirror)",
    );
  }

  if (injected > 0) writeSignals(signals);
  state.seen.set(address, liveAddrs);
}

async function runOnce() {
  const wallets = getSignalWallets();
  if (wallets.length === 0) {
    log("no signal wallets configured — nothing to watch");
    return;
  }
  log(`watching ${wallets.length} wallet(s) as SIGNALLING only (copyTrade mirror OFF)...`);
  // persistent baseline across loop ticks
  if (!runOnce._state) {
    runOnce._state = { baselined: new Set(), seen: new Map() };
  }
  for (const w of wallets) {
    await pollWallet(w, runOnce._state);
  }
}

async function loop() {
  log(`loop mode, interval=${intervalSec}s — signalling only`);
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[watch_wallet_candidates] loop err:", e.message);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("watch_wallet_candidates.js")) {
  if (ONCE) {
    runOnce()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    loop();
  }
}

export { runOnce, getCopytradeWallets, getSignalWallets };
