import assert from "node:assert/strict";
import { getBlockedThemeRejectReason } from "../utils/blocked-theme.js";
import { getRawPoolScreeningRejectReason } from "../tools/screening.js";

const keywords = ["trump", "musk", "elon", "barron", "melania", "melani"];

assert.match(
  getBlockedThemeRejectReason({ poolName: "TrumpCoin-SOL", symbol: "TrumpCoin" }, keywords),
  /trump/i,
);
assert.match(
  getBlockedThemeRejectReason({ poolName: "ELON-SOL", symbol: "ELON" }, keywords),
  /elon/i,
);
assert.match(
  getBlockedThemeRejectReason({ poolName: "BARRON-SOL", symbol: "BARRON" }, keywords),
  /barron/i,
);
assert.match(
  getBlockedThemeRejectReason({ poolName: "Melania-SOL", symbol: "MELANIA" }, keywords),
  /melania/i,
);
assert.equal(getBlockedThemeRejectReason({ poolName: "brain-SOL", symbol: "brain" }, keywords), null);

const reject = getRawPoolScreeningRejectReason(
  {
    name: "Trump Coin-SOL",
    token_x: { symbol: "Trump Coin", organic_score: 90, market_cap: 500000, created_at: 0 },
    token_y: { organic_score: 90 },
    tvl: 20000,
    active_tvl: 20000,
    volume: 50000,
    fee_active_tvl_ratio: 1,
    volatility: 3,
    base_token_holders: 5000,
    dlmm_params: { bin_step: 100 },
  },
  {
    minMcap: 80000,
    maxMcap: 5000000,
    minHolders: 100,
    minVolume: 1000,
    minTvl: 5000,
    minBinStep: 10,
    maxBinStep: 200,
    minFeeActiveTvlRatio: 0.1,
    minOrganic: 70,
    minQuoteOrganic: 50,
    blockedNameKeywords: keywords,
  },
);
assert.match(reject, /blocked theme/i);

console.log("test-blocked-theme: OK");