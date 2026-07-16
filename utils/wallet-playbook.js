/**
 * Wallet Playbook — log gacor wallet LP opens/closes with coin conditions + strategy.
 * Builds per-wallet profiles: which strategy they use under which market regime.
 */
import fs from "fs";
import { config } from "../config.js";
import { repoPath } from "../repo-root.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { buildWalletSignal, formatWalletSignalNote } from "./wallet-signal-enrich.js";
import { fetchDlmmPnlForPool } from "../tools/pnl.js";

const PLAYBOOK_FILE = repoPath("wallet-playbook.json");
const PLAYBOOK_LOG = repoPath("notes/GACOR_PLAYBOOK.log");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

const DEFAULT_DATA = {
  version: 1,
  updated_at: null,
  open_positions: {},
  events: [],
  profiles: {},
};

function loadPlaybook() {
  if (!fs.existsSync(PLAYBOOK_FILE)) return structuredClone(DEFAULT_DATA);
  try {
    const data = JSON.parse(fs.readFileSync(PLAYBOOK_FILE, "utf8"));
    return {
      ...structuredClone(DEFAULT_DATA),
      ...data,
      open_positions: data.open_positions || {},
      events: Array.isArray(data.events) ? data.events : [],
      profiles: data.profiles || {},
    };
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}

function savePlaybook(data) {
  data.updated_at = new Date().toISOString();
  atomicWriteFileSync(PLAYBOOK_FILE, JSON.stringify(data, null, 2));
}

function appendLog(line) {
  const dir = repoPath("notes");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(PLAYBOOK_LOG, `${new Date().toISOString()} ${line}\n`);
}

function round(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 10 ** d) / 10 ** d;
}

export function classifyMcapBucket(mcap) {
  const m = Number(mcap);
  if (!Number.isFinite(m) || m <= 0) return "unknown";
  if (m < 200_000) return "micro";
  if (m < 1_000_000) return "small";
  if (m < 5_000_000) return "mid";
  return "large";
}

export function classifyPumpBucket(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return "unknown";
  if (p < -10) return "dump";
  if (p <= 10) return "flat";
  if (p <= 30) return "pump";
  return "hot";
}

export function classifyVolBucket(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v <= 0) return "unknown";
  if (v < 5_000) return "low";
  if (v < 50_000) return "medium";
  return "high";
}

export function buildRegimeKey(conditions) {
  return [
    `mcap_${conditions.mcap_bucket || "unknown"}`,
    `pump_${conditions.pump_bucket || "unknown"}`,
    `vol_${conditions.vol_bucket || "unknown"}`,
  ].join("|");
}

export function formatRegimeLabel(regimeKey) {
  return regimeKey
    .split("|")
    .map((part) => part.replace(/^(mcap|pump|vol)_/, ""))
    .join(" / ");
}

async function fetchPoolDiscovery(poolAddress, timeframe = config.screening?.timeframe || "30m") {
  const url =
    `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`pool discovery ${res.status}`);
  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function fetchTokenSnapshot(mint) {
  if (!mint) return null;
  try {
    const { getTokenInfo } = await import("../tools/token.js");
    const info = await getTokenInfo({ query: mint });
    const row = info?.results?.[0] || info?.result || info;
    return row || null;
  } catch {
    return null;
  }
}

export async function fetchCoinConditions(poolAddress) {
  const timeframe = config.screening?.timeframe || "30m";
  const pool = await fetchPoolDiscovery(poolAddress, timeframe);
  const mint = pool?.base_mint || pool?.token_x?.address || pool?.mint_x || null;
  const token = await fetchTokenSnapshot(mint);

  const mcap = token?.mcap ?? pool?.token_x?.market_cap ?? pool?.market_cap ?? null;
  const pump1h = token?.stats_1h?.price_change ?? pool?.pool_price_change_pct ?? null;
  const volume = pool?.volume ?? pool?.trade_volume_24h ?? null;

  const conditions = {
    pool_address: poolAddress,
    pool_name: pool?.name || pool?.pool_name || null,
    base_mint: mint,
    base_symbol: pool?.token_x?.symbol || pool?.mint_x_symbol || token?.symbol || null,
    bin_step: pool?.bin_step ?? pool?.dlmm_params?.bin_step ?? null,
    fee_pct: pool?.base_fee_percentage ?? pool?.fee_pct ?? null,
    tvl: round(pool?.liquidity ?? pool?.tvl ?? pool?.active_tvl),
    active_tvl: round(pool?.active_tvl ?? pool?.liquidity),
    volume_window: round(volume),
    fee_window: round(pool?.fee),
    fee_tvl_ratio: round(pool?.fee_active_tvl_ratio, 4),
    volatility: round(pool?.volatility, 4),
    organic_score: round(pool?.token_x?.organic_score ?? token?.organic_score),
    holders: pool?.base_token_holders ?? token?.holders ?? null,
    mcap: round(mcap),
    pump_1h_pct: round(pump1h, 1),
    launchpad: token?.launchpad || pool?.token_x?.launchpad || null,
    timeframe,
    mcap_bucket: classifyMcapBucket(mcap),
    pump_bucket: classifyPumpBucket(pump1h),
    vol_bucket: classifyVolBucket(volume),
  };
  conditions.regime_key = buildRegimeKey(conditions);
  conditions.regime_label = formatRegimeLabel(conditions.regime_key);
  return conditions;
}

function upsertProfile(data, event) {
  const name = event.wallet_name;
  if (!name) return;
  const profile = data.profiles[name] || {
    wallet_name: name,
    wallet_address: event.wallet_address,
    total_opens: 0,
    total_closes: 0,
    wins: 0,
    losses: 0,
    by_regime: {},
    by_strategy: {},
    last_event_at: null,
  };

  // baseline = positions already open when watcher first saw the wallet — audit only,
  // not a real trade (don't inflate open counts or strategy stats).
  if (event.event_type === "open") {
    profile.total_opens += 1;
    const strat = event.strategy?.inferred_strategy || "unknown";
    profile.by_strategy[strat] = (profile.by_strategy[strat] || 0) + 1;

    const regime = event.conditions?.regime_key || "unknown";
    const bucket = profile.by_regime[regime] || {
      regime_key: regime,
      regime_label: event.conditions?.regime_label || regime,
      opens: 0,
      closes: 0,
      strategies: {},
      range_styles: {},
      avg_width_bins: null,
      _width_sum: 0,
      wins: 0,
      losses: 0,
      pnl_pcts: [],
    };
    bucket.opens += 1;
    bucket.strategies[strat] = (bucket.strategies[strat] || 0) + 1;
    const rs = event.strategy?.range_style;
    if (rs) bucket.range_styles[rs] = (bucket.range_styles[rs] || 0) + 1;
    if (event.strategy?.width_bins != null) {
      bucket._width_sum = (bucket._width_sum || 0) + event.strategy.width_bins;
      bucket.avg_width_bins = Math.round(bucket._width_sum / bucket.opens);
    }
    profile.by_regime[regime] = bucket;
  }

  if (event.event_type === "close") {
    profile.total_closes += 1;
    const pnl = event.outcome?.pnl_pct;
    if (Number.isFinite(pnl)) {
      if (pnl >= 0) profile.wins += 1;
      else profile.losses += 1;
    }
    const regime = event.conditions?.regime_key;
    if (regime && profile.by_regime[regime]) {
      const bucket = profile.by_regime[regime];
      bucket.closes += 1;
      if (Number.isFinite(pnl)) {
        bucket.pnl_pcts = bucket.pnl_pcts || [];
        bucket.pnl_pcts.push(pnl);
        if (pnl >= 0) bucket.wins += 1;
        else bucket.losses += 1;
      }
    }
  }

  profile.last_event_at = event.ts;
  profile.dominant_strategy = Object.entries(profile.by_strategy).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  data.profiles[name] = profile;
}

export async function recordWalletOpen({
  wallet_name,
  wallet_address,
  position,
  pnlRaw = null,
  event_type = "open",
}) {
  const data = loadPlaybook();
  const posAddr = position?.position;
  if (!posAddr || data.open_positions[posAddr]) return null;

  let strategy = buildWalletSignal({ wallet_name, wallet_address, position, pnlRaw });
  let conditions = null;
  try {
    conditions = await fetchCoinConditions(position.pool);
  } catch {
    conditions = {
      pool_address: position.pool,
      regime_key: "unknown",
      regime_label: "unknown",
    };
  }

  const event = {
    ts: new Date().toISOString(),
    event_type,
    wallet_name,
    wallet_address,
    position_address: posAddr,
    pool_address: position.pool,
    pool_name: conditions.pool_name,
    conditions,
    strategy,
    strategy_note: formatWalletSignalNote(strategy),
  };

  data.events.push(event);
  if (data.events.length > 2000) data.events = data.events.slice(-2000);
  data.open_positions[posAddr] = {
    wallet_name,
    wallet_address,
    pool_address: position.pool,
    opened_at: event.ts,
    event_type,
    conditions,
    strategy,
  };
  upsertProfile(data, event);
  savePlaybook(data);

  const logLine =
    `[${event_type.toUpperCase()}] ${wallet_name} → ${conditions.pool_name || position.pool.slice(0, 8)}` +
    ` | regime: ${conditions.regime_label}` +
    ` | strategy: ${strategy.inferred_strategy} (${strategy.range_style}, ${strategy.width_bins} bins)` +
    ` | mcap=$${conditions.mcap ?? "?"} pump1h=${conditions.pump_1h_pct ?? "?"}% vol=$${conditions.volume_window ?? "?"}`;
  appendLog(logLine);
  return event;
}

async function fetchClosedPnl(poolAddress, walletAddress, positionAddress, { attempts = 3 } = {}) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) {
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const data = await res.json();
      const positions = data.positions || data.data || [];
      const hit = positions.find((p) => (p.positionAddress || p.address) === positionAddress) || null;
      if (hit?.pnlPctChange != null || i === attempts - 1) return hit;
    } catch {
      /* retry */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * Rebalance/reshape: same wallet+pool, new position address — NOT a close+reopen.
 * Preserves original open time, conditions, and entry strategy snapshot.
 */
export async function recordWalletMigrate({ old_position_address, wallet_name, wallet_address, new_position, pnlRaw = null }) {
  const data = loadPlaybook();
  const tracked = data.open_positions[old_position_address];
  if (!tracked) return null;

  const newAddr = new_position?.position;
  if (!newAddr || data.open_positions[newAddr]) return null;

  const strategy = buildWalletSignal({ wallet_name, wallet_address, position: new_position, pnlRaw });

  const event = {
    ts: new Date().toISOString(),
    event_type: "migrate",
    wallet_name,
    wallet_address,
    position_address: newAddr,
    previous_position_address: old_position_address,
    pool_address: tracked.pool_address,
    pool_name: tracked.conditions?.pool_name || null,
    conditions: tracked.conditions,
    strategy_before: tracked.strategy,
    strategy_after: strategy,
    strategy_note: formatWalletSignalNote(strategy),
  };

  data.events.push(event);
  if (data.events.length > 2000) data.events = data.events.slice(-2000);
  delete data.open_positions[old_position_address];
  data.open_positions[newAddr] = {
    ...tracked,
    wallet_name,
    wallet_address,
    migrated_from: old_position_address,
    migrated_at: event.ts,
    strategy,
  };
  savePlaybook(data);

  appendLog(
    `[MIGRATE] ${wallet_name} → ${tracked.conditions?.pool_name || tracked.pool_address.slice(0, 8)}` +
    ` | ${old_position_address.slice(0, 8)} → ${newAddr.slice(0, 8)}` +
    ` | range: ${strategy.inferred_strategy} (${strategy.range_style}, ${strategy.width_bins} bins)`,
  );
  return event;
}

export async function recordWalletClose({ position_address, wallet_address, pool_address }) {
  const data = loadPlaybook();
  const tracked = data.open_positions[position_address];
  if (!tracked) return null;

  const closed = await fetchClosedPnl(pool_address, wallet_address, position_address);
  const pnlPct = closed?.pnlPctChange != null ? round(closed.pnlPctChange, 2) : null;
  const pnlUsd = closed?.pnlUsd != null ? round(closed.pnlUsd, 2) : null;
  const holdMinutes = tracked.opened_at && closed?.closedAt
    ? Math.floor((closed.closedAt * 1000 - Date.parse(tracked.opened_at)) / 60000)
    : null;

  const event = {
    ts: new Date().toISOString(),
    event_type: "close",
    wallet_name: tracked.wallet_name,
    wallet_address,
    position_address,
    pool_address,
    pool_name: tracked.conditions?.pool_name || null,
    conditions: tracked.conditions,
    strategy: tracked.strategy,
    outcome: {
      pnl_pct: pnlPct,
      pnl_usd: pnlUsd,
      hold_minutes: holdMinutes,
      fees_usd: closed?.allTimeFees?.total?.usd != null ? round(closed.allTimeFees.total.usd, 2) : null,
    },
  };

  data.events.push(event);
  if (data.events.length > 2000) data.events = data.events.slice(-2000);
  delete data.open_positions[position_address];
  upsertProfile(data, event);
  savePlaybook(data);

  const logLine =
    `[CLOSE] ${tracked.wallet_name} → ${tracked.conditions?.pool_name || pool_address.slice(0, 8)}` +
    ` | PnL ${pnlPct != null ? `${pnlPct}%` : "?"}` +
    ` | was ${tracked.strategy?.inferred_strategy} under ${tracked.conditions?.regime_label || "?"}`;
  appendLog(logLine);
  return event;
}

export async function seedBaselinePositions(wallet, positions) {
  const results = [];
  for (const pos of positions) {
    try {
      const pnlMap = await fetchDlmmPnlForPool(pos.pool, wallet.address);
      const event = await recordWalletOpen({
        wallet_name: wallet.name,
        wallet_address: wallet.address,
        position: pos,
        pnlRaw: pnlMap[pos.position] || null,
        event_type: "baseline",
      });
      if (event) results.push(event);
    } catch (e) {
      appendLog(`[BASELINE_ERR] ${wallet.name} ${pos.position?.slice(0, 8)}: ${e.message}`);
    }
  }
  return results;
}

export function getPlaybookSummary() {
  const data = loadPlaybook();
  const wallets = Object.values(data.profiles).map((p) => {
    const regimes = Object.values(p.by_regime || {}).map((r) => {
      const topStrat = Object.entries(r.strategies || {}).sort((a, b) => b[1] - a[1])[0];
      return {
        regime: r.regime_label,
        opens: r.opens,
        dominant_strategy: topStrat?.[0] || null,
        strategy_counts: r.strategies,
        range_styles: r.range_styles,
        avg_width_bins: r.avg_width_bins,
        win_rate: r.closes > 0 ? round((r.wins || 0) / r.closes, 2) : null,
        avg_pnl_pct: r.pnl_pcts?.length
          ? round(r.pnl_pcts.reduce((s, v) => s + v, 0) / r.pnl_pcts.length, 2)
          : null,
      };
    });
    return {
      wallet: p.wallet_name,
      total_opens: p.total_opens,
      total_closes: p.total_closes,
      dominant_strategy: p.dominant_strategy,
      win_rate: p.total_closes > 0 ? round(p.wins / p.total_closes, 2) : null,
      regimes: regimes.sort((a, b) => b.opens - a.opens),
    };
  });
  return {
    updated_at: data.updated_at,
    open_positions: Object.keys(data.open_positions).length,
    wallets: wallets.sort((a, b) => b.total_opens - a.total_opens),
    recent_events: data.events.slice(-10),
  };
}

export function loadPlaybookData() {
  return loadPlaybook();
}