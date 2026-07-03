# Claude Improvement Brief — Meridian Bot Hardening

_Updated: 2026-07-03 | Author: Grok | Daemon: **STOPPED** for implementation_

## Konteks live (sesi 2026-07-03)

| Trade | Pool | Hasil | Catatan |
|-------|------|-------|---------|
| #1 | FABLE-SOL | **+0.19%** | OOR pump atas, bid_ask 0% upside, RULE_3 close |
| #2 | FABLE redeploy | **FAILED** | `0x1774` ExceededBinSlippageTolerance |
| #3 | yep-SOL | **+0.26%** | 30m hold, low yield close |
| Best all-time | DR TRUMP | **+2.37%** | spot, 100% in-range |

**Wallet:** ~1.37 SOL | **maxPositions:** 1 | **deploy:** 0.5 SOL

## Sudah diterapkan (jangan regresi)

- Profit preset + Level 1 agresif (`minOrganic` 60, `minFeeActiveTvlRatio` 0.03)
- OOR quick wins: `maxBinsBelow` 100, `defaultBinsBelow` 80, `spotFeeTvlMin` 1.5, pump gate 20%
- Spot bias gated (tidak override breakdown/pump) — commit `593e742`
- filter-autotune evolve-owned split — commit `593e742`
- OOR pump gate + wider bins — commit `dfaec48`

## P0 — Deploy lebih pintar (implement first)

### 1. Fresh bin refresh pre-deploy
Sebelum `deploy_position` tx: fetch `active_bin` ulang, recalc `bins_below/above` dari harga sekarang (bukan snapshot kandidat 30s+ lalu).

**Files:** `tools/dlmm.js`, `tools/strategy-router.js`, `agent.js` deploy path

### 2. Simulation retry ladder on `0x1774`
```
deploy sim fail 0x1774 →
  retry 1: shift range to fresh active bin
  retry 2: shrink bins ~15%
  retry 3: fallback spot (if fee/TVL ≥ spotFeeTvlMin)
  else: skip + log pool-memory note
```

**Files:** `tools/dlmm.js`, `pool-memory.js`

### 3. Explicit strategy matrix
| Market view | Strategy | Deposit | Notes |
|-------------|----------|---------|-------|
| pump >15% | skip or spot | balanced | NOT bid_ask SOL below |
| retracement | bid_ask wide | SOL below | fib-scaled bins |
| sideways | spot | 75/25 | default |
| breakdown | bid_ask wide | SOL below | max bins |

**Files:** `tools/strategy-router.js` — extend `buildDeployPlan` + `classifyMarketView`

## P1 — Screening lebih tajam

### 4. Rugcheck in main pipeline
Hook `rugcheck.xyz` di `tools/screening.js` (sekarang cuma `discord-listener/pre-checks.js`).
Ref: `notes/METEORA_LP_REVIEW.md` §B

### 5. OOR risk score
```
oor_risk = f(volatility, priceChange1h, strategy, bins_total, upside_cover_pct)
```
Skip deploy kalau `oor_risk > threshold` meski lolos filter dasar.
Log score ke `decision-log.json`.

### 6. Pool-memory redeploy cooldown after win+OOR
FABLE pattern: menang (+0.19%) tapi volatile OOR → block redeploy same pool 2–4h.

## P2 — Exit & observability

### 7. Chart exit PnL gate
`checkPositionChartExit` — require `pnl_pct > 0` sebelum fire CHART_EXIT (Claude review finding).

### 8. Decision-log structured fields
Per entry: `exit_signal_type`, `bins_used`, `upside_cover_pct`, `oor_risk`, `holder_audit_snapshot`

### 9. Unit tests
- `applyHighFeeSpotBias` / pump gate / strategy matrix
- pool-memory cooldown stacking (max not overwrite)
- deploy retry on simulated 0x1774
- filter-autotune vs evolveThresholds no regression

## Constraints

- Wallet 1.37 SOL — jangan naik `deployAmountSol` tanpa owner approve
- Jangan longgarkan security filter (top10, bundler, organic) tanpa comment + owner OK
- Run `npm test` + `node test/test-filter-autotune.js` sebelum handoff balik
- **Daemon STOPPED** — aman edit code; Grok restart setelah review

## Verdict format

Per PR: **SAFE TO DEPLOY / FIX FIRST / BLOCKED** + severity P0/P1/P2

## Handoff balik ke Grok

```bash
python3 scripts/agent_sync.py handoff \
  --from claude --to grok \
  --summary "P0/P1 implementation selesai — [verdict]" \
  --tasks "Grok: review diff, npm test, restart daemon jika SAFE"
```