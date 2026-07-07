# DLMM Research Notes — "Liquidity, Bukan Sekadar Trading" (mage)

Source: Seri Riset Defi Edisi Pertama, x.com/magersih. PDF 65pg, bahasa Indo.
Local copy: /tmp/dlmm_doc (pdf), /tmp/dlmm_text.txt (extracted).
Captured: 2026-07-07 by Hermes.

## Key takeaways mapped to Meridian

### II. Anatomi DLMM
- Bin = unit diskret harga (bukan range kontinu CLMM). Active Bin = satu-satunya yang punya 2 aset + tempat swap.
- Zero slippage DALAM bin (swap kecil gak ubah harga). Harga cuma berubah pas pindah bin.
- Bin Step = jarak antar bin. KECIL = presisi tinggi, cocok stable; BESAR = range lebar, cocok memecoin/volatil. Pemilihan bin step = risk mgmt decision, bukan teknis.
- Mindset shift: LP pro tanya "Bin mana paling sering dilewati harga? probabilitas harga bertahan di active bin? volume lewat bin saya?" → probability management, bukan yield chasing.

### III. Dynamic Fee (otak DLMM)
- Swap Fee = Base Fee + Variable Fee. Variable naik dgn volatilitas + pergerakan antar bin.
- Volatility Accumulator = "penghitung panas" on-chain (gak pakai oracle). Filter Period (anti-noise swap rapat), Decay Period + Reduction Factor (fee turun halus pas pasar tenang). maxVolAccumulator batasi fee.
- Dynamic Fee = proteksi LP: vol↑ → IL↑ → fee↑ → kompensasi↑. Kompensasi LVR lebih baik dr static fee.
- IMPLIKASI MERIDIAN: pool dgn dynamic fee tinggi = lagi volatil = kompensasi IL lebih oke. Tapi juga berarti price lagi gerak cepat (OOR risk). Harus dibarengi gate volatilitas (lo udh punya minVolatility).

### IV. Liquidity Distribution
- 2 LP sama pool, modal sama, hasil beda (contoh: 4200 vs 930 USDC/6hr) → beda di DISTRIBUSI, bukan modal.
- Spot = rata (sideways, gak yakin arah). Curve = bell (yakin harga muter di sekitar now). Bid-Ask = berat 1 sisi (punya arah pandangan). Custom = kanvas bebas.
- "Distribution adalah bahasa": Spot="gak yakin arah", Curve="yakin muter", Bid-Ask="punya arah", Custom="strategi sendiri".
- IMPLIKASI MERIDIAN: bid_ask lo buat recovery (ladder-buy dip) = "punya pandangan naik" → konsisten dgn doc. Spot lo buat entry normal = "gak yakin arah, sideways" — cocok buat token yg lagi range.

### VII. LP Decision Engine (paling actionable)
Framework: Pool → Collect → Analyze → Score → Compare → Allocate → Monitor → Rebalance.
4 Pilar + bobot:
- Liquidity Quality 25: TVL (kapasitas, BUKAN profit), Volume (langsung ke fee), **Fee/TVL ratio** (paling diremehkan — efisiensi modal).
- Profitability 25: Trading Fee + Incentive + Farming + Point − Cost − LVR − IL. APR = hasil akhir, urai sumbernya. Prioritas fee dari trading nyata, bukan emission.
- Risk 30: Volatility, Bin Step, Dynamic Fee, Token Quality, Concentration.
- Sustainability 20: apa pool masih menarik 6bln lagi.
Scorecard: 90-100 Institutional, 80-89 High Conviction, 70-79 Selective, 60-69 Speculative (kecil), <60 Avoid.
Decision Tree: Volume stabil? → Fee dr trading? → Vol sesuai strategi? → Token quality? → semua Ya → watchlist → bandingkan → alokasi. SATU "Tidak" → WAIT bukan BUY.

## Actionable untuk Meridian (Hermes proposed)
1. ~~TAMBAH metrik Fee/TVL ratio di screening~~ → SUDAH ADA. `config.screening.minFeeActiveTvlRatio` (default 0.05, config.js:124) gate universal di pre-deploy executor.js:125-136 (berlaku semua strategi incl bid_ask). Spot juga punya applySpotFeeFloor (strategy-router.js:390). Doc cuma VALIDASI praktik ini, bukan temuan baru. Jangan tambah kode baru.
2. Mapping gate saat ini → 4 pilar: Risk (athGate, supertrend, volatility, bin step), Liquidity (TVL, minMcap, Fee/TVL ✅), Profitability (fee dari trading via dynamic fee). Kurang: Sustainability eksplisit (umur token/lock) — tp udh partial di GMGN audit (token age).
3. "Wait bukan Buy" = validasi athEntryGate + supertrend_break lo. Pertahankan.
4. Bid-ask recovery = konsisten dgn "distribution = arah pandangan".

## Catatan owner
- Doc ini edukatif, BUKAN financial advice. Konfirmasi angka spesifik (base factor formula, reduction factor) ke Meteora docs resmi sebelum di-hardcode ke bot.
- Fee/TVL api field: cek Meteora API punya `feeTvlRatio` / `volume24h` / `tvl`.
