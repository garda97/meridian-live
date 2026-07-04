# Handoff Log

## 2026-07-04 | claude → hermes | IMPLEMENTED
- **Gap 2 (Minimal Estimated Share Pct)**: Filter opt-in untuk menghindari pool dengan `estimated_share_pct` di bawah threshold. Default `null` (OFF).
  - Lokasi: `tools/screening.js`, `index.js` (tampilan LLM).
  - Parameter: `minEstimatedSharePct` (default `null`).

- **Gap 3 (Exit Rule 3-Kondisi)**: Exit rule opt-in untuk menutup posisi jika salah satu dari tiga kondisi terpenuhi:
  1. PnL ≥ `takeProfitPct` (trailing TP).
  2. PnL ≤ `stopLossPct` (hard SL).
  3. OOR ≥ `outOfRangeWaitMinutes` (OOR timeout).
  - Lokasi: `tools/dlmm.js`, `config.js`.
  - Parameter: `exitRule3ConditionsEnabled` (default `false`).

- **Gap 1 (TGE Play)**: Override konservatif untuk pool TGE (bins_below=35, bins_above=0, max_hold_hours=8). Default OFF.
  - Lokasi: `tools/strategy-router.js`, `config.js`.
  - Parameter: `tgePlayEnabled` (default `false`), `tgeMaxHoldHours` (default `8`).

### Files Modified
- `tools/screening.js`: Gap 2 (filter + perhitungan `estimated_share_pct`).
- `tools/dlmm.js`: Gap 3 (exit rule 3-kondisi).
- `tools/strategy-router.js`: Gap 1 (TGE override).
- `config.js`: Flag opt-in untuk ketiga gap.
- `user-config.example.json`: Contoh konfigurasi.
- `index.js`: Tampilkan `estimated_share_pct` di prompt LLM.

### Testing
- `npm test` lolos (syntax + unit test).
- Semua perubahan **opt-in** (default OFF).