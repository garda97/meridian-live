# CONFIG UPDATE — 2026-07-02 18:50 UTC

## Reason
0.2 SOL lost pada world-SOL close due to:
- Token pump far above range (out-of-range)
- Auto-swap base token (WORLD) → SOL with high slippage
- Result: 0.2 SOL → 0.08-0.1 SOL (5-10% loss)

## Changes Applied

### 1. Entry Criteria (lebih ketat)
```
minTvl:        5000  → 10000   (min liquidity lebih besar)
maxTvl:        200k  → 150k    (avoid overhyped pools)
minVolume:     300   → 500     (better trading depth)
minOrganic:    50    → 60      (higher quality)
minQuoteOrganic: 50  → 60      (stricter filtering)
minHolders:    300   → 500     (wider distribution)
minMcap:       100k  → 200k    (avoid micro-cap pump)
maxMcap:       10M   → 5M      (focus mid-cap, avoid mega pump)
```

### 2. Token Age (prevent flash-pump)
```
minTokenAgeHours: null → 2     (minimum 2 hours old before deploy)
```

### 3. Out-of-Range Handling (lebih aggressive close)
```
outOfRangeWaitMinutes: 30 → 15  (close faster, avoid long wait with slippage)
oorCooldownTriggerCount: 3 → 2  (lower threshold to trigger cooldown)
```

### 4. Exit Strategy (tighter stops + earlier trailing)
```
stopLossPct:        -15  → -12      (stop loss lebih ketat)
trailingTriggerPct: 3    → 2.5      (activate trailing lebih cepat)
trailingDropPct:    2    → 1.5      (tighter trail profit lock)
minFeePerTvl24h:    7    → 8        (higher quality fee pools)
minAgeBeforeYieldCheck: 60 → 45     (faster into fee accumulation)
```

### 5. Auto-Swap (already enabled)
```
autoSwapAfterClaim: false → true   (auto-swap base token → SOL)
```

## Expected Impact

✅ **Prevent slippage loss:**
- Better liquidity entry (minTvl +100%)
- Faster exit on out-of-range (15 vs 30 min)
- Established tokens only (2h age minimum)

✅ **Tighter risk management:**
- Stop loss -12% vs -15% (cut losses quicker)
- Trailing at +2.5% vs +3% (lock profits sooner)
- Avoid micro-caps (minMcap 2x higher)

✅ **Better quality pools:**
- Higher organic scores (60 vs 50)
- More holders (500 vs 300)
- Mid-cap focus (avoid mega-pump, avoid dust)

## Status
- ✅ Config updated
- ✅ Daemon restarted
- ✅ Monitoring crons active
- Next: Daemon will screen with new filters

**Going forward:** Better entry quality + faster exit on trouble = less slippage, less loss
