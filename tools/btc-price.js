import { fetchWithTimeout } from "../utils/fetch-timeout.js";

// Public, no-key endpoint — BTC has no Solana-native price feed (Jupiter is
// Solana-DEX-only), so this is the one external dependency this module adds.
const COINGECKO_PRICE_API = "https://api.coingecko.com/api/v3/simple/price";

async function fetchBtcPriceUsd() {
  try {
    const res = await fetchWithTimeout(`${COINGECKO_PRICE_API}?ids=bitcoin&vs_currencies=usd`, {}, 10_000);
    if (!res.ok) return 0;
    const data = await res.json();
    const price = Number(data?.bitcoin?.usd ?? 0);
    return Number.isFinite(price) ? price : 0;
  } catch {
    return 0;
  }
}

// Cached like getSolPriceUsd (tools/wallet.js) — one call per 5 minutes,
// serves stale over nothing when the upstream call fails.
let _btcPriceCache = { price: null, at: 0 };
const BTC_PRICE_TTL_MS = 5 * 60_000;

export async function getBtcPriceUsd() {
  if (_btcPriceCache.price != null && Date.now() - _btcPriceCache.at < BTC_PRICE_TTL_MS) {
    return _btcPriceCache.price;
  }
  const price = await fetchBtcPriceUsd();
  if (price > 0) {
    _btcPriceCache = { price: Math.round(price * 100) / 100, at: Date.now() };
    return _btcPriceCache.price;
  }
  return _btcPriceCache.price;
}
