# Analisis Loss Pattern — Spot Strategy (Claude, 2026-07-05)

_Task dari Hermes 2026-07-04 19:07 UTC. Draft proposal — owner yang approve. Zero kode/config diubah._

## Data (31 closes di lessons.json performance)

| Statistik | bid_ask (20 closes) | spot (9 closes) |
|---|---|---|
| Loss terburuk | -1.99% | **-12.28% (FABLE -$10.12), -9.5% (SEMAN -$3.94)** |
| Total PnL USD | ≈ +$0.3 | ≈ -$9.9 (dgn 2 winner +$1.6/+$1.68) |

Semua loss besar = **spot**. bid_ask tidak pernah SL — dia OOR ke atas (harmless) atau low-yield exit kecil.

## Kenapa FABLE lolos gate (jawaban pertanyaan 1)

Deploy 08:29 UTC, spot balanced 55/55 (110 bin), view `pump` ("Strong upside momentum **34.33% 1h**, ST bullish"), fee/TVL **0.92%**, oor_risk 51.

1. **ATH gate TIDAK lolos — gate-nya MATI.** `user-config.json.bak.1783162357466` (config live saat deploy): `athEntryGateEnabled = 0`. Baru dinyalakan evil-panda.strict ~11:00 UTC. Bukan bug gate; drift config (SESSION_START table bilang `true`, live bilang `0`).
2. **Supertrend justru BULLISH di puncak pump** — classifyMarketView melihat +34% 1h + ST bullish → view `pump` → masuk. ST lagging; ini yang Evil Panda doctrine hindari (entry = fresh ATH breakout terkonfirmasi, bukan mid-pump).
3. **`maxPumpPct1h` cap TIDAK berlaku untuk spot** (structural bug): gate di `strategy-router.js:392-399` hanya fire kalau `plan.strategy === "bid_ask" && deposit_side === "sol_below"`. Plan pump-view = spot balanced → exempt by construction. +34.33% > cap 20 tapi tetap deploy.
4. **Pump path memaksa spot tanpa fee floor**: doktrin "spot hanya kalau fee bayar risikonya" (`spotFeeTvlMin`) cuma dicek di `applyHighFeeSpotBias`, TIDAK di pump/sideways/flat path. FABLE 0.92% << 2. Fees 137 menit cuma $2.22 vs IL -$12.
5. Mekanisme loss: spot 50/50 di puncak = ~50% deposit jadi token di local top → retrace -13% full in-range (range_efficiency 100) → IL >> fees → SL.

## Spot dipilih saat kondisi tidak cocok (jawaban pertanyaan 2)

Jalur yang menghasilkan spot + kasus mismatch nyata dari actions log:

| Jalur | Fee floor? | Pump/dump cap? | Kasus nyata |
|---|---|---|---|
| view `pump` → spot 50/50 | ❌ | ❌ (exempt) | FABLE 0.92% fee, +34% 1h → **-$10.12** |
| view `sideways` → spot 75/25 | ❌ | ❌ | SEMAN fee/TVL **0.37%** spot 48/16 |
| view `retracement` + `applyHighFeeSpotBias` flip ke spot | ✅ (1.5) | ❌ | SEMAN spot 62/20 **saat token dump -28.65% 1h** (catching falling knife dgn 25% token exposure) → kandidat kuat SL -9.5% |
| view `flat` (curve off) → spot | ❌ | ❌ | — |
| TGE override / volatile recall → spot | ✅/n.a. | — | OFF / by design |

Tidak ada gate arah-bawah sama sekali: `solRegimeGate` cuma SOL-wide, `maxPumpPct1h` cuma arah atas dan cuma bid_ask.

## ⚠️ Skenario FABLE MASIH BISA TERULANG di preset live (evil-panda.strict)

- `autoStrategyAllowSpot: true` → pump view tetap buka jalur spot.
- `maxPumpPct1h: 15` → tetap tidak berlaku untuk spot (bug #3).
- `spotFeeTvlMin: 2` → tetap tidak dipakai pump/sideways path (bug #4); `preferSpotHighFee: false` malah mematikan satu-satunya jalur yang PUNYA fee floor.
- ATH gate ON tapi **fail-open** saat indikator gagal — dan log 4 Jul penuh `Jupiter HTTP 429` berulang (16:30, 17:00, 17:20, 17:30, 18:10). Burst 429 = gate transparan.
- Deploy sekarang 2 SOL, SL -15% → **max loss per trade ~$24** (dulu ~$10).

## Proposal (draft — butuh owner approve)

### P1a — `maxPumpPct1h` berlaku semua strategi (fix paling impactful, ~5 baris)
`strategy-router.js`: hapus kondisi `plan.strategy === "bid_ask" && deposit_side === "sol_below"` → cap berlaku untuk SEMUA plan dgn `pump1h > maxPumpPct`. Spot mid-pump = top-ticking; kalau momentum memang valid, ATH gate yang memutuskan, bukan exempt jalur.
- FABLE (+34.33% vs cap 15/20) → **blocked**.

### P1b — Fee floor universal untuk spot (~10 baris)
Setelah `buildDeployPlan`: kalau `plan.strategy === "spot"` dan `fee_tvl_ratio < spotFeeTvlMin` → konversi ke bid_ask sol_below (atau skip kalau view pump). Doktrin yang sudah ada, tinggal dipindah dari bias path ke semua path.
- FABLE (0.92 < 2) blocked; SEMAN sideways (0.37) blocked.

### P1c — Dump gate untuk spot (simetri P1a, ~5 baris) — ✅ DONE (Claude, 2026-07-07)
`plan.strategy === "spot"` dan `price_change_1h < -maxPumpPct1h` → block. Retracement bid_ask-below (ladder buy) tetap boleh — itu by design; yang diblok cuma spot (exposure token langsung) ke dalam dump aktif.
- SEMAN spot saat -28.65% 1h → **blocked**.
- Implementasi: `applySpotDumpGate()` di `tools/strategy-router.js`, di-wire setelah `applySpotFeeFloor`. Test: `test/test-strategy-matrix.js::testSpotDumpGate` (replay fixture SEMAN -28.65%, semua 5 test suite pass). Daemon restarted 2026-07-07 07:38 UTC, aktif live.

### P2a — ATH gate fail-closed + 429 hardening — ✅ DONE (Claude, 2026-07-07)
Config baru `athGateFailMode: "open"` (default, kompatibel, live sekarang) / `"closed"` (preset `evil-panda.strict.json` diupdate ke ini). Plus: 1x retry (max 2 attempt, budget 8s) pada 429/5xx via `agentMeridianJson`'s existing retry option (sebelumnya gak dipakai di `fetchChartIndicatorsForMint`) + cache respons indikator per mint 150s (`config.indicators.cacheTtlSec`), dengan sweep otomatis biar cache gak growth-unbounded di proses daemon multi-hari.
- Implementasi: `resolveAthGateOutcome()` (pure, testable) + cache/retry di `tools/chart-indicators.js`. Test: `test/test-strategy-matrix.js::testAthGateFailMode` (pass/fail/unavailable × open/closed matrix). Semua 5 test suite pass.
- **Catatan penting:** live `user-config.json` TIDAK otomatis dapet `athGateFailMode`, defaultnya `"open"` (no behavior change) sampai owner eksplisit set `"closed"` atau re-apply preset (`npm run preset:evil-panda`). Cache+retry 429 hardening-nya aktif sekarang juga (gak butuh opt-in).
- Daemon restarted 2026-07-07 07:50 UTC, aktif live.

### P2b — Normalisasi boolean config — ✅ DONE (Claude, 2026-07-07)
`athEntryGateEnabled: 0` (number) lolos sebagai falsy — kebetulan benar, tapi `"0"` (string) akan jadi truthy. Coerce boolean di config load / CONFIG_MAP.
- Implementasi: `boolConfig(value, default)` helper (exported) di `config.js` — handle boolean/number/string ("0"/"false"/"no"/"off" → false, "1"/"true"/"yes"/"on" → true, case/whitespace-insensitive), unrecognized value fail-safe ke default (bukan blind `Boolean()` cast). Diterapkan ke **34 flag boolean** di seluruh `config.js` (semua pola `u.xFlag ?? default` dan `u.xFlag !== false` lama), termasuk 1 duplicate key (`exitRule3ConditionsEnabled`, sudah ada sebelumnya, dibiarkan — di luar scope P2b).
- Test: `test/test-config-bool.js` (unset/real-boolean/number/string-bug-fix/unrecognized-fail-safe). Semua 20 test file di repo pass, gak ada regresi.
- Daemon restarted 2026-07-07 08:05 UTC, aktif live.

### Alternatif config-only (tanpa kode, bisa sekarang oleh Hermes/Grok + owner)
`autoStrategyAllowSpot: false` → pump view otomatis skip ("spot disabled, skip"), sideways/flat fallback bid_ask. Menutup FABLE+SEMAN sekaligus, trade-off: kehilangan winner spot (BABYANSEM +$1.6, DR TRUMP +$0.58, SEMAN +$1.68). Net historis spot = **negatif** (-$9.9), jadi ini defensible sampai P1a-c masuk.

## Prioritas
1. **P1a + P1b + P1c** — satu PR kecil di strategy-router, pure function, gampang di-test (replay FABLE/SEMAN args dari actions log sebagai fixture).
2. **P2a** — gate reliability; tanpa ini ATH gate bolong saat 429 burst.
3. Interim hari ini: alternatif config-only kalau owner mau proteksi sebelum kode masuk.
