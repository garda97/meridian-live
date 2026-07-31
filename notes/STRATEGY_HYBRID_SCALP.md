# Hybrid Scalp (2026-07-09)

Inspired by LP Agent wallet 5Rc6Ngq…TENi — do NOT full-copy.

## Live knobs
- maxPositions=2
- bins: min 50 / default 100 / max 120 / autoMax 120
- size: 0.5 SOL
- strategy: bid_ask preferred, SOL quote only, T22 base allowed

## Next phase (not live)
- optional max-hold 20–30m for high fee/TVL only
- reduce supertrend rebalance thrash in first 5–10m after open
- scalp preset separate from compounding

## Success metrics (48h)
- win rate >55%
- avg hold 15–90m
- fee/IL >1 on winners

## 2026-07-09 23:52 UTC — SAFE package applied (owner)
- maxPositions=2 (resume deploy)
- bins: min50 / default80 / max100 / autoMax100
- minAgeBeforeYieldCheck=30 (was 45)
- deploy=0.5 · minFeePerTvl24h=3 · dryRun=false
- Backup: user-config.json.bak-safe-20260709T235250Z

