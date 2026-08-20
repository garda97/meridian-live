# GMGN API Rate Limits — saat ini private key (bukan free tier)

Catatan lama free-tier (20 security / 4 holders per hari, screenshot 2026-07-08)
sudah usang: `GMGN_API_KEY` skrg berformat `v2:...` (private key), kuota
~500-1000 security & ~500-1000 holders per hari.

## Kuota aktual (private key)
- holders: ~500-1000/hari
- security: ~500-1000/hari

## Dampak ke Meridian
- Screening tiap 15 mnt (~96 siklus/hari) → CPO fetch security+holders utk kandidat.
- Cap harian di `tools/gmgn.js` (`GMGN_DAILY_CAP`) dinaikkan 18/3 → **100/50**
  (kode commit 2026-08-07) biar screening gak kehabisan quota & kena IP ban.
- Tetap throttle + cache per mint TTL 24h biar gak boros / kena ban.
- Kalau budget exhaustion masih muncul di log, naikkan lagi (batas private key jauh
  di atas 100/50).

Referensi: `notes/GMGN_RATE_LIMITS.md` (lama, free-tier), `grep GMGN_DAILY_CAP tools/gmgn.js`.