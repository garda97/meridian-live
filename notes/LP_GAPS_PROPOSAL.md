# Proposal — 3 Gap Strategi LP (TGE, Liquidity Share, TVL Share Exit)

_Dibuat: 2026-07-04 oleh Claude, atas dispatch Hermes 04:30 UTC. **PROPOSAL SAJA — belum ada kode live yang diubah.** Owner review dulu._

## Temuan investigasi (apa yang SUDAH ada di repo)

Sebelum propose, penting: sebagian plumbing ternyata sudah ada — proposal di bawah memakai itu, bukan bangun dari nol.

| Kebutuhan | Status di repo sekarang |
|---|---|
| Umur token | **SUDAH ADA** — `token_age_hours` di condensed pool (`tools/screening.js:911`), filter `minTokenAgeHours`/`maxTokenAgeHours` sudah jalan (hard filter + API-level filter), umur tampil di candidate block (`index.js:740`) |
| TVL pool di kandidat | **SUDAH ADA** — `pool.tvl` / `active_tvl` di condensePool |
| TVL pool saat deploy | **SUDAH ADA** — `entry_tvl` disimpan ke state.json per posisi (`trackPosition`) |
| Nilai posisi live | **SUDAH ADA** — `total_value_usd` per posisi dari PnL poller (`tools/pnl.js:224`) |
| TVL pool live post-deploy | **BELUM ADA di position data** — `getMyPositions` tidak bawa TVL pool; butuh 1 fetch pool-detail per pool per management cycle (bukan per tick 3s) |
| Strategy override per kondisi | **SUDAH ADA polanya** — `resolveDeployStrategyForCandidate` di strategy-router adalah tempat yang tepat untuk TGE override |

---

## GAP 1 — TGE Detection & Strategy Override

**Verdict: PROPOSE — kecil, low-risk, plumbing 80% sudah ada.**

Karena `token_age_hours` + filter umur sudah ada, yang benar-benar baru hanya *strategy override* saat token masih fresh.

### Rencana implementasi
1. **Config** (3 key, semua di `autoStrategy`):
   - `tgeMaxAgeHours` default `null` = **OFF** (mis. owner set 4)
   - `tgeMinFeePct` default `5` — TGE play hanya masuk akal di pool fee tinggi (5–10%); di bawah itu skip override
   - `tgeMaxHoldHours` default `8` — dipakai Gap 1b (exit) di bawah
2. **`tools/strategy-router.js`** — di `resolveDeployStrategyForCandidate`, setelah classification: jika `pool.token_age_hours < tgeMaxAgeHours` DAN `pool.fee_pct >= tgeMinFeePct` → tandai `plan.tge = true`, paksa range sangat lebar (`bins_below = autoStrategyMaxBins`, spot balanced bila `allowSpot`), tambah note `TGE play`. Jika fee pool < `tgeMinFeePct` → `entry_allowed = false` reason "TGE token on low-fee pool — fee tier can't cover the volatility".
3. **Exit TGE (1b)**: posisi dengan `tge: true` di state → rule deterministik baru di `getDeterministicCloseRule`: `age_minutes >= tgeMaxHoldHours*60` → CLOSE reason `tge_max_hold`. Ini melengkapi SL/trailing existing, bukan mengganti.
4. **State**: `trackPosition` sudah terima field arbitrer via plan — tambah `tge: plan.tge`.

Estimasi diff: ~60 baris + test. Risiko utama: **interaksi dengan `minTokenAgeHours`** — kalau owner set `minTokenAgeHours: 2` (anti-sniper) sekaligus `tgeMaxAgeHours: 4`, window TGE tinggal 2–4 jam. Bukan bug, tapi harus disadari.

### Pertanyaan untuk owner
- TGE play butuh fee pool 5–10%, sementara `minBinStep: 80` + fee tier pool yang biasa lolos screening sekarang ~2%. Mau TGE jadi **jalur screening terpisah** (kategori berbeda, filter longgar khusus TGE) atau cukup override di kandidat yang sudah lolos filter normal? Rekomendasi saya: **cukup override kandidat lolos filter** dulu (konservatif); jalur terpisah = perubahan besar di pipeline.

---

## GAP 2 — Estimated Liquidity Share saat Screening

**Verdict: PROPOSE — sangat kecil, data sudah lengkap, tinggal aritmetika.**

`estimated_share_pct = (deployAmountSol × harga SOL) / pool_tvl × 100`. Semua input sudah tersedia di screening cycle (`computeDeployAmount`, `balance.sol_price`, `pool.tvl`).

### Rencana implementasi
1. **`index.js` candidate block** — satu baris baru: `est_share: X.X% of $TVL` per kandidat. LLM langsung melihatnya.
2. **Config**: `minEstimatedSharePct` default **`null` = OFF dulu** (bukan 5% seperti usulan Hermes — lihat catatan).
3. Jika di-set: hard filter di `getTopCandidates` sesudah filter TVL existing, dengan `filteredOut` reason `est share X% < min Y%`.
4. **Staging**: masukkan `estimated_share_pct` ke `stageSignals` → otomatis ikut ke `holder_audit`/darwin snapshot → bisa dianalisis retroaktif dari decision-log.

### Catatan penting (kenapa default OFF, bukan 5%)
Dengan deploy 0.5 SOL (~$40) dan `minTvl: 20k`, share maksimal yang mungkin = **0.2%**. Filter 5% berarti **tidak ada kandidat yang akan pernah lolos** kecuali TVL pool < $800 — jauh di bawah `minTvl`. Insight web3probe (target share 15–25%) itu untuk LP bermodal puluhan SOL. Untuk Meridian sekarang, metric ini **informatif** (bantu LLM & retro-analysis), bukan filter. Kalau wallet tumbuh 10–20×, baru threshold masuk akal.

Estimasi diff: ~25 baris + test kecil.

---

## GAP 3 — TVL Share Exit Signal (post-deploy dilution)

**Verdict: PROPOSE dengan modifikasi — sinyal valid, tapi jangan exit berdiri sendiri.**

Skenario: TVL pool meledak setelah kita deploy → share kita terdilusi → fee per $ posisi turun. Sinyal ini **sudah setengah tertangkap** oleh rule `LOW_YIELD` existing (`fee_per_tvl_24h < minFeePerTvl24h`) karena fee/TVL pool turun saat TVL naik tanpa volume ikut. Yang belum tertangkap: kasus fee/TVL pool masih OK tapi *share kita* yang kolaps.

### Rencana implementasi
1. **Management cycle (10m, bukan poller 3s)** — satu fetch `fetchFreshPoolDetail(p.pool)` per posisi terbuka per cycle (murah: 1–3 posisi max). Hitung:
   - `position_share_pct = total_value_usd / pool_tvl_live × 100`
   - `tvl_growth_x = pool_tvl_live / tracked.entry_tvl`
2. **Simpan ke snapshot** — `recordPositionSnapshot` sudah dipanggil per cycle; tambah 2 field itu. Trend dilution kelihatan di pool-memory (48 snapshot ~4–8 jam).
3. **Exit rule baru di `getDeterministicCloseRule`** (rule 6): CLOSE hanya jika **tiga-tiganya**:
   - `position_share_pct < shareExitMinPct` (default 2), DAN
   - `tvl_growth_x > shareExitTvlGrowthMin` (default 3 — TVL memang meledak, bukan share kecil dari awal), DAN
   - `fee_per_tvl_24h < minFeePerTvl24h` (yield juga sudah turun — sesuai usulan Hermes "share < 2% **dan** fee/TVL turun")
   Reason: `tvl_dilution`. Config `shareExitEnabled` default **false** (opt-in).
4. Kenapa 3 kondisi: share kecil sendirian bukan alasan exit (posisi kecil di pool sehat tetap cetak fee proporsional); TVL growth sendirian bisa berarti pool lagi hot (bagus). Kombinasi share kolaps + TVL meledak + yield turun = benar-benar terdilusi.

Estimasi diff: ~70 baris + test. Biaya runtime: +1 fetch per posisi per 10 menit — negligible.

---

## Ringkasan urutan eksekusi yang saya sarankan

| Gap | Effort | Risiko | Default | Urutan |
|---|---|---|---|---|
| 2 — est. share (informatif) | ~25 baris | Hampir nol | metric ON, filter OFF | **1** |
| 3 — dilution exit | ~70 baris | Rendah (opt-in, 3 kondisi) | OFF | **2** |
| 1 — TGE override | ~60 baris | Sedang (interaksi filter umur + fee tier) | OFF | **3** — tunggu jawaban owner soal jalur screening |

Total 3 gap bisa satu sesi kerja + test. Tidak ada yang menyentuh SL/trailing/rebalance existing.
