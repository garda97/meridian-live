# Config Safety Baseline — Owner Approved

_Diset Grok atas permintaan owner 2026-07-04: "setting jangan aneh". **Wajib dibaca Hermes & Claude sebelum ubah `user-config.json` atau propose threshold.**

> **⚠️ UPDATE 2026-07-04 ~11:00 UTC — tabel "Baseline live" di bawah SUPERSEDED.**
> Owner shift ke preset **evil-panda.strict** (`presets/evil-panda.strict.json`, apply via `npm run preset:evil-panda`).
> Live sekarang: `deployAmountSol=2`, `maxPositions=2`, `stopLossPct=-15`, `athEntryGateEnabled=true`, `exitPreset=evil_panda_exit`+MACD, `noDeployAfterHour=18`, `dailyLossLimitUsd=30`, darwin/discord/filterAutotune OFF.
> **Jangan restore baseline lama tanpa owner eksplisit.** Prinsip umum + daftar JANGAN di dokumen ini tetap berlaku; angka live cek `user-config.json`.

---

## Prinsip umum (semua agent)

1. **Max 3 key per iterasi** — jangan ubah 8 parameter sekaligus seperti sesi relax darurat.
2. **Owner verbal eksplisit** sebelum longgarkan security (`rugcheck`, `maxTop10`, `excludeHighSupplyConcentration`).
3. **Jangan sentuh** `dryRun`, `stopLossPct` → 0, matikan `trailingTakeProfit` / `solRegimeGateEnabled`, naik `deployAmountSol` tanpa owner.
4. **Claude gap LP (Jul 2026)** — default OFF di kode; **jangan enable** tanpa owner:
   - `tgeMaxAgeHours` (TGE play)
   - `shareExitEnabled` (TVL dilution exit)
   - `minEstimatedSharePct` (filter share — tidak masuk akal di wallet 0.5 SOL)
5. **`pnlWarmupMinutes: 3`** — protektif (fix phantom PnL). **Jangan turunkan ke 0.**
6. **Claude tidak edit `user-config.json`** — hanya rekomendasi di handoff; eksekusi config = Hermes (zona hijau) atau Grok.
7. **Pause screening:** `maxPositions: 0` — daemon reload otomatis tiap cycle (tidak perlu restart). Management **tidak** trigger screening saat pause.

---

## Baseline live (owner-approved, update 13:28 WIB 2026-07-04)

| Key | Nilai | Catatan |
|-----|-------|---------|
| `deployAmountSol` | **1** | Owner set 1 SOL/posisi — **jangan naik/turun tanpa owner** |
| `maxDeployAmount` | **1** | Harus match deployAmountSol |
| `minSolToOpen` | **1.25** | 1 SOL + gasReserve |
| `maxPositions` | **1** | Satu posisi |
| `rugcheckTop10MaxPct` | **65** | Santai (owner OK); **jangan >65** |
| `maxTop10Pct` | **35** | Santai; jangan >40 |
| `excludeHighSupplyConcentration` | **true** | **Jangan false** tanpa owner |
| `minVolume` | **5000** | Santai |
| `minMcap` | **150000** | Santai |
| `minFeeActiveTvlRatio` | **0.04** | Jangan <0.03 |
| `winRedeployCooldownHours` | **3** | **WAJIB** — SEMAN loss = redeploy 9m setelah close |
| `repeatDeployCooldownEnabled` | **true** | Jangan false |
| `lossRedeployBlockEnabled` | **true** | Block redeploy pool loss 12h |
| `stopLossPct` | **-12** | Merah: jangan longgarkan |
| `trailingTriggerPct` / `trailingDropPct` | **4** / **1.5** | Jangan ubah bareng SL |
| `dailyLossLimitUsd` | **12** | Owner naikkan; realized ~-$7.7 → sisa ~$4.3 headroom |
| `pnlWarmupMinutes` | **3** (kode) | Protektif phantom PnL |
| `autoRebalanceEnabled` | **true** | Wallet ~1.34 SOL → migrate wide **sering skip** (butuh ~0.42 liquid) |

### Pelajaran SEMAN loss (2026-07-04) — WAJIB Hermes/Claude ingat

1. **Jangan redeploy pool yang baru di-close** (<3h) meski narrative bagus — cooldown + loss block harus dihormati.
2. **Fee/TVL tinggi ≠ aman** — token dump -32% mcap in-range tetap kena IL > fees.
3. **1 SOL deploy** → SL -12% ≈ **$10** per hit; daily limit $12 = max ~1 loss/hari.
4. Agent **jangan override** pool-memory cooldown / loss block dengan reasoning "proven pool".

### Fitur kode (bukan user-config — defaults)

| Key | Default | Rule |
|-----|---------|------|
| `pnlWarmupMinutes` | 3 | Aktif — jangan off |
| `tgeMaxAgeHours` | null | OFF |
| `shareExitEnabled` | false | OFF |
| `minEstimatedSharePct` | null | OFF |

---

## Hermes — BOLEH vs JANGAN (minim loss, Jul 2026)

### ✅ BOLEH (max 3 key, owner verbal atau situasi jelas)

| Key | Range | Kapan |
|-----|-------|-------|
| `trailingTriggerPct` | 3–5 | Trailing terlalu cepat/lambat |
| `trailingDropPct` | 1–2 | Idem |
| `outOfRangeWaitMinutes` | 20–45 | OOR exit tuning |
| `dailyLossLimitUsd` | 8–15 | Owner minta naik/turun limit harian |
| `minVolume` / `minMcap` | 5000/150k ↔ 8000/200k | Owner "relax" / "ketatkan" |

### ❌ JANGAN (tanpa owner eksplisit)

| Key | Kenapa |
|-----|--------|
| `winRedeployCooldownHours` → 0 | SEMAN: redeploy 9m setelah close → loss |
| `lossRedeployBlockEnabled` → false | Redeploy pool yang baru loss |
| `rugcheckTop10MaxPct` > 65 | NEIL 69.9% — concentration risk |
| `excludeHighSupplyConcentration` → false | Holder concentration |
| `deployAmountSol` / `maxDeployAmount` | Owner set 1 SOL — sizing = owner only |
| `stopLossPct` longgarkan (< -12) | 1 SOL × 12% = ~$10; jangan melebar |
| Clear pool-memory cooldown | Bypass proteksi SEMAN/FABLE |
| `tgeMaxAgeHours`, `shareExitEnabled` | Risk profile beda |

### Agent screening — aturan perilaku

- **Skip** kandidat di `pool-memory` cooldown / loss block — jangan argue "proven pool".
- **Prioritas** pool dengan smart wallets + organic tinggi vs narrative saja.
- **1 SOL** → satu loss SL ≈ habiskan daily headroom; extra hati-hati redeploy same token.

---

## Hermes — kapan boleh longgarkan filter

Hanya jika **owner bilang** "relax" / "gas deploy" **dan** `node cli.js candidates` menunjukkan reject yang jelas.

**Urutan aman (1 iterasi = max 3 key):**

```
minVolume 5000 → minMcap 150000 → rugcheckTop10MaxPct 65
```

**Jangan dalam 1 sesi tanpa owner:**
- `winRedeployCooldownHours: 0` + `repeatDeployCooldownEnabled: false` + `rugcheckTop10MaxPct: 65` sekaligus
- `excludeHighSupplyConcentration: false` tanpa owner setuju risiko concentration

**Setelah deploy darurat:** propose balik ke baseline tabel atas dalam 24h atau setelah posisi close.

**Reverse ke baseline (copy-paste):**
```bash
cd /root/meridian
node cli.js config set rugcheckTop10MaxPct 60
node cli.js config set maxTop10Pct 30
node cli.js config set excludeHighSupplyConcentration true
node cli.js config set minVolume 8000
node cli.js config set minMcap 200000
node cli.js config set winRedeployCooldownHours 3
node cli.js config set repeatDeployCooldownEnabled true
```

---

## Claude — scope aman

| Boleh | Tidak boleh |
|-------|-------------|
| Fix bug, test, refactor kecil | Edit `user-config.json` |
| Default OFF untuk fitur agresif | Enable `tgeMaxAgeHours`, `shareExitEnabled`, filter share |
| Handoff rekomendasi threshold | Restart daemon tanpa owner (kecuali runbook) |
| P2: fix SOL $150 hardcode di `getTopCandidates` | Longgarkan security filter di kode |

**Backlog P2 (bukan urgent):** rebalance skip harus stamp cooldown (`recordRebalanceAttempt` saat insufficient SOL) — hindari log spam 3s.

---

## Red flags → stop & report owner

- Deploy → close **<2 menit** dengan peak PnL >20% (cek warmup aktif)
- Rebalance spam setiap 3s + `insufficient_sol`
- 0 kandidat tapi owner tidak minta relax — **jangan** auto-longgarkan 8 key
- `rugcheckTop10MaxPct` > 70

---

## Referensi

- Zona toleransi detail: `notes/HERMES_CONFIG_TUNING.md`
- Handoff queue: `notes/HANDOFF.md`
- Claude scope: `notes/CLAUDE_AGENT.md`