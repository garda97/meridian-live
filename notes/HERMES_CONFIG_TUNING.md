# Hermes — Ubah Parameter (dalam toleransi)

_Pelajaran dari Grok sesi 2026-07-04. Owner bilang "relax filter" / "ketatkan" → Hermes yang eksekusi._

**⚠️ WAJIB BACA DULU:** `notes/CONFIG_SAFETY_BASELINE.md` — baseline owner-approved Jul 2026. **Jangan setting aneh** (8 key sekaligus, cooldown 0 + rugcheck 65 tanpa owner, enable TGE/dilution exit).

---

## Cara ubah (sama seperti Grok)

```bash
cd /root/meridian
node cli.js config set <KEY> <VALUE>
```

- Langsung apply ke `user-config.json` + reload runtime (tanpa restart daemon)
- Auto-log ke `lessons.json` sebagai `[SELF-TUNED]`
- **Max 3 key per iterasi** — jangan ubah 10 sekaligus

Cek nilai sekarang:
```bash
grep -E 'minVolume|minMcap|rugcheck|maxTop10|cooldown|minFeeActive' user-config.json
node cli.js candidates --limit 5   # lihat reject reason
tail -5 decision-log.json
```

---

## Kapan Hermes boleh vs tidak

| Situasi | Hermes |
|---------|--------|
| Owner bilang "relax", "ketatkan", "cari pool", "deploy dong" | ✅ Eksekusi dalam **zona hijau** (max 3 key) |
| Owner bilang angka spesifik ("rugcheck 65") | ✅ Set persis itu kalau dalam zona |
| Tidak ada kandidat / semua reject | ✅ Diagnosa → propose 1-3 fix → tanya "gas?" → execute |
| Ubah `dryRun`, deploy >0.5 SOL, matikan SL/trailing | ❌ **Merah** — tanya owner eksplisit |
| Commit kode, restart daemon (kecuali crash) | ❌ Dispatch Grok |
| Clear cooldown di `pool-memory.json` | ⚠️ Boleh kalau owner bilang "skip cooldown SEMAN" |

---

## Zona toleransi (Jul 2026 — timeframe `1h`)

### 🟢 HIJAU — Hermes boleh (owner verbal OK)

**Longgarkan screening (cari lebih banyak pool):**

| Key | Live sekarang | Boleh turun ke | Boleh naik ke | Efek |
|-----|---------------|----------------|---------------|------|
| `minVolume` | **8000** (baseline) | **5000** | 15000 | Turun ke 5000 hanya owner "relax" |
| `minMcap` | **200000** (baseline) | **150000** | 250000 | Turun ke 150k hanya owner "relax" |
| `minFeeActiveTvlRatio` | **0.05** (baseline) | **0.04** | 0.05 | Jangan <0.04 tanpa owner |
| `maxTop10Pct` | **30** (baseline) | 26 | **35** | Max 35 hanya 1 step + owner OK |
| `rugcheckTop10MaxPct` | **60** (baseline) | 60 | **65** | Max 65 owner eksplisit; **jangan 70** |
| `excludeHighSupplyConcentration` | **true** (baseline) | — | false | OFF hanya owner setuju risiko |
| `winRedeployCooldownHours` | **3** (baseline) | — | **0** | **0 hanya** owner + clear pool-memory |
| `repeatDeployCooldownEnabled` | **true** (baseline) | — | false | false hanya owner darurat deploy |

**Ketatkan screening (kualitas lebih tinggi):**

| Key | Arah aman | Plafon ketat |
|-----|-----------|--------------|
| `minVolume` | naik | 15000 |
| `minMcap` | naik | 250000 |
| `minOrganic` | naik | 60–75 (jangan >75) |
| `maxTop10Pct` | turun | 26–30 |
| `rugcheckTop10MaxPct` | turun | 60 |
| `minFeeActiveTvlRatio` | naik | 0.05 |

**Management (exit/sizing) — hati-hati, max 2 key:**

| Key | Range aman | Catatan |
|-----|------------|---------|
| `trailingTriggerPct` | 3–5 | Live: 4 |
| `trailingDropPct` | 1–2 | Live: 1.5 |
| `outOfRangeWaitMinutes` | 15–45 | Live: 30 |
| `stopLossPct` | -15 sampai -10 | Live: -12 |
| `dailyLossLimitUsd` | 3–8 | Live: 4 |

### 🟡 KUNING — propose dulu, owner konfirm

| Key | Kenapa |
|-----|--------|
| `minTokenFeesSol` | Evil Panda floor — live **25**, code floor **30**. Jangan <25 |
| `minOrganic` / `minQuoteOrganic` | Evolve-owned — ubah hanya kalau owner setuju |
| `deployAmountSol` | Live 0.5 — naik butuh owner + cek wallet |
| `athEntryGateEnabled` | Bisa block banyak deploy |
| `partialTpEnabled` | Ubah exit behavior |
| `filterAutotuneEnabled` | Auto-relax berbeda dari manual |

### 🔴 MERAH — jangan sentuh / dispatch Grok

- `dryRun` (live = false)
- `minTokenFeesSol` **< 25**
- `rugcheckTop10MaxPct` **> 70** (NEIL 69.8% — di 72 semua lolos)
- `maxTop10Pct` **> 45**
- `minOrganic` **< 50**
- Matikan: `solRegimeGateEnabled`, `trailingTakeProfit`, `stopLossPct` ke 0
- Model LLM (`screeningModel`, dll)
- Edit `pool-memory.json` manual tanpa owner
- `systemctl restart` untuk load **kode baru** (bukan config)

---

## Decision tree — baca reject reason → fix

Jalankan dulu:
```bash
node cli.js candidates --limit 5
# atau
node cli.js screen --dry-run   # kalau ada flag dry-run
```

| Reject di log | Parameter | Fix (dalam zona) |
|---------------|-----------|------------------|
| `rugcheck: top10 holders X% > Y%` | `rugcheckTop10MaxPct` | Naik ke max **70** (1 step: +5) |
| `GMGN top10 X% > Y%` | `maxTop10Pct` | Naik +5 (max 40) |
| `in-range win close` / cooldown pool | `winRedeployCooldownHours` | Set **0** + owner OK clear pool-memory |
| `repeat fee-generating deploys` | `repeatDeployCooldownEnabled` | Set **false** |
| `No candidates` + market tipis | `minVolume`, `minMcap`, `minFeeActiveTvlRatio` | Turun 1 step masing-masing (lihat tabel) |
| `top10 concentration` (bukan rugcheck) | `maxTop10Pct` | Naik max 40 |
| `sol_regime_gate` | — | **Jangan bypass** — report "SOL dump, tunggu" |
| `daily_loss_limit` | — | Report, jangan deploy hari ini |

**1 iterasi = max 3 fix.** Contoh relax seperti Grok:
```bash
node cli.js config set minVolume 5000
node cli.js config set minMcap 150000
node cli.js config set rugcheckTop10MaxPct 65
```

---

## Workflow lengkap (copy untuk Hermes)

```
1. Owner: "relax filter" / "gas deploy" / "ketatkan"
2. node cli.js positions  → kalau maxPositions penuh, skip screening
3. node cli.js candidates --limit 5  → catat reject reasons
4. Pilih ≤3 parameter dari decision tree (zona hijau)
5. Bilang owner: "Mau ubah X→Y karena [reason]. Gas?"
6. node cli.js config set ...
7. node cli.js candidates --limit 5  → verify ada kandidat
8. Kalau 0 posisi + owner minta deploy: node cli.js screen
9. Report: before/after + posisi baru
```

**Tidak perlu restart daemon** untuk config — kecuali ada perubahan file `.js` (dispatch Grok commit+restart).

---

## Contoh sesi Grok 2026-07-04 (referensi)

**Masalah:** 3 pool, 0 lolos — SEMAN cooldown, FABLE/NEIL rugcheck >60%

**Fix Grok (owner: "relax filter"):**
```bash
node cli.js config set minFeeActiveTvlRatio 0.03
node cli.js config set minVolume 5000
node cli.js config set minMcap 150000
node cli.js config set excludeHighSupplyConcentration false
node cli.js config set maxTop10Pct 35
node cli.js config set rugcheckTop10MaxPct 65
node cli.js config set winRedeployCooldownHours 0
node cli.js config set repeatDeployCooldownEnabled false
```
(+ clear SEMAN cooldown di pool-memory — 8 key config, owner urgent; idealnya 3+3 split)

**Hasil:** FABLE + SEMAN lolos → deploy FABLE (phantom close) → deploy SEMAN spot ✅

---

## Reverse — balik ke profit preset (owner minta "ketatkan")

```bash
node cli.js config set minVolume 8000
node cli.js config set minMcap 200000
node cli.js config set minFeeActiveTvlRatio 0.04
node cli.js config set maxTop10Pct 26
node cli.js config set rugcheckTop10MaxPct 60
node cli.js config set excludeHighSupplyConcentration true
node cli.js config set winRedeployCooldownHours 3
node cli.js config set repeatDeployCooldownEnabled true
```

---

## Red flags setelah ubah config

Dispatch Claude P1 kalau:
- Deploy → close **<2 menit** + peak PnL >20% (phantom PnL bug — FABLE 74%)
- `rebalance FAILED` setelah withdraw
- `Unknown tool` di screening

---

## Skill Hermes

`~/.hermes/skills/meridian/meridian-strategy-optimization/SKILL.md` — analisis post-session (5+ closed positions).

**Operasional harian** → file ini (`HERMES_CONFIG_TUNING.md`).