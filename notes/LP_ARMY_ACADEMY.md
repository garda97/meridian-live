# LP Army Academy — Meteora DLMM (Indonesian Track)

Koleksi ringkasan dari https://www.lparmy.com/academy/indonesian-* (diambil 2026-07-08 via OCR infografis).
Topik tanpa infografis PNG (teks/markdown di page): 1-6-ui-tour, 2-6-menyelam-ke-dlmm,
2-7-monitoring-posisi-dan-pnl, 2-9-tugas-kelulusan — hanya tersedia sebagai judul, butuh fetch teks.

====================================================================
## 1-1 / 1-2 — Glosarium Istilah & Role Lulusan
(Judul halaman "1-2" di website merender asset 1-1; isi = glosarium + role kursus.)

### Glosarium (1-1-1)
- Token Address: alamat alfanumerik unik untuk setiap token.
- Swaps: trading, menukar 1 token dgn token lain (beli/jual).
- Slippage: selisih harga antara klik transaksi & eksekusi nyata di blockchain.
- TVL (Total Value Locked): total nilai aset terkunci di pool/protokol/chain (USD).
- Volume: jumlah aktivitas trading periode tertentu (biasanya USD 24j).
- Volatilitas: ukuran harga naik-turun dalam jangka waktu tertentu.
- Market Cap (MC): nilai total seluruh token beredar (USD).
- Price Impact: dampak transaksi thd harga, tergantung kedalaman pasar & MC.
  Semakin kecil MC → semakin besar pengaruh 1 transaksi.
- LP: bisa berarti Liquidity Provider, Liquidity Pool, atau LPing (provide liquidity).

### Role setelah lulus (1-1-2)
- Lolos hari 1 → "Garuda LP Trainee" (Meteora Discord).
- Lolos hari 1 + hari 2 → "Garuda Army Private".
- ⚠️ Syarat: HARUS lulus hari 1 DAN hari 2. Lulus hari 2 tapi gagal hari 1 = tetap tidak lulus.
  Kalau fail → coba lagi.

### Relevansi ke Meridian
- Glosarium = dasar pembacaan metric screening bot (TVL, Volume, Volatilitas, MC, Price Impact).
- Bot pakai TVL (minTvl 25K), Volume, Volatilitas (minVolatility), MC (minMcap/maxMcap)
  sebagai gate — persis konsep di glosarium ini.
- Price Impact kecil untuk MC besar = token stabil; bot hindari MC kecil yg gampang pump-dump.

====================================================================
## 1-3 — DAMM V1 vs V2  (lihat juga DAMM_V1_V2.md)
Sudah di file terpisah DAMM_V1_V2.md. Inti:
- DAMM V1: AMM tradisional, fee otomatis masuk modal, hasil fee 2 token, no Meteora Points.
- DAMM V2: customizable, bisa Dynamic Fees, dapet Points, deposit HARUS balanced 2 token,
  fee bisa diklaim, Fee Scheduler (linear/exponential), protokol fee 20% dari LP Fee.
- DAMM V2 cocok buat meme launch + sniper/MEV (agresif).

====================================================================
## 1-4 — Definisi DLMM (Dynamic Liquidity Market Maker)
- DLMM = likuiditas bisa disebar dalam bin nol-slippage untuk maksimalkan fee.
- Keunggulan: bentuk likuiditas bisa diatur, bisa dipusatkan atau disebar,
  dan bisa SINGLE-SIDED deployment (taruh SOL aja tanpa token pasangan).
- APA ITU BIN: tiap bin = 1 harga spesifik. Likuiditas dari banyak wallet numpuk di bin.
- BIN STEP: 1 Bin Step = 1 Basis Point = 0.0001.
  - Harga bin berikutnya = harga sekarang × (1 + binStep/10000).
  - Bin step kecil = presisi halus; bin step besar = jarak harga kasar/lebar.
  - Contoh: Bin Step 50 → 0.01231 × 1.0050 = 0.01237.
- BASE FEE vs BIN STEP:
  - Base fee kecil (0.01%) → hanya bisa di rentang harga kecil (likuiditas terkonsentrasi).
  - Base fee besar (0.2%, 1%) → bisa mencakup rentang harga luas.
  - Pool bisa punya bin step bebas (5, 20, 80, 100, 125, 200, 250, 400) tapi base fee terbatas.
- Kenapa bin step rendah hasilkan lebih fee? Karena range sempit → harga sering bolak-balik
  dalam bin → lebih banyak event fee + dynamic fee trigger saat volatil.

====================================================================
## 1-5 — Pool vs Posisi
- DIVERGENCE / IMPERMANENT LOSS:
  - IL jadi PERMANEN kalau withdraw posisi. Jangan withdraw kalau lagi negative divergence
    kalau yakin harga balik.
  - Positive divergence loss = nilai withdraw USD > deposit (untung). Terjadi di single-side
    SOL/quote DCA keluar → dapet positive IL + fee.
- POOL = dua token di Bin Step + Base Fee tertentu, berisi likuiditas banyak wallet.
  Pool TIDAK bisa ditutup/dibuang.
- POSISI = likuiditas ANDA yang dideposit ke pool. Bisa punya banyak posisi di 1 pool.
  Posisi berhenti saat ditutup.
- Dua cara cuan di DLMM: (1) positive divergence loss, (2) fee rewards. Tidak ada rebalance otomatis.
- Parameter penting buat fee besar: VOLUME, TVL (Likuiditas), VOLATILITAS.
  TUJUAN: kalahkan loss dengan fee.

====================================================================
## 1-6 — UI Tour
(Tidak ada infografis — teks di page. Butuh fetch konten teks.)

====================================================================
## 2-1 — Bertahan di LP (Survival / Security)
- 3 pilar: Tes & Belajar Terus, Punya Metode, Kolaborasi.
- KEAMANAN — pakai RugCheck.xyz: cek token bisa dicetak, dibekukan, likuiditas rendah,
  kepemilikan tinggi (high holder concentration), token tiruan.
  Tools: RugCheck, Bubblemaps (cluster holder = potensi rug), SolScan.
- WASH TRADING: mayoritas volume oleh bot, volume diputar ke pool gak untung,
  cuma arb/volume lebay yang masuk pool lu. Volume chart terlalu rata = palsu.
  Biasanya di token baru, bisa rug cepat.

====================================================================
## 2-2 — Mencari Peluang LP
- DLMM OPPS BOT (Discord LP Army): Top 10 Non-Strict + Multiday Opportunities.
  Filter: Liquidity ≥ $600, Estimated Min 24H Fees/TVL, Volume Trend, TVL, FDV,
  Bin Step, Base Fee, Rug Check.
- LP CALLS channel: "call" dari Garada Elders (token degen berpotensi posisi Multiday).
  ⚠️ Jangan anggap semua call aman — riset sendiri.
- POOL DISCOVERY (di app Meteora): Top Performers / Trending / Newest, filter berbagai
  macam, bisa masuk pool & buat posisi 1 klik. Cari pool DLMM & DAMM V2.

====================================================================
## 2-3 — Membaca Chart
- Pahami volume & market cap: naik / turun / range?
- Indikator:
  - MACD: crossing garis MACD(signal), zero line, histogram = momentum.
  - RSI: >70 overbought, <30 oversold, divergence = potensi reversal.
  - Heikin Ashi: jelasin tren (hijau tanpa ekor bawah = uptrend kuat).
  - Volume Profile Visible Range (VPVR): HVN = support/resistance kuat,
    LVN = harga lewat cepat, POC = level volume terbesar.

====================================================================
## 2-4 — Strategi DLMM Tingkat Lanjut
- COMPOUNDING FEES: posisi SPOT 1-sided SOL → tambah layer Bid-Ask di atasnya →
  klaim fee masukin lagi ke Bid-Ask untuk jual di harga lebih tinggi.
- BID-ASK FLIP: favorit LP. Gak beli token dulu; tunggu harga turun "beli" di bawah,
  withdraw lalu set bid-ask 1-sided → terjual saat naik. Mirip trading: beli murah jual mahal.
- Bisa campur strategi: "Set and Forget" / "min-max". Mulai 1 strategi (bid-ask SOL side),
  lalu withdraw + set bid-ask token side untuk jual pelan-pelan.
- BID-ASK AND CHILL: token sudah mapan/stable. Set range, dapat fee + bisa jual tinggi/beli rendah.
- EVIL PANDA STRAT: SPOT SOL 1-sided, biasanya 100 Bin Step, pool 5-10% fee.
  (Detail di Advanced Bootcamp #7.)

====================================================================
## 2-5 — Bertarung dengan Impermanent Loss
- Kalau IL / OOR ke bawah:
  - Nunggu aja kalau yakin harga balik ke range.
  - Buka posisi 1-sided Bid-Ask di range lebih rendah → fee nutupin rugi.
  - Ambil rugi & pindah ke range baru kalau yakin fee baru balikin.
  - Cutloss sebelum makin parah (withdraw + jual).
  - ⚠️ Withdraw saat IL = loss jadi PERMANEN. Kadang lebih baik cutloss dari dibiarin.
- Fee handling: klaim → masukin lagi ke posisi (token gak mau lama-lama), atau buka posisi
  baru di range lebih tinggi (bid-ask), atau jual langsung, atau hold.

====================================================================
## 2-6 — Menyelam ke DLMM
(Tidak ada infografis — teks di page.)

====================================================================
## 2-7 — Monitoring Posisi dan PNL
(Tidak ada infografis — teks di page.)

====================================================================
## 2-8 — Generate Kartu PNL
- CARA CARI TX: solscan.io → copas wallet → Defi Activities → cari transaksi (TX ID = signature).
- COMMUNITY TOOLS: Metlex.io — cari token trending, cek total fee wallet di DLMM,
  generate kartu PNL otomatis, cari pool by CA/nama, bandingkan DLMM vs DEX lain.

====================================================================
## 2-9 — Tugas Kelulusan
(Tidak ada infografis — teks di page.)

====================================================================
## 1-6 — UI Tour (teks)
- Ganti RPC / sesuaikan Global Priority Fee buat transaksi lancar.
- Fitur Zap Out: instan sell posisi token → jadi SOL (quote token).
- Withdraw macam-macam: setengah, semua, atau langsung flip posisi (masukin likuiditas lagi).
- Deposit 1-side / 2-side liquidity.
- Live PnL & History PnL.
- Atur preferensi AutoFill & Zap Out, pengaturan fee transaksi buat optimasi klaim/deposit.

## 2-6 — Menyelam ke DLMM (teks)
- MAXIMUM BIN per posisi = 1.400.
- Pilih & ganti pool sesuai kondisi pasar.
- Range atas-bawah LEBAR → hindar loss besar.
- Pahami batasan sistem (1.400 bin) + sesuaikan pool dgn market.

## 2-7 — Monitoring Posisi dan PNL (teks)
- Monitor posisi secara berkala = PENTING.
- Cek PnL terealisasi & belum terealisasi.
- Sesuaikan strategi dgn performa PnL.

## 2-9 — Tugas Kelulusan (teks)
- Syarat lulus: Tes Teori Academy (skor 80%) + Tugas Kelulusan (posisi DLMM live dgn dana nyata).
- Tugas: eksekusi posisi DLMM nyata ikut semua persyaratan, tunjukkan mahir strategi + risk mgmt.
- Target: profit MINIMAL 5% (bukan cuma fee) buat bukti penguasaan.
- Hadiah: role Academy Trainee & LP Army Private di Discord.
- Semua via portal kelulusan otomatis.

### Relevansi ke Meridian (tambahan dari teks-topics)
- 1-6 Zap Out / 1-side deposit = bot lu pakai single-side SOL deploy (autoStrategyAllowSpot).
- 2-6 max 1.400 bin = bot config maxBins=250 (jauh di bawah limit, aman). Bot bisa naikin kalau
  butuh range lebar di token volatil.
- 2-7 monitoring PnL = daemon bot sudah punya PnL poller (rpc source) + Telegram notify.
- 2-9 target profit 5% = mirip takeProfit bot lu (tp 6% di config terakhir, sebelumnya 3%).
  Bot already exceeds minimum graduation bar.

====================================================================
## RELEVANSI KE MERIDIAN (bot lu)
- Bot lu main DLMM, single-sided SOL (selaras 1-4 single-sided deployment).
- autoStrategy bid_ask + spot = persis "Bid-Ask Flip" / "Evil Panda" di 2-4.
  Config lu: strategy=bid_ask, autoStrategyAllowSpot=true, autoStrategyPreferSpotHighFee=true,
  minTokenFeesSol=15, autoStrategySpotFeeTvlMin=2 → cocok dengan panduan "5-10% fee pools".
- Filter rugcheck top10 25% = implementasi 2-1 Keamanan (RugCheck). ConcParadoxOverride =
  escape hatch buat token legit tinggi konsentrasi (2-1 high holder concentration).
- IL handling bot: stopLoss -17%, trailing TP, OOR timeout = mirror 2-5 (cutloss / nunggu).
- minVolatility / volatilitas di 1-5 = parameter cari fee. Bot pakai volatility gate.
- Pool Discovery / DLMM Opps (2-2) = analog sama screening bot (discord signals, opportunity poll).
- 1-6 / 2-6 / 2-7 / 2-9 butuh fetch teks (gak ada PNG) kalau mau lengkap.
