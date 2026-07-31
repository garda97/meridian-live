# CPO Rescue Test — End-to-End (2026-07-08, GMGN ban lifted)

GMGN ban SUDAH LEPAS (test 02:03 WIB: top10=21.27% renounced=true dapet data asli).
Test: jalankan concentrationParadoxOverride ke 4 token yang tadi ke-reject rugcheck (top10>25%).

## Hasil
| Token | top10 rugcheck | mintRenounced | lpBurned | smCount | CPO |
|-------|---------------|---------------|----------|---------|-----|
| CHANCE-SOL | 47% | false | false | 0 | REJECT (fundamentals/SM insufficient) |
| NEIL-SOL | 73.1% | false | false | 0 | REJECT |
| traindog-SOL | 55.4% | false | false | 0 | REJECT |
| ok-SOL | 47.9% | (budget skip) | - | - | REJECT (daily holders budget exhausted) |

## Temuan
1. CPO JALAN BENER ke data GMGN asli: cek mintRenounced/freezeRenounced/lpBurned/devBurned/
   noAlert/noRugFlags/smCountOk semua dievaluasi. Token sampah gagal karena emang gak layak.
2. BUDGET GUARD BEKERJA: token ke-4 -> "daily holders budget exhausted; skipping".
   Cap 3 holders/hari aktif -> anti-ban terbukti.
3. Pasar sekarang penuh token sampah -> CPO gak rescue (bukan bug, emang gak layak).
   "No trade > bad trade" terbukti di production.

## Status Validasi Strategi (lengkap)
- Matrix synthetic 8/8: PASS (chill/flat/sideways/pump/breakdown/retracement)
- Sweep 59 pool (via search-pools): chill 14 / flat 45
- CPO rescue end-to-end: JALAN, fail-closed benar ke token sampah
- GMGN budget guard: AKTIF (anti-ban)
- Bid-Ask Chill: AKTIF (bug umur fixed)

Bot SIAP production. Tinggal nunggu pasar kasih token layak (top10<=25% atau
konsentrasi tinggi TAPI renounced+lp_burned+SM kuat).
