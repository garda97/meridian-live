# Meteora DLMM — Catatan Pelajaran

## Konsep Dasar
- DLMM = Meteora DLMM LP.
- Tujuan: filter koin buruk, ambil fee dari koin yang lebih aman.
- Harap ingat: 99% meme coin pada akhirnya bisa rug; jangan hold terlalu lama.

## Strategi LP
- Lakukan screening ganda: rugcheck dulu, lanjut GMGN jika lolos.
- Jika koin pass rugcheck 1/100 tapi ada anomaly, tetap bisa dilanjutkan cek GMGN.
- Red flag banyak: pakai pool lebih besar dari biasanya atau hindari.
- Kalau bukannya anti-rug tapi FOMO menggoda, tetap ingat untuk exit early setelah fee tercetak.

## Screening Checklist (LogicalTA-style)
1. Top holder % — hindari jika terlalu tinggi untuk coin baru.
2. Jumlah holders — ideal: 500–3000 untuk coin baru.
3. MC/holder — semakin tinggi semakin berisiko.
4. Insiders % — red flag jika lebih dari 5%.
5. Phishing % — red flag jika lebih dari 30%.
6. Bundler % — red flag jika lebih dari 30%.
7. Bluechip % — red flag jika kurang dari 0.5%.
8. Fresh wallets — kurang dari 100 adalah peringatan.
9. Bundled wallets — kurang dari 100 adalah peringatan.
10. Fresh wallets / holders — red flag jika lebih dari 40%.
11. Bundled wallets / holders — red flag jika lebih dari 40%.
12. Tipe red flag dari rugcheck jika ada.

## Red Flags
- Top holder terlalu besar.
- Holders terlalu sedikit atau terlalu banyak dari 500–3000.
- Insiders, phishing, bundler di atas threshold.
- Bluechip terlalu rendah.
- Fresh/bundled wallets terlalu sedikit.
- Rasio fresh/bundled terhadap holders di atas 40%.
- Coin terlalu “bersih” pada GMGN tanpa ikonizes lain seperti phishing, axiom, whales, bundled, sementara bluechip menghindari.

## Catatan Adaptasi Ke Project
- Buat dan sesuaikan pipeline screening agar cover checklist ini.
- Integrasi rugcheck + GMGN holder metrics jika belum.
- Evaluasi threshold yang sesuai dengan profil project Meridian.

## Pemilihan Pool DLMM
- Strategi utamanya: DLMM untuk dump orang lain, bukan cuma volume churn.
- Target: pilih range yang masih in-range saat koreksi terjadi, agar fee tetap cetak dan IL terkontrol.
- Jangan otomatis pakai pool TVL tertinggi; pilih berdasarkan perkiraan besar koreksi.

## Metode LogicalTA Pool Selection
1. Chart timeframe: 15 menit.
2. Tambah indikator Supertrend.
3. Tambah Fib retracement dari titik tertinggi, bottom price di-set ke 0.
4. Edit level Fib menjadi 0.51, 0.43, 0.27, 0.19.
5. Estimasi bin range:
   - 0.51 → 100 bins one-sided SOL
   - 0.43 → 125 bins one-sided SOL
   - 0.27 → 200 bins one-sided SOL
   - 0.19 → 250 bins one-sided SOL

## Aturan Pemilihan Range
- Lihat posisi support dari Supertrend.
- Pilih bin range yang sedikit di bawah support Supertrend, karena harga bisa breakdown.
- Jika support berada di atas level 0.43 tapi di bawah 0.27, lebih aman memilih 0.27 → 200 bins.
- Semakin besar pump sebelumnya, semakin besar kemungkinan koreksi; pakai range lebih besar.
- Coin baru: biasa pakai fee pool 10%.
- Pada coin volatile: range lebih besar = lebih aman dari IL saat koreksi besar.

## Catatan Tambahan
- Fib dihitung dari high terbaru karena volume dan likuiditas biasanya maksimal dulu saat breakout/new high.
- Ini adalah strategi retracement: menyediakan tempat dump dan mengambil fee.
- Hunter pool harus tetap punya coin yang bagus menurut screening sebelumnya.
- Jika ada fitur bin lebih luas di masa depan, range 80% koreksi bisa jadi lebih mudah dengan bins lebih kecil.

## Exit Strategy DLMM (Refined)
- Tidak ada sistem sempurna, tapi pola umumnya: exit saat ada **pump pertama** setelah **supertrend support break**.
- Prioritas tetap **exit di green candle** kalau memungkinkan.
- Jika koin jelas rugg, keluar cepat walau di red bar untuk minimize loss.

## Indikator Keluar
- **Supertrend**: primary filter. Selama support masih hold, posisi boleh terus cetak fee. Begalau break, mulai waspada dan cari keluar.
- **RSI(2), UpperLimit 90**: setelah supertrend support break, tunggu RSI(2) naik/close di atas 90, lalu exit. Ini membantu keluar saat momentum pump masih kuat.
- **MACD**: setelah supertrend support break, histogram biasanya negatif. Exit saat histogram mulai naik dan close di green histogram pertama. Bisa memegang top lebih cepat dari RSI(2) dalam kondisi tertentu.
- **Bollinger Bands**: setelah supertrend support break, exit saat price spike/close di atas BB Upper Line. Biasanya ocorre karen harga 2 std dev dari MA20, lalu sering terjadi sell-off.

## Urutan Eksekusi Exit
1. Stay in DLMM sampai supertrend support pecah.
2. Kalau masih oke, tunggu salah satu sinyal exit: RSI(2) > 90, MACD histogram green, atau price close di atas BB Upper.
3. Close di green candle / pump untuk minimize slippage.
4. Jika semua indikator lambat, tetap prioritize cut loss sebelum convert ke deeper drawdown.

## Visual Referensi
- Thread ini mengganti metode exit sebelumnya dengan pendekatan indikator ganda.
- Setiap contoh chart menunjukkan sinyal exit di resistansi pertama, bukan menunggu recovery sempurna.

## Catatan Penting
- Coin selection tetap paling utama; indikator bagus tidak bisa menolong coin buruk.
- Likuiditas early meme coin rendah; 1% holder sell bisa memecah support dan memicu cascade.
- Safe range DLMM tetap diperlukan untuk mengurangi dampak false break.
- Bisa menggabungkan indikator sesuai situasi, tidak harus tunggu semuanya match.

## Ringkasan Bootcamp: Evil Panda Strat
- Strategi: pakai range luas untuk tangkap fee dari dump, lalu jual token saat bounce pertama.
- Inti: wide-range DLMM retracement play + cut emotion.

## Part 1 - Coin Selection
- Dexscreener filter: MC kurang lebih 250k, volume 24 jam minimal 1,000,000.
- Sort by Age, abaikan koin tanpa gambar atau profil tidak jelas.
- GMGN check: fees >30, phising <30%, bundling <60%, insiders <10%, top10 <30%.

## Part 2 - Entry Criteria
- Chart Dexscreener 15 menit.
- Tambah Supertrend.
- Entry saat harga break above Supertrend.
- Buka one-sided SOL DLMM, atau spot / bid-ask sesuai preferensi.
- Umum: pakai 80/100/125 bin pool, target range koreksi sekitar -86% sampai -94%.

## Part 3 - Exit Criteria
- Chart Dexscreener: tambah BB, MACD, RSI.
- Set RSI length=2, upper limit=90.
- Tunggu dump terjadi dan fee terkumpul.
- Sinyal exit adalah confluence minimal 2 indikator:
  - RSI(2) close di atas 90 + harga close di atas BB Upper, atau
  - RSI(2) close di atas 90 + MACD green histogram pertama.
- Prinsip: keluar di bounce pertama, bukan tunggu recovery full.

## Part 4 - Emotions & Risk Management
- Timeframe pilihan: 15 menit agar tidak perlu pantau terus. 1 menit/5 menit lebih banyak jebakan.
- Saat market kering, tidak perlu memaksa cari coin; tunggu setup yang lolos semua filter.
- Jangan pakai emosi: kalau exit, exit; jangan pikir mau lebih tinggi karena bisa rug.
- Kalau salah, akui dan cut meski losses; jangan ulangi kesalahan sama.
- Trading itu long game; jangan over position.
- Divide portfolio ke minimal 6 posisi, jadi jika 1 rugs masih ada modal recover.
- Tingkatkan posisi hanya sebagai reward: hari tanpa losses boleh tambah posisi esok hari, cari risiko lebih rendah.
- Jangan buka posisi setelah 6 malam agar tidak perlu baby-sit posisi semalaman; kesehatan lebih penting.
- Market akan selalu ada; tidak usah teriak全部 sinyal, istirahat jika baru loss sampai esok hari.
- Jangan revenge DLMM; losses biasanya makin dalam kalau emosi.
- Fokus ke profit untuk bangun confidence; big loss akan rusak mental.

## Final Exam / Extreme Dump Play
- Kalau koin sudah pumping Very big, waspadai: semakin besar pump, semakin besar dumpnya.
- Saat mendekati top, buka SOL one-sided DLMM di 125/10% pool dengan range **-90% sampai -95%**.
- **Jangan chase price up** dan jangan terus reposition; pasang range luas dan biarkan harga masuk sendiri saat dump cepat.
- 5% atau 10% fee pool berfungsi sebagai **insurance** untuk predictable unpredictability.
- Saat semua orang dump, mereka bayar fee ke pool kita; kita jadi **final exit liquidity**.
- Setelah fee terkumpul dari dump, tunggu sinyal exit:
  - RSI(2) close di atas 90, dan
  - Price close di atas BB Upper line.
- Bisa gunakan timeframe 5 menit untuk sinyal exit pada kondisi panic cepat.
- Jika bisa menangkap -90% sampai -97% dump dan tetap profit dari fee, itu berarti strategi sudah dikuasai.

## Data & Disiplin Screening
- Jangan percaya otak bisa ingat semuanya; catat semua coin yang di-scan, meski tidak ditrade.
- Saat coin pump nanti, review data untuk tahu parameter mana yang bisa mendeteksi potensi pump dan coin mana yang sering rug.
- Evil Panda Strat kerap menyisakan cuma 1–2 coin dengan high conviction; kalau ada banyak coin lolos bersamaan, berarti filter kurang ketat.
- Hindari kategori coin yang berisiko tinggi:
  - Political coins
  - Trump/Elon-themed coins
  - “Justice for anything” coins
- Waspadai FOMO: saat coin live, volume dan orang bisa membuat lupa aturan; tetap ikut filter.
- Perlakukan trading/LP seperti bisnis: butuh effort dan dokumentasi.

## Backtesting & Forward Testing
- Skill memilih coin untuk DLMM bukan dari luck/bot, tapi dari **backtesting dan forward testing** yang berulang.
- Rekam semua data coin baru dan lihat performanya tanpa uang dulu.
- Ubah/tambah parameter sesuai hasil observasi; ulangi tiap hari sampai pola muncul dan memberi confidence untuk risking money.
- Ulangi sampai otak bisa langsung classify good/bad coin dari data, tanpa perlu catat terus.
- Tidak ada easy money; kalau malas, hasilnya buruk.
- Sumber dasar: thread screening awal tentang cara memfilter coin.

## Catatan Visual
- Visual di thread menunjukkan wide purple range -95%;
- exit terjadi配合 RSI(2) + BB Upper pada chart 5 menit.

## DLMM untuk DCA IN / Buy More SOL
- DLMM bisa dipakai untuk **DCA IN** agar beli lebih banyak token dengan harga rata-rata lebih bagus.
- Contoh: pakai pool **SOL-USDC 10/0.1%**, tarik **USDC**, buka **70 bins** standard pakai **SPOT**.
- Saat harga turun masuk range, otomatis **kumpul SOL lebih rendah dari harga awal** + dapat fee.
- Contoh angka: `$1168.72 USDC` via DLMM mendapatkan `14.147 SOL`, vs spot hanya `13.18 SOL`; jadi **7.33% lebih banyak SOL**.
- Cara kerjanya: DCA otomatis di range + fee, tanpa perlu bottom exact.
- Cocok untuk penambahan posisi, bukan pengganti full entry strategy.
- Pilih bin range sesuai volatilitas, jangan terlalu sempit.
- Jangan lupa liikuiditas pool juga tetap penting.
- Sumber: https://x.com/i/status/2022098395041812850

---

## Cheat Sheet — Open / Skip / Strategy (1 halaman)

Referensi cepat saat analisis manual atau diskusi dengan Hermes. Meridian daemon saat ini **otomatis** pakai `bid_ask` + SOL one-sided below; cheat sheet ini untuk keputusan manual & override.

### 1. Layak open atau skip?

```
Token lolos screening Meridian?
├─ NO  → SKIP (jangan paksa FOMO)
└─ YES → Lanjut gate manual:
         ├─ GMGN: top10 ≤30%, bundler ≤30%, fees ≥20 SOL, mint/freeze renounced
         ├─ Rugcheck: red flags minimal
         ├─ Pool: TVL $20k–$150k, fee/TVL ≥5%, bin step 80–125
         ├─ Volume organik ≥70, holders ≥600, mcap $250k–$3M
         └─ Hindari: political/Elon/justice coins, PVP symbol clash
```

**Skip cepat jika:** bundler >30%, top10 >30%, fees <20 SOL, holders <600, atau coin "terlalu bersih" tanpa whale/axiom signal.

**Borderline** (SM 3–4, mcap dekat ceiling) → council / GMGN audit ulang sebelum deploy.

### 2. Spot vs Curve vs Bid-Ask

| Strategi | Kapan pakai | Deposit | Range |
|----------|-------------|---------|-------|
| **Bid-Ask** | Dump / koreksi / retracement play | SOL **below** active bin (Meridian default) | One-sided bawah, `bins_above: 0` |
| **Bid-Ask** (manual) | Pump — jual token saat naik | Token **above** active bin | One-sided atas |
| **Spot** | Sideways, DCA in/out, bias netral | SOL + token proporsional | Custom ratio (mis. 75:25) |
| **Curve** | Harga stabil di level, fee maksimal di tengah | SOL + token | Bell curve di sekitar harga sekarang |

**Meridian config saat ini:** `strategy: bid_ask` — tangkap fee dari orang dump, bukan chase pump.

**Rule of thumb:**
- Expect dump → **bid-ask SOL below** (Evil Panda / LogicalTA)
- Expect chop → **spot** dengan ratio sesuai bias
- Expect flat di harga → **curve**
- Expect pump lalu jual → **bid-ask token above**

### 3. Range bins (Fib + Supertrend, chart 15m)

| Fib level (dari high) | Bins one-sided SOL | Koreksi kira-kira |
|-----------------------|--------------------|-------------------|
| 0.51 | 100 | ~-50% |
| 0.43 | 125 | ~-57% |
| 0.27 | 200 | ~-73% |
| 0.19 | 250 | ~-81% |

**Pilih range:** sedikit **di bawah** support Supertrend (harga bisa breakdown).

- Support di atas 0.43 tapi di bawah 0.27 → aman pakai **200 bins** (0.27)
- Pump besar sebelumnya → range **lebih lebar** (125–250)
- Coin baru volatile → fee pool **10%**, range lebar = IL lebih terkontrol

**Meridian auto-bins:** `35–69` (volatility-scaled). Manual wide play (LogicalTA) = 100–250 — override via Telegram/command jika owner minta.

### 4. Entry timing

**Chart:** Dexscreener / GMGN **15 menit** (+ Supertrend).

| Kondisi | Entry |
|---------|-------|
| Retracement / dump play | Pasang range **sebelum** atau saat breakdown; jangan chase pump |
| Breakout continuation | Harga **break above** Supertrend → entry (Evil Panda Part 2) |
| Sudah pump besar | Wide range -90% s/d -95%, **jangan reposition** chase |

**Meridian auto strategy:** `autoStrategyEnabled: true` — router fetch chart 15m, klasifikasi market view, set `deploy_plan` per kandidat sebelum deploy. `chartIndicators.enabled` = gate filter screening terpisah (opsional).

### 5. Exit timing (setelah in-range)

1. **Tetap cetak fee** selama Supertrend support hold
2. Support **pecah** → waspada, siap exit
3. Exit di **bounce pertama** (confluence ≥2):
   - RSI(2) close > 90 + close di atas BB Upper, **atau**
   - RSI(2) > 90 + MACD histogram green pertama
4. Prioritas: **green candle** / pump untuk minimize slippage
5. Rug jelas → cut cepat, jangan tunggu indikator

**Meridian auto-exit:** `stopLossPct: -10`, `takeProfitPct: 3`, trailing TP (trigger 2%, drop 1%), OOR wait 15m.

### 6. Meridian defaults (user-config.json)

| Parameter | Nilai |
|-----------|-------|
| Strategy | `bid_ask` |
| Deposit | SOL only (`amount_y`, `amount_x=0`) |
| Bins below | 35–69 (default 69) |
| Bins above | **0** (fixed) |
| Deploy | 0.3 SOL / posisi |
| Max positions | 3 |
| Gas reserve | 0.2 SOL |
| Stop loss | -10% |
| Take profit | 3% (+ trailing) |
| Screening | trending 5m, interval 30m |
| Pool TVL | $20k–$150k |
| Min mcap | $250k |
| Min holders | 600 |
| Min organic | 70 |
| Min fee/TVL | 5% |
| Top10 / bundler max | 30% |

### 7. Decision tree singkat

```
Analisis coin X
│
├─ Screening FAIL → SKIP
│
├─ Screening PASS
│   ├─ View: dump/koreksi? → bid_ask + SOL below + range lebar (Fib)
│   ├─ View: sideways?     → spot (ratio manual) — override config
│   ├─ View: flat?         → curve — override config
│   └─ View: pump sell?    → bid_ask + token above — override config
│
├─ Entry: 15m Supertrend break (bull) ATAU pasang wide sebelum dump (bear)
│
└─ Exit: support break → RSI(2)+BB atau RSI(2)+MACD → green candle
```

**Hermes:** pakai skill `meridian-lp-strategy` saat owner minta analisis strategi/entry untuk CA tertentu.
