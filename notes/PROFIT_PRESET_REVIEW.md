# Profit Preset Review — Handoff ke Hermes & Claude

_Updated: 2026-07-03 | Author: Grok | Commit: `2ddfea2`_

## Konteks

Owner minta review profit-focused config + code changes sebelum "gas live" lagi.
Semua service **OFF**, wallet ~**1.375 SOL**, **0 posisi** terbuka.

---

## 1. Config diff — profit preset (`user-config.json`)

| Parameter | Sebelum (learning) | Sekarang (profit) | Alasan |
|-----------|-------------------|-------------------|--------|
| `deployAmountSol` / `maxDeployAmount` | 0.2–0.35 | **0.5** | Fokus 1 pool berkualitas |
| `maxPositions` | 2–3 | **1** | Konsentrasi modal, kurangi redeploy noise |
| `minOrganic` / `minQuoteOrganic` | 55–60 | **70** | Filter pool lebih bersih |
| `minFeeActiveTvlRatio` | 0.008–0.05 (evolved) | **0.02** | Balance yield vs volume kandidat |
| `minClaimAmount` | 0.5 | **2** | Kurangi claim spam, fee meaningful |
| `trailingTriggerPct` / `trailingDropPct` | 3.0 / 1.0 | **1.5 / 0.8** | Lock profit lebih cepat (DR TRUMP lesson) |
| `timeframe` | 5m (broken) → 1h | **1h** | Fix 0 kandidat; 5m+minVol 400k = kosong |
| `minVolume` | 400000 | **15000** | Sesuai timeframe 1h |
| `lossRedeployBlockEnabled` | — | **true, 24h** | Block redeploy pool yang baru loss |
| `autoStrategyPreferSpotHighFee` | — | **true, min 2** | Bias spot saat fee/TVL ≥ 2 |
| `_filterRelaxCount` | — | **0** (reset) | Fresh start setelah preset |

**Tes screening profit preset:** 1 kandidat lolos — FABLE-SOL (organic 80, fee/TVL 1.53, di bawah floor 0.02 tapi lolos karena edge case autotune/evolution).

---

## 2. Code changes — commit `2ddfea2`

### A. `filter-autotune.js` — auto-relax threshold
- Setelah **2x consecutive NO DEPLOY**, relax threshold ×0.85
- Floors **timeframe-scaled** via `screening-scales.js` (fix bug: 5m floor minVolume ~250, bukan 300k)
- Hook di `index.js` `runScreeningCycle` finally block

### B. `pool-memory.js` + `config.js` — loss redeploy block
- Pool yang ditutup loss → block redeploy **24 jam**
- Config: `lossRedeployBlockEnabled`, `lossRedeployCooldownHours`

### C. `tools/strategy-router.js` — spot bias
- `autoStrategyPreferSpotHighFee: true` + `autoStrategySpotFeeTvlMin: 2`
- Saat fee/TVL ≥ 2, prefer `spot` over `bid_ask`

### D. `tools/chart-indicators.js` + `index.js` — chart exit wiring
- Exit preset `bb_plus_rsi` (RSI2 > 90 + close above BB upper) di PnL poller
- `chartIndicators.enabled: true`, intervals 5m + 15m

### E. `discord-listener/` — bot token mode (skipped)
- Owner bukan admin server Garda → tidak dipakai

### F. Infra
- `meridian-daemon.service` systemd unit (auto-restart)
- Semua service sekarang OFF per owner request

---

## 3. Performance data (16 closes)

| Metric | Value |
|--------|-------|
| Win rate | **56.3%** (9/16) |
| Avg PnL | **+0.08%** |
| Best trade | **DR TRUMP-SOL** spot +2.37%, fees $0.84, 21 menit |
| Worst pattern | **CATWIF-SOL** bid_ask 3x redeploy → OOR/low yield |
| All-time fees | ~$0.48 net |

**Lesson tersimpan:** prefer DR TRUMP-type spot pools (vol ~5.7, bin_step 100, fee/TVL tinggi, 100% in-range).

---

## 4. Pertanyaan untuk Hermes (strategy/risk)

1. **maxPositions=1 + 0.5 SOL** — apakah risk/reward cocok untuk fase profit, atau perlu 2 posisi diversifikasi?
2. **minFeeActiveTvlRatio=0.02** vs evolved 0.05 — mana yang lebih konsisten dengan DR TRUMP winner?
3. **Trailing 1.5%/0.8%** — terlalu agresif lock profit atau pas untuk vol memecoin?
4. **Spot bias fee/TVL ≥ 2** — approve untuk default strategy routing?
5. **Loss redeploy block 24h** — cukup atau perlu 48h untuk CATWIF-type pools?
6. **Screening 1h + minVol 15k** — apakah cukup kandidat harian atau perlu autotune lebih agresif?
7. **Gas live?** — owner belum bilang "gas live" setelah profit preset. Rekomendasi go/no-go?

---

## 5. Pertanyaan untuk Claude (engineering)

1. **Commit `2ddfea2`** — review spot bias logic di `strategy-router.js`, ada edge case?
2. **Loss redeploy block** di `pool-memory.js` — race condition kalau screening parallel?
3. **Chart exit `bb_plus_rsi`** di PnL poller — wiring benar? conflict dengan trailing TP?
4. **filter-autotune timeframe floors** — regresi vs `evolveThresholds()` di lessons.js?
5. **Bug/regresi** — ada yang perlu fix sebelum gas live?
6. **Test coverage** — `test/test-filter-autotune.js` cukup atau perlu integration test?

---

## 6. State saat ini

```
Wallet:     ~1.375 SOL
Positions:  0
Services:   ALL OFF (daemon, 9router, dashboard)
Git:        github-main @ 2ddfea2 (clean)
Phase:      learning_dry_run → profit preset applied, belum live
```

---

_Baca file ini + `notes/HANDOFF.md` sebelum respond. Tulis handoff balik ke Grok dengan approve/tweak/reject per poin._