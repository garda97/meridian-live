/**
 * Copy-trade: mirror entries from tracked "copytrade"-type smart wallets.
 *
 * Detection is pure on-chain (getWalletPositions → getProgramAccounts) — no
 * external API or key required. Each poll diffs a tracked wallet's live open
 * positions against the last-seen snapshot:
 *   - a position that's newly appeared gets mirrored (subject to the same
 *     blacklist/cooldown/duplicate-pool safety gates as a normal deploy);
 *   - a position that's vanished (they closed it) drops from the snapshot,
 *     and — only if copyTrade.mirrorExit is on — closes our mirror too.
 *
 * Exit stays on Meridian's own SL/TP/OOR/rebalance rules by default: we copy
 * their entry conviction, not their timing. A wallet's PRE-EXISTING positions
 * at the moment it's first tracked are never mirrored — the first poll only
 * takes a baseline snapshot, so we don't blindly ape everything they already
 * hold the instant they're added.
 *
 * Wallets are added via `addSmartWallet({ type: "copytrade" })` — deliberately
 * CLI/owner-only (the LLM-facing add_smart_wallet tool's `type` enum excludes
 * "copytrade"), since tracking a wallet here moves real money automatically.
 */
import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { atomicWriteFileSync } from "./utils/atomic-write.js";
import { config, computeDeployAmount } from "./config.js";
import { listSmartWallets } from "./smart-wallets.js";
import { isBlacklisted } from "./token-blacklist.js";
import { isPoolOnCooldown, isBaseMintOnCooldown, getPoolCooldownReason, getBaseMintCooldownReason } from "./pool-memory.js";
import { getPoolDetail } from "./tools/screening.js";
import { getWalletBalances } from "./tools/wallet.js";
import { appendDecision } from "./decision-log.js";
import { executeTool } from "./tools/executor.js";

const STATE_PATH = repoPath("copytrade-state.json");

function load() {
  if (!fs.existsSync(STATE_PATH)) return { wallets: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { wallets: {} };
  }
}

function save(data) {
  atomicWriteFileSync(STATE_PATH, JSON.stringify(data, null, 2));
}

export function getCopyTradeWallets() {
  return listSmartWallets().wallets.filter((w) => w.type === "copytrade");
}

export function getCopyTradeState() {
  return load();
}

/**
 * Pure diff: given the position addresses seen last poll and the wallet's
 * live positions this poll, which are newly opened and which have closed?
 * No I/O — exported for unit testing.
 */
export function diffWalletPositions(prevPositionAddresses, livePositions) {
  const liveAddrs = new Set(livePositions.map((p) => p.position));
  const prevAddrs = new Set(prevPositionAddresses);
  const opened = livePositions.filter((p) => !prevAddrs.has(p.position));
  const closed = prevPositionAddresses.filter((a) => !liveAddrs.has(a));
  return { opened, closed };
}

/**
 * Pure bin-math: mirror their range SHAPE (bins below/above the active bin)
 * rather than re-deriving our own volatility formula — the point of
 * copy-trading is copying their read on the pool. Falls back to config
 * defaults when their bin data is incomplete (RPC gap). No I/O — exported
 * for unit testing.
 */
export function computeMirrorBins(theirPosition, minBinsBelow, defaultBinsBelow) {
  const binsBelow = theirPosition.lower_bin != null && theirPosition.active_bin != null
    ? Math.max(minBinsBelow, theirPosition.active_bin - theirPosition.lower_bin)
    : defaultBinsBelow;
  const binsAbove = theirPosition.upper_bin != null && theirPosition.active_bin != null
    ? Math.max(0, theirPosition.upper_bin - theirPosition.active_bin)
    : 0;
  return { binsBelow, binsAbove };
}

function skip(wallet, theirPosition, reason) {
  log("copytrade", `Skipped mirroring ${wallet.name}'s ${String(theirPosition.pool || "").slice(0, 8)}: ${reason}`);
  appendDecision({
    type: "skip",
    actor: "COPYTRADE",
    pool: theirPosition.pool,
    summary: "Copytrade mirror skipped",
    reason,
    metrics: { source_wallet: wallet.address, source_position: theirPosition.position },
  });
  return { wallet: wallet.name, pool: theirPosition.pool, skipped: reason };
}

// Exported for integration testing only (test/test-copytrade.js exercises
// the skip-gate ordering end-to-end in DRY_RUN) — not part of the public
// poll API, callers should use runCopyTradePoll.
export async function tryMirrorEntry(wallet, theirPosition, entry) {
  const pool = theirPosition.pool;

  if (isPoolOnCooldown(pool)) {
    return skip(wallet, theirPosition, getPoolCooldownReason(pool) || "pool on cooldown");
  }

  // Only known after a pool-detail fetch — getWalletPositions doesn't return base_mint.
  let poolDetail = null;
  try {
    poolDetail = await getPoolDetail({ pool_address: pool, timeframe: config.screening?.timeframe || "5m" });
  } catch (e) {
    return skip(wallet, theirPosition, `pool detail fetch failed: ${e.message}`);
  }
  const baseMint = poolDetail?.base?.mint || null;

  if (baseMint && isBlacklisted(baseMint)) {
    return skip(wallet, theirPosition, "token blacklisted");
  }
  if (baseMint && isBaseMintOnCooldown(baseMint)) {
    return skip(wallet, theirPosition, getBaseMintCooldownReason(baseMint) || "base mint on cooldown");
  }

  const minUsd = config.copyTrade.minPositionUsd;
  if (minUsd > 0 && theirPosition.total_value_usd != null && theirPosition.total_value_usd < minUsd) {
    return skip(wallet, theirPosition, `their position $${theirPosition.total_value_usd} below floor $${minUsd}`);
  }

  const mirrorCount = Object.keys(entry.mirrors).length;
  if (mirrorCount >= config.copyTrade.maxPositions) {
    return skip(wallet, theirPosition, `copytrade cap reached (${mirrorCount}/${config.copyTrade.maxPositions})`);
  }

  const amountSol = config.copyTrade.amountSol > 0
    ? config.copyTrade.amountSol
    : computeDeployAmount((await getWalletBalances()).sol);

  const { binsBelow, binsAbove } = computeMirrorBins(theirPosition, config.strategy.minBinsBelow, config.strategy.defaultBinsBelow);

  const res = await executeTool("deploy_position", {
    pool_address: pool,
    pool_name: poolDetail?.name ? `copytrade:${wallet.name}:${poolDetail.name}` : `copytrade:${wallet.name}`,
    base_mint: baseMint,
    amount_y: amountSol,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: binsAbove,
  }, { actor: "COPYTRADE" }).catch((e) => ({ error: e.message }));

  if (res?.dry_run) {
    log("copytrade", `DRY RUN mirror ${wallet.name} → ${pool}: would deploy ${amountSol} SOL (bins ${binsBelow}/${binsAbove})`);
    return { wallet: wallet.name, pool, dry_run: true };
  }

  const ok = res?.success !== false && !res?.error && !res?.blocked;
  if (!ok) {
    return skip(wallet, theirPosition, res?.error || res?.reason || "deploy failed");
  }

  entry.mirrors[theirPosition.position] = {
    ourPosition: res.position,
    pool,
    openedAt: new Date().toISOString(),
  };
  appendDecision({
    type: "deploy",
    actor: "COPYTRADE",
    pool,
    pool_name: poolDetail?.name || pool.slice(0, 8),
    position: res.position,
    summary: `Copy-traded ${wallet.name}'s new position`,
    reason: `${wallet.name} opened ${theirPosition.position.slice(0, 8)} in this pool`,
    metrics: {
      source_wallet: wallet.address,
      source_position: theirPosition.position,
      amount_sol: amountSol,
      bins_below: binsBelow,
      bins_above: binsAbove,
    },
  });
  log("copytrade", `Mirrored ${wallet.name} → deployed ${amountSol} SOL into ${pool} (our position ${res.position})`);
  return { wallet: wallet.name, pool, position: res.position, mirrored: true };
}

/**
 * One poll tick across all tracked copytrade wallets. Safe to call
 * concurrently-guarded by the caller (daemon/engine.js gates on its own
 * busy flags, same pattern as the opportunity poller).
 */
export async function runCopyTradePoll() {
  if (!config.copyTrade.enabled) return { skipped: "disabled" };
  const wallets = getCopyTradeWallets();
  if (wallets.length === 0) return { skipped: "no_wallets" };

  const { getWalletPositions, closePosition } = await import("./tools/dlmm.js");
  const state = load();
  const results = [];

  for (const wallet of wallets) {
    const isFirstObservation = !state.wallets[wallet.address];
    const entry = state.wallets[wallet.address] || { lastPositions: [], mirrors: {} };

    let livePositions;
    try {
      const r = await getWalletPositions({ wallet_address: wallet.address });
      livePositions = r?.positions || [];
    } catch (e) {
      log("copytrade_warn", `Failed to fetch positions for ${wallet.name}: ${e.message}`);
      continue;
    }

    if (isFirstObservation) {
      entry.lastPositions = livePositions.map((p) => p.position);
      state.wallets[wallet.address] = entry;
      log("copytrade", `Baseline snapshot for ${wallet.name}: ${livePositions.length} existing position(s) — mirroring starts from new entries only`);
      continue;
    }

    const { opened, closed } = diffWalletPositions(entry.lastPositions, livePositions);
    for (const pos of opened) {
      results.push(await tryMirrorEntry(wallet, pos, entry));
    }

    for (const theirAddr of closed) {
      const mirror = entry.mirrors[theirAddr];
      if (!mirror) continue;
      if (config.copyTrade.mirrorExit) {
        try {
          const res = await closePosition({ position_address: mirror.ourPosition, reason: `copytrade: ${wallet.name} closed their position` });
          log("copytrade", `Mirror-exit ${wallet.name} → closed our ${mirror.ourPosition}: ${res?.success ? "OK" : res?.error}`);
        } catch (e) {
          log("copytrade_warn", `Mirror-exit close failed for ${mirror.ourPosition}: ${e.message}`);
        }
      }
      delete entry.mirrors[theirAddr];
    }

    entry.lastPositions = livePositions.map((p) => p.position);
    state.wallets[wallet.address] = entry;
  }

  save(state);
  return { results };
}
