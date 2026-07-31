# GMGN API Rate Limits (Free Tier) — dari screenshot owner (2026-07-08)

Sumber: screenshot UI GMGN yg dikirim owner ke Telegram bot (tg_20260708_005513_3054.jpg), OCR.
Angka = kuota query per HARI (free tier). Ini PENTING karena bot pakai GMGN utk CPO + audit.

## Kuota per fitur (per hari)
- TOKEN:
  - info: 20
  - security: 20   <-- kritis: dipakai CPO (getGmgnTokenSecurity)
  - pool: 20
  - holders: 4     <-- SANGAT kritis: CPO proxy SM count (getGmgnTokenTopHolders)
  - traders: 4
- MARKET:
  - trending: 20
  - kline: 10
  - trenches: ~6.7
  - signal: ~6.7
- PORTFOLIO: info 20, token-bal 20, created-tok 10, holdings/activity/stats (?)

## Dampak ke Meridian
- Screening jalan tiap 15 menit (~96 siklus/hari). Tiap siklus ~10 kandidat ke-reject rugcheck
  -> CPO fetch security+holders utk SEMUA. Tanpa throttle = ratusan call/hari.
- Quota cuma 20 security + 4 holders/hari -> IP ke-BAN ("temporarily banned due to rate limit").
- Solusi: throttle + cache GMGN per token per hari (lihat gmgn.js / pool-memory).

## Rekomendasi
1. Cache GMGN security/holders di pool-memory (key = mint, TTL 24h).
2. CPO cuma eval token dgn prioritas (TVL layak), bukan semua reject.
3. Global GMGN call budget harian: max ~15 security + 3 holders (sisakan buffer).
