# Strategy Router — Full Matrix Validation (2026-07-08)

Synthetic test (no network, no GMGN) — 8 kasus mencakup SELURUH market view.
Semua PASS (8/8). Router terbukti konsisten ke semua kondisi.

## Hasil
| Kondisi | Expected | Got | Strategi | Side | Bins |
|---------|----------|-----|----------|------|------|
| Mapan (TVL>100K, umur>7d, vol<2) | chill | chill | bid_ask | sol_balanced | 125+125 |
| Flat low-vol (TVL kecil) | flat | flat | spot | sol_balanced | 65+22 |
| Sideways vol 3 (2-6) | sideways | sideways | spot | sol_balanced | 92+31 |
| Pump 1h>15 bullish | pump | pump | spot | sol_balanced | 53+52 |
| Breakdown bearish | breakdown | breakdown | bid_ask | sol_below | 250+0 |
| Retracement 1h<-15 | retracement | retracement | spot | sol_balanced | 113+37 |
| Chill gagal (TVL kecil) | flat | flat | spot | sol_balanced | 59+19 |
| Chill gagal (muda) | flat | flat | spot | sol_balanced | 59+19 |

## Kesimpulan
- Router KONSISTEN di semua view: chill, flat, sideways, pump, breakdown, retracement.
- Bid-Ask Chill (LP Army 2-4) trigger PRESISI: cuma token mapan (TVL>=100K + umur>=7d + vol<2).
- Guard chill bekerja: TVL kecil / muda -> fallback flat (curve/spot), gak chill.
- Breakdown -> bid_ask SOL-below max width (250 bins) = sesuai desain FABLE/script.
- Pump -> spot balanced (NEVER bid_ask SOL-below, cegah OOR naik).
- Sideways/retracement/flat -> spot balanced (fee capture + DCA).

## Gabungan dengan STRATEGY_SWEEP_2026-07-08.md
- Sweep (59 pool riil): chill 14 / flat 45 (vol=0 di test, jadi cuma path mapan/flat).
- Matrix ini: lengkapi path volatil (pump/breakdown/sideways) yang gak ke-test di sweep.
- Total coverage: 100% market view tervalidasi.

## Sisa yang butuh GMGN (ban lepas)
- CPO rescue end-to-end (concentrationParadoxOverride) ke token konsentrasi tinggi
  tapi renounced + lp_burned + SM kuat.
- chart-indicators fetch buat signal asli (supertrend break, RSI) di production.

File: tools/strategy-router.js (classifyMarketView, buildDeployPlan)
