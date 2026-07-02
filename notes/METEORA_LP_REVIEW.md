# METEORA_LP.md vs Repo Sekarang — Review Claude (rekomendasi saja, belum ada file yang diubah)

_Dibuat: 2026-07-02, oleh Claude, atas request owner._

## A. Sudah selaras (no action needed)

| Notes | Repo sekarang |
|---|---|
| "80/100/125 bin pool" | `minBinStep: 80`, `maxBinStep: 125` — persis match |
| "fees > 30" (GMGN) | `minTokenFeesSol: 20-30` — searah |
| RSI(2) | `config.indicators.rsiLength: 2` — persis match |
| Rugcheck + GMGN double-screen | `tools/gmgn.js` (bundler/smart_degen/sniper/fresh_wallet tags, top10 holder pct, burn/mint-renounce) sudah ada dan lebih detail dari yang disebut notes |
| Exit confluence (Supertrend + RSI/BB) | `tools/chart-indicators.js` sudah punya preset `rsi_plus_supertrend`, `supertrend_or_rsi`, `bb_plus_rsi` — konsepnya sudah ada |

## B. Gap — metrics yang notes sebut tapi belum ada field-nya di repo

- **phishing_pct** — tidak ditemukan di manapun (`tools/gmgn.js`, `tools/token.js`).
- **insiders_pct** — tidak ada. `dev_count`/`sniper_count` di gmgn.js beda konsep, bukan pengganti insider%.
- **bluechip_pct** — tidak ada.
- **fresh_wallet / bundled_wallet ratio terhadap total holders** — gmgn.js baru simpan `fresh_wallet_count` (angka mentah), belum dihitung sebagai rasio % terhadap holders seperti checklist notes poin 10-11.
- **rugcheck.xyz** — hanya dipakai di `discord-listener/pre-checks.js` (untuk signal dari Discord bot). Pipeline utama (`tools/screening.js` → `getTopCandidates`, yang dipakai SCREENER role) **tidak** pernah panggil rugcheck. Jadi "screening ganda: rugcheck dulu baru GMGN" di notes belum diterapkan di jalur screening otomatis utama.
- **MACD** — tidak ada indikator MACD sama sekali di `tools/chart-indicators.js`, padahal notes sebut histogram MACD sebagai salah satu sinyal exit.
- **Time-of-day gate** ("jangan buka posisi setelah jam 6 malam") — tidak ada logic berbasis jam di `index.js`/`tools/screening.js` sama sekali.

## C. Divergensi angka (config vs notes) — worth a discussion, bukan langsung diubah

| Field | Config sekarang | Notes bilang | Catatan |
|---|---|---|---|
| `maxTop10Pct` | 60% | <30% (GMGN checklist) | Gap besar — config jauh lebih longgar |
| `minVolume` | 300-500 | ≥1,000,000 (Dexscreener filter) | Gap ~2000x, tapi kemungkinan notes ini untuk filter kasar manual sebelum threshold lain (fee/TVL, organic) masuk — perlu klarifikasi apakah dimaksudkan sama |
| `minMcap` | 100k-150k | ~250k | Beda tapi masih sepadan |
| `maxBinsBelow` | 69 | 200-250 (untuk deep-correction play -90% s/d -97%) | **Kapabilitas wide-range sudah ada** di `tools/dlmm.js` (multi-tx `createExtendedEmptyPosition` untuk >69 bins), tapi config ceiling `maxBinsBelow: 69` mencegah SCREENER pernah minta range seluas itu. Kalau mau adopsi "Evil Panda / Final Exam" play dari notes, perlu naikkan `maxBinsBelow` — approve dulu, test di dry run karena wide-path pakai jalur tx berbeda. |
| `rsiOverbought` | 80 | 90 (upper limit eksplisit di notes) | Kecil tapi konkret |
| `maxPositions` | 3 | "minimal 6 posisi" (diversifikasi risiko) | Notes eksplisit minta lebih banyak posisi kecil-kecil, config sekarang cuma 3 |
| `config.gmgn.maxBundlerTop100Pct` | `null` (OFF by default) | bundling < 60% harus jadi hard filter | Fitur sudah ada di kode tapi **tidak aktif** kecuali di-set manual di user-config/gmgn-config.json |

## D. Konsep di notes yang belum ada tempatnya sama sekali

- **DCA IN / Buy More SOL** via DLMM (pool SOL-USDC, SPOT, 70 bins) — ini strategi akumulasi SOL, bukan deploy meme-coin. Tidak match dengan 5 strategi default di `strategy-library.js` (`custom_ratio_spot`, `single_sided_reseed`, `fee_compounding`, `multi_layer`, `partial_harvest`) — semuanya untuk posisi meme-coin. Bisa jadi kandidat strategi ke-6 kalau owner mau.
- **Reward system harian** (boleh nambah posisi kalau kemarin gak loss) — disiplin manual trader, tidak ada logic otomatis untuk ini dan sepertinya gak perlu diotomasi.

## E. Rekomendasi field baru (BELUM dieksekusi, nunggu approve owner)

**Kandidat masuk `screening` di `user-config.json`:**
- `maxInsidersPct`, `maxPhishingPct` — syaratnya GMGN API harus expose field ini dulu (perlu cek payload mentah `/v1/market/token_top_holders` apakah ada tag yang bisa dipetakan ke "insider"/"phishing", karena `tools/gmgn.js` saat ini cuma summarize tag `bundler`/`smart_degen`/`sniper`/`dev`/`fresh_wallet`).
- `freshWalletHolderRatioMax`, `bundledWalletHolderRatioMax` — ubah `fresh_wallet_count`/`bundlers_in_top_100` di gmgn.js jadi rasio % terhadap total holders, bukan cuma count mentah.
- `rugcheckMaxScore`, `rugcheckTop10Max` — kalau mau aktifkan rugcheck juga di `tools/screening.js` (bukan cuma discord-listener).
- `noDeployAfterHour` (mis. 18 = jam 6 sore) — gate waktu sesuai notes bagian "Emotions & Risk Management".

**Kandidat masuk `decision-log.json` (skema per-entry, biar Hermes gampang parse tanpa baca reason-blob):**
- `exit_signal_type` — indikator mana yang trigger exit (supertrend/rsi/bb/macd/confluence).
- `bins_used` + `correction_target_pct` — range yang dipakai vs target koreksi yang diantisipasi (bukan cuma di state.json, biar kelihatan di decision log juga).
- `holder_audit_snapshot` — ringkasan top10Pct/bundlerPct/freshWalletPct saat deploy, biar retro-analysis (notes bagian "Data & Disiplin Screening": "catat semua coin yang di-scan") bisa dilakukan dari decision-log tanpa gali state.json + lessons.json terpisah.

## Kesimpulan singkat

Fondasi filter (bin step, fee floor, GMGN holder audit, exit-indicator presets) sudah cukup dekat dengan metodologi di notes. Gap terbesar: (1) rugcheck tidak jalan di pipeline screening utama, (2) `maxBinsBelow` config membatasi wide-range deep-correction play yang notes anjurkan, (3) beberapa metrics granular (phishing/insider/bluechip %, ratio fresh/bundled-to-holders) belum ada field-nya sama sekali di GMGN wrapper, (4) `maxPositions:3` lebih agresif/terkonsentrasi dibanding anjuran notes "minimal 6 posisi". Semua di atas murni rekomendasi — tidak ada file kode/config yang diubah.
