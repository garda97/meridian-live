import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  return safeNumber(value, null);
}

export function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

/**
 * MACD histogram from close prices — computed client-side from the candles
 * already in the indicator payload (no extra API call). Standard 12/26/9 EMA.
 * Returns { hist, prevHist, turnedGreen } or null when not enough candles.
 * turnedGreen = first positive histogram bar after a non-positive one — the
 * Evil Panda MACD exit trigger ("close di green histogram pertama").
 */
export function computeMacdFromCandles(candles, fast = 12, slow = 26, signalLen = 9) {
  const closes = (Array.isArray(candles) ? candles : [])
    .map((c) => safeNum(c?.close))
    .filter((v) => v != null);
  // Need enough bars for the slow EMA + signal to settle
  if (closes.length < slow + signalLen) return null;

  const ema = (values, len) => {
    const k = 2 / (len + 1);
    let prev = values.slice(0, len).reduce((s, v) => s + v, 0) / len;
    const out = new Array(values.length).fill(null);
    out[len - 1] = prev;
    for (let i = len; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValues = macdLine.filter((v) => v != null);
  if (macdValues.length < signalLen + 2) return null;
  const signalLine = ema(macdValues, signalLen);

  const rawHist = macdValues[macdValues.length - 1] - signalLine[signalLine.length - 1];
  const rawPrevHist = macdValues[macdValues.length - 2] - signalLine[signalLine.length - 2];
  if (!Number.isFinite(rawHist) || !Number.isFinite(rawPrevHist)) return null;

  const hist = Math.round(rawHist * 1e10) / 1e10;
  const prevHist = Math.round(rawPrevHist * 1e10) / 1e10;
  return { hist, prevHist, turnedGreen: hist > 0 && prevHist <= 0 };
}

export function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    case "evil_panda_exit": {
      // Evil Panda layered exit (METEORA_LP.md §Exit): armed once supertrend
      // support breaks (fresh break down or bearish direction), then fires on
      // the first strength candle — RSI(2) at/above the exit limit OR a close
      // at/above the BB upper band. Two-indicator confluence: trend break +
      // momentum spike, so the exit lands on the bounce, not the dump.
      if (side === "entry") {
        return { confirmed: false, reason: "evil_panda_exit is exit-only", signal: summary };
      }
      const rsiExitLimit = Number(config.indicators.evilPandaRsiExit ?? 90);
      const armed = summary.supertrendBreakDown || isBearish;
      const rsiSpike = rsi != null && rsi >= rsiExitLimit;
      const bbUpperTouch = close != null && upperBand != null && close >= upperBand;
      // Optional third trigger: first green MACD histogram bar after the break
      // (client-side from payload candles). Off by default — RSI/BB own the exit.
      const macd = config.indicators.evilPandaMacdExitEnabled
        ? computeMacdFromCandles(payload?.candles)
        : null;
      const macdGreen = !!macd?.turnedGreen;
      return {
        confirmed: armed && (rsiSpike || bbUpperTouch || macdGreen),
        reason: !armed
          ? "Supertrend support still holding"
          : rsiSpike
          ? `Supertrend broken + RSI(${config.indicators.rsiLength ?? 2}) ${rsi} >= ${rsiExitLimit}`
          : bbUpperTouch
          ? `Supertrend broken + close ${close} >= BB upper ${upperBand}`
          : macdGreen
          ? `Supertrend broken + first green MACD histogram (${macd.prevHist} → ${macd.hist})`
          : "Supertrend broken — waiting for RSI/BB-upper/MACD strength candle",
        signal: summary,
      };
    }
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

// Per-mint response cache, keyed by the full request (mint+interval+candles+rsiLength)
// so different callers asking for different windows never collide. 429 hardening
// (SPOT_LOSS_ANALYSIS.md P2a) — a rate-limit burst used to fail every candidate
// every cycle with no retry or reuse; this lets repeated/nearby candidates in the
// same burst share one fetch instead of each drawing a fresh 429.
const _indicatorCache = new Map(); // key -> { at, payload }

export async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const ttlMs = (config.indicators.cacheTtlSec ?? 150) * 1000;
  const cacheKey = `${mint}:${normalizedInterval}:${candles}:${rsiLength}`;

  if (!refresh && ttlMs > 0) {
    const cached = _indicatorCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttlMs) return cached.payload;
  }

  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  const payload = await agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
    retry: { maxAttempts: 2, maxElapsedMs: 8000 }, // 1 retry on 429/5xx, short budget so screening isn't stalled
  });

  if (ttlMs > 0) {
    _indicatorCache.set(cacheKey, { at: Date.now(), payload });
    // Bound long-running memory: sweep expired entries once the map gets large
    // rather than growing forever across a multi-day daemon process.
    if (_indicatorCache.size > 300) {
      const now = Date.now();
      for (const [key, entry] of _indicatorCache) {
        if (now - entry.at >= ttlMs) _indicatorCache.delete(key);
      }
    }
  }
  return payload;
}

/**
 * New-ATH check over the last `lookback` candles: the latest candle's high
 * must be >= every prior high in the window (Evil Panda entry precondition).
 */
export function isNewAthFromCandles(candles, lookback = 48) {
  if (!Array.isArray(candles) || candles.length < 2) {
    return { isNewAth: false, reason: "insufficient candles" };
  }
  const series = candles.slice(-Math.max(2, Math.round(lookback)));
  const latestHigh = safeNum(series[series.length - 1]?.high);
  if (latestHigh == null) return { isNewAth: false, reason: "latest high unavailable" };
  const priorHighs = series.slice(0, -1).map((c) => safeNum(c?.high)).filter((h) => h != null);
  if (priorHighs.length === 0) return { isNewAth: false, reason: "no prior highs in lookback" };
  const priorHigh = Math.max(...priorHighs);
  return {
    isNewAth: latestHigh >= priorHigh,
    latestHigh,
    priorHigh,
    reason: latestHigh >= priorHigh
      ? `new ATH ${latestHigh} >= prior high ${priorHigh} over ${series.length} candles`
      : `high ${latestHigh} below window high ${priorHigh}`,
  };
}

/**
 * Evil Panda entry gate: new ATH in lookback AND supertrend break above
 * (fresh flip up, or price holding above a bullish supertrend).
 */
export function evaluateAthEntryGate(payload, signal, lookback = config.autoStrategy?.athLookbackCandles ?? 48) {
  const ath = isNewAthFromCandles(payload?.candles, lookback);
  const supertrendUp = !!(
    signal?.supertrendBreakUp ||
    (signal?.supertrendDirection === "bullish" &&
      signal?.close != null &&
      signal?.supertrendValue != null &&
      signal.close >= signal.supertrendValue)
  );
  const pass = ath.isNewAth && supertrendUp;
  return {
    pass,
    isNewAth: ath.isNewAth,
    supertrendUp,
    reason: pass
      ? `ath_gate: ${ath.reason} + supertrend up`
      : `ath_gate: ${!ath.isNewAth ? ath.reason : "supertrend break up not confirmed"}`,
  };
}

const EXIT_CHECK_TTL_MS = 45_000;
const exitCheckCache = new Map();

/**
 * bb_plus_rsi is a profit-taking signal (RSI overbought + BB upper touch).
 * Below chartExitMinPnlPct, fees+slippage turn the exit into a net loss
 * (traindog: exited at +0.07% peak → -0.03% final). Stop loss owns the
 * downside; unknown or suspicious PnL never fires a chart exit.
 */
export function passesChartExitPnlGate(position = {}) {
  const minPnl = Number(config.indicators.chartExitMinPnlPct ?? 0.5);
  const pnl = Number(position.pnl_pct);
  if (position.pnl_pct_suspicious || !Number.isFinite(pnl)) return false;
  return pnl > 0 && pnl >= minPnl;
}

/**
 * Chart-based exit for open positions (bb_plus_rsi, supertrend, etc.).
 * Cached per mint to avoid hammering the indicator API on the 3s PnL poller.
 */
export async function checkPositionChartExit(position = {}) {
  const mint = position.base_mint || position.base?.mint;
  if (!config.indicators.enabled || !mint) return null;

  if (!passesChartExitPnlGate(position)) return null;

  const cached = exitCheckCache.get(mint);
  if (cached && Date.now() - cached.at < EXIT_CHECK_TTL_MS) return cached.result;

  const result = await confirmIndicatorPreset({ mint, side: "exit", refresh: false });
  let exit = null;
  if (result.enabled && result.confirmed && !result.skipped) {
    exit = {
      action: "CHART_EXIT",
      reason: `Chart exit (${result.preset}): ${result.reason}`,
    };
  }
  exitCheckCache.set(mint, { at: Date.now(), result: exit });
  return exit;
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  // Exits demand cross-interval agreement by default; a single fast interval
  // (5m) firing alone is noise, not a top. Entry keeps its own looser flag.
  const requireAll = side === "exit"
    ? config.indicators.exitRequireAllIntervals !== false
    : !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}
