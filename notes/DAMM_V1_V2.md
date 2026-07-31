# DAMM V1 vs V2 — Meteora (LP Army Academy)

Sumber: https://www.lparmy.com/academy/indonesian-1-3-damm-v1-v2
Diambil: 2026-07-08 (OCR dari infografis 1-3-1.png + 1-3-2.png; 1-3-3.png = HTML error, skip)

## DAMM V1 (Dynamic AMM)
- AMM Tradisional
- Beberapa coin bisa pakai Dynamic Vault untuk dapat fees
- Dynamic Fees TIDAK untuk semua pool
- TIDAK bisa dapat Meteora Points
- Modal & Fee otomatis ditambahkan ke dalam pool
- Hasil fee selalu dalam 2 token
- Biaya protokol: 20% dari Dynamic Fees (atau dari LP Fees kalau tidak ada Dynamic Fees)
- Setiap buka posisi → dapat LP token (berupa NFT)

## DAMM V2 (Upgrade — AMM Tradisional + Pengaturan Khusus)
- Pool DAPAT memiliki Dynamic Fees
- DAPAT Meteora Points
- HARUS menyetor kedua token seimbang (balanced)
- Fees TIDAK dimasukkan ke modal → dapat diklaim kapan saja
- Pool bisa punya fees 1 token SAJA atau 2 token
- Biaya protokol: 20% dari LP Fees
- Pool dapat memiliki Fee Scheduler (Linear atau Exponential)
- Setiap buka posisi → dapat LP token (berupa NFT)

## Use Case & Tools (DAMM V2)
- Cocok untuk main EXTRA CEPAT di meme coin tertentu
- Cocok untuk mendapatkan volume sniper & MEV awal
- Dipakai saat peluncuran koin baru (launch)
- Tools: lparmy.com/strategies, rocketscan.fun, DAMMIT.pro, JupPro (jup.ag/pro)
- Note: biaya protokol DAMM V2 = 20% dari LP Fee

## Relevansi ke Meridian (DLMM bot)
- Meridian main di Meteora DLMM, BUKAN DAMM → constraint "deposit balanced 2 token" DAMM V2
  TIDAK berlaku (DLMM bisa single-side SOL).
- Fee Scheduler (linear/exponential) DAMM V2 ~ analog dengan autoStrategy trailing TP bot.
- DAMM V2 lebih agresif (meme launch, sniper/MEV) → di luar zona bot kita yang
  konservatif + rugcheck gate 25%. Selaras dengan prinsip "no trade > bad trade".
- Reference buat edukasi owner, bukan auto-deploy signal.
