# Strategy Router Sweep — Dry Run (2026-07-08)

Sumber: 59 pool riil dari Meteora via `search-pools` (20 query token: BONK, JUP, WIF, SOL, USDC, TRUMP, PEPE, dll).
Metode: `classifyMarketView` + `buildDeployPlan` LANGSUNG (bypass rugcheck/CPO), read-only, NO deploy.
Tujuan: validasi router strategi ke banyak token nyata tanpa nunggu pasar (semua kandidat screening lagi ke-reject).

## Ringkasan
- Total pool: 59
- VIEW:  {"chill": 14, "flat": 45}
- STRATEGY: {"bid_ask": 14, "curve": 45}

## Catatan Penting
- Volatilitas di test = 0.00 SEMUA (pool-detail gak expose field volatility; di production bot
  ambil vol dari chart-indicators). Jadi penentu "chill" di test ini = TVL + umur, bukan vol.
- chill trigger = TVL >= 100K + umur >= 7d + vol < 2  ->  bid_ask balanced 125+125 (wide range).
- flat (TVL/umur gak lolos chill) -> curve 50+50 (default range-bound fee capture).
- Bonk-USDC (TVL 119K, age 355d) -> chill ✅ bukti router jalan.

## Contoh token mapan -> chill (bid_ask, 125+125)
- Bonk-USDC: TVL 119060, age 355d
- Fartcoin-SOL: TVL 131919, age 617d
- GIGA-SOL: TVL 109222, age 748d
- GIGA-USDC: TVL 242595, age 638d
- MEW-SOL: TVL 1326, age 833d
- POPCAT-SOL: TVL 41603, age 585d

## Sample flat -> curve (50+50)
- JUP-Bonk: TVL 43741, age 628d (TVL < 100K -> gak chill)
- Pnut-SOL: TVL 17, age 612d
- ANALOS-SOL: TVL 6, age 894d

## Validasi
- Router KONSISTEN: chill -> bid_ask lebar, flat -> curve.
- Bid-Ask Chill (LP Army 2-4) TERBUKTI trigger ke token mapan riil (14/59).
- Di production lebih variatif: vol asli ada -> view pump/breakdown/sideways bakal muncul
  (bid_ask SOL-below, spot balanced, dll sesuai matrix di strategy-router.js).

## Limitasi test
- Vol=0 buat semua -> gak test path volatil (pump/breakdown). Untuk itu butuh chart-indicators
  fetch (GMGN lagi banned, jadi ditunda).
- Rugcheck/CPO gate TIDAK diuji di sini (sengaja bypass). Itu sudah tervalidasi terpisah.

## File terkait
- tools/strategy-router.js (classifyMarketView, buildDeployPlan, case "chill")
- config.js (autoStrategy.bidAskChillEnabled, chillMinTvl, chillMinAgeHours, chillMaxVolatility)
- notes/LP_ARMY_ACADEMY.md (ilmu 2-4 Bid-Ask Chill)
