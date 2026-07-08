import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  const timeoutMs = Math.max(0, Number(config.gmgn?.requestTimeoutMs ?? 10_000));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-APIKEY": getApiKey(),
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : null,
        signal: controller?.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`GMGN ${pathname} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unwrapGmgnData(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.data != null && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

function pctFromRate(value) {
  const n = num(value);
  if (n == null) return null;
  const pct = n <= 1 ? n * 100 : n;
  return parseFloat(pct.toFixed(2));
}

function holderTagSet(holder) {
  const tags = new Set();
  for (const entry of holder?.tags || []) tags.add(String(entry).toLowerCase());
  for (const entry of holder?.maker_token_tags || []) tags.add(String(entry).toLowerCase());
  if (holder?.wallet_tag_v2) tags.add(String(holder.wallet_tag_v2).toLowerCase());
  return tags;
}

function holderHasTag(holder, tag) {
  return holderTagSet(holder).has(String(tag).toLowerCase());
}

function summarizeGmgnHolders(list = []) {
  const tagCounts = {};
  let bundlersPct = 0;
  let bundlersInTop100 = 0;

  for (const holder of list) {
    const tags = holderTagSet(holder);
    for (const tag of tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    if (tags.has("bundler")) {
      bundlersInTop100 += 1;
      const share = num(holder.amount_percentage);
      if (share != null) bundlersPct += share <= 1 ? share * 100 : share;
    }
  }

  return {
    holders_fetched: list.length,
    bundlers_in_top_100: bundlersInTop100,
    bundlers_pct_in_top_100: parseFloat(bundlersPct.toFixed(2)),
    smart_degen_count: tagCounts.smart_degen || 0,
    renowned_count: tagCounts.renowned || 0,
    sniper_count: tagCounts.sniper || 0,
    dev_count: tagCounts.dev || 0,
    dex_bot_count: tagCounts.dex_bot || 0,
    fresh_wallet_count: tagCounts.fresh_wallet || 0,
    transfer_in_count: tagCounts.transfer_in || 0,
    tag_counts: tagCounts,
  };
}

/**
 * Tagged-wallet counts as % of total token holders (METEORA_LP checklist 10-11).
 * `stats` is the top-100 GMGN audit, `totalHolders` the token's holder count
 * from candidate data — counts are top-100-bounded, so these ratios are
 * conservative floors. Returns nulls when either side is missing.
 */
export function computeHolderRatios(stats, totalHolders) {
  const holders = Number(totalHolders);
  if (!stats || !Number.isFinite(holders) || holders <= 0) {
    return { fresh_wallet_holder_pct: null, bundled_wallet_holder_pct: null };
  }
  const pct = (count) => {
    const n = Number(count);
    return Number.isFinite(n) ? parseFloat(((n / holders) * 100).toFixed(2)) : null;
  };
  return {
    fresh_wallet_holder_pct: pct(stats.fresh_wallet_count),
    bundled_wallet_holder_pct: pct(stats.bundlers_in_top_100),
  };
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = unwrapGmgnData(payload);
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// --- GMGN call cache + daily budget (429/rate-limit hardening) ---
// Free-tier GMGN quota (per day): security 20, holders 4 (see notes/GMGN_RATE_LIMITS.md).
// Without caching, screening (~96 cycles/day) exhausts quota fast -> "IP temporarily banned".
const _gmgnCache = new Map(); // mint -> { at, security, holders }
const GMGN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const _gmgnDaily = { security: 0, holders: 0, resetAt: Date.now() };
const GMGN_DAILY_CAP = { security: 18, holders: 3 }; // buffer below 20/4
function gmgnDailyResetIfNeeded() {
  if (Date.now() - _gmgnDaily.resetAt > GMGN_CACHE_TTL_MS) {
    _gmgnDaily.security = 0;
    _gmgnDaily.holders = 0;
    _gmgnDaily.resetAt = Date.now();
  }
}
function gmgnBudgetAllows(type) {
  gmgnDailyResetIfNeeded();
  return _gmgnDaily[type] < (GMGN_DAILY_CAP[type] ?? 0);
}
function gmgnBudgetConsume(type) {
  gmgnDailyResetIfNeeded();
  _gmgnDaily[type] = (_gmgnDaily[type] ?? 0) + 1;
}
function gmgnCacheGet(mint) {
  const hit = _gmgnCache.get(mint);
  if (hit && Date.now() - hit.at < GMGN_CACHE_TTL_MS) return hit;
  return null;
}
function gmgnCacheSet(mint, patch) {
  const cur = _gmgnCache.get(mint) ?? { at: Date.now() };
  cur.at = Date.now();
  _gmgnCache.set(mint, { ...cur, ...patch });
}

export async function getGmgnTokenSecurity(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  // Cache hit (same day) -> no quota cost
  const cached = gmgnCacheGet(mint);
  if (cached?.security) return cached.security;
  // Budget exhausted -> return stale cache if any, else null (CPO fails closed safely)
  if (!gmgnBudgetAllows("security")) {
    if (cached) return cached.security;
    log("gmgn", `daily security budget exhausted; skipping ${String(mint).slice(0, 8)}`);
    return null;
  }
  try {
    const payload = await gmgnFetch("/v1/token/security", { params: { chain: "sol", address: mint } });
    const data = unwrapGmgnData(payload);
    if (!data || typeof data !== "object") return null;
    const security = {
      top_10_holder_pct: pctFromRate(data.top_10_holder_rate),
      burn_status: data.burn_status ?? null,
      burn_ratio: num(data.burn_ratio),
      mint_renounced: data.renounced_mint ?? null,
      freeze_renounced: data.renounced_freeze_account ?? null,
      dev_token_burn_ratio: num(data.dev_token_burn_ratio),
      is_show_alert: data.is_show_alert ?? null,
      flags: Array.isArray(data.flags) ? data.flags : [],
    };
    gmgnBudgetConsume("security");
    gmgnCacheSet(mint, { security });
    return security;
  } catch (error) {
    log("gmgn", `token security lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

export async function getGmgnTokenTopHolders(mint, { limit = 100 } = {}) {
  if (!mint || !hasGmgnApiKey()) return null;
  // Cache hit (same day) -> no quota cost. Note: limit only affects how many we keep,
  // but we cache the full top-100 list so any limit can be served from cache.
  const cached = gmgnCacheGet(mint);
  if (cached?.holders) {
    const list = cached.holders.holders ?? [];
    return { ...cached.holders, holders: list.slice(0, Math.min(Math.max(limit, 1), 100)) };
  }
  // Budget exhausted -> return stale cache if any, else null (CPO fails closed safely)
  if (!gmgnBudgetAllows("holders")) {
    if (cached?.holders) return cached.holders;
    log("gmgn", `daily holders budget exhausted; skipping ${String(mint).slice(0, 8)}`);
    return null;
  }
  try {
    const payload = await gmgnFetch("/v1/market/token_top_holders", {
      params: { chain: "sol", address: mint, limit: Math.min(Math.max(limit, 1), 100) },
    });
    const data = unwrapGmgnData(payload);
    const rawList = Array.isArray(data?.list) ? data.list : [];
    const holders = {
      holders: rawList.map((holder) => ({
        address: holder.address,
        pct: pctFromRate(holder.amount_percentage),
        usd_value: num(holder.usd_value),
        tags: [...holderTagSet(holder)],
        is_bundler: holderHasTag(holder, "bundler") || undefined,
        is_smart_degen: holderHasTag(holder, "smart_degen") || undefined,
        is_sniper: holderHasTag(holder, "sniper") || undefined,
        is_dev: holderHasTag(holder, "dev") || undefined,
      })),
      ...summarizeGmgnHolders(rawList),
    };
    gmgnBudgetConsume("holders");
    gmgnCacheSet(mint, { holders });
    return holders;
  } catch (error) {
    log("gmgn", `token holders lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// Lightweight GMGN audit for screening: fees + security only.
export async function getGmgnTokenAuditLite(mint) {
  if (!mint || !hasGmgnApiKey() || config.gmgn?.holderAudit === false) return null;
  const fees = await getGmgnTokenFees(mint);
  const security = await getGmgnTokenSecurity(mint);
  if (!fees && !security) return null;
  return { fees, security };
}

// Full GMGN holder audit for deep checks / token-holders CLI.
export async function getGmgnHolderAudit(mint) {
  if (!mint || !hasGmgnApiKey() || config.gmgn?.holderAudit === false) return null;
  const lite = await getGmgnTokenAuditLite(mint);
  const holders = await getGmgnTokenTopHolders(mint, { limit: 100 });
  if (!lite && !holders) return null;
  return {
    ...(lite || {}),
    holders,
  };
}
