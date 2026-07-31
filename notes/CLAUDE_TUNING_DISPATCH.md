# Claude / Fable 5 — Strategy Tuning Dispatch

_Dispatched: 2026-07-15 by **grok** (owner request) | Target: `/opt/meridian` Solana bot only_

> **Scope sempit:** eval-driven tuning `strategy-router` + wide-range bid_ask dari data trade bot + regime hints gacor. **Bukan** overhaul screening threshold tanpa fixture false-negative.

---

## Startup (wajib)

```bash
cd /opt/meridian
head -40 notes/SESSION_START.md
node cli.js balance
node cli.js positions
python3 scripts/analyze_lp_outcomes.py
node scripts/report-wallet-playbook.mjs
node test/test-spot-pump-gates.js
node test/test-strategy-matrix.js
grep -E "bidAsk|autoStrategy|allowSpot|maxPump|spotFee" user-config.json
```

Baca juga: `notes/SPOT_LOSS_ANALYSIS.md`, `notes/CONFIG_SAFETY_BASELINE.md`, `notes/lp_outcome_analysis.json`.

---

## Konteks live (2026-07-15)

| Item | Value |
|------|-------|
| Daemon | `meridian-daemon` **active** |
| Watch gacor | `meridian-watch-wallets` **active** (signalling only) |
| `maxPositions` | 2 |
| `deployAmountSol` | 0.75 |
| `takeProfitPct` | 4% (full TP, partial off) |
| Spot/curve | **ON** (`autoStrategyAllowSpot/Curve: true`) |
| Wide bid_ask | **ON** — young 90% / mature 65% downside (Vladimir-style) |
| Deploy fix hari ini | `sdk.js` fresh blockhash + `addLiquidityChunked` partial adopt (`deploy.js`) |

**Jangan revert** deploy wide-range fix atau `notifyDeploy` live-message gate tanpa owner.

---

## Dataset — apa yang cukup & apa yang tidak

### Bot trade data (PRIMARY)

| Metric | Value |
|--------|-------|
| Closed positions | **172** analyzed (`scripts/analyze_lp_outcomes.py`) |
| `signal_snapshot` coverage | ~97% closed |
| `entry_mcap` coverage | ~99% closed |
| Winrate | ~70% (raw) |
| **Normal avg PnL** (exclude \|pnl\|>20%) | **~+0.30%** — pakai ini, bukan avg +6.75% mentah |
| Outliers distorsi avg | unc +974%, FABLE +74%, drooling +41% (3 trades) |

**By strategy (raw avg — hati-hati outlier):**

| Strategy | n | Winrate | Avg PnL |
|----------|---|---------|---------|
| bid_ask | 130 | 65% | +8.89%* |
| spot | 34 | 85% | +0.03% |
| curve | 8 | 88% | +0.59% |

\*Skew outlier; median spot/bid_ask normal trade ≈ 0–1%.

**Loss patterns sudah terdokumentasi:**

- FABLE spot -12.28% (pump +34% 1h, fee 0.92%)
- SEMAN spot -9.5% (dump -28% 1h, fee 0.37%)
- Spot net historis ≈ **-$9.9** vs bid_ask tidak pernah SL besar

### Gacor wallet data (SECONDARY — hints only)

| Metric | Value |
|--------|-------|
| Wallets tracked | 12 |
| Opens / closes | 38 / 34 |
| Wins / losses | ~24 / ~5 (~82% WR) |
| Data age | ~1–2 minggu |
| Regime fields | `mcap_bucket`, `pump_bucket`, `vol_bucket`, inferred strategy, `width_bins`, `range_style` |

**Pola dominan gacor (jangan jadi hard filter tanpa N besar):**

- Strategy: **bid_ask** dominan; curve/spot jarang
- Range: medium ~50–70 bins ATAU wide 200–350 bins (gacor-5, gacor-7)
- Regime sering: `small/hot/low`, `mid/flat/low`, `mid/flat/medium`
- Sizing gacor >> bot (contoh gacor-9 deploy 7 SOL vs kita 0.75) — **tidak comparable langsung**

### Data GAPS (jangan klaim tuning penuh screening)

- `decision-log.json` rolling **100 entry** — histori skip lama hilang
- Tidak ada DB semua token di-scan (false negative tidak terukur)
- Gacor N per regime cell sering **1–2** — statistik lemah
- Copytrade **OFF** — gacor tidak mirror ke bot

---

## Sudah diimplement (jangan regresi)

| Item | File | Test |
|------|------|------|
| P1a pump cap semua strategi | `strategy-router.js` `applyPumpChaseCap` | `test-spot-pump-gates.js` |
| P1b spot fee floor universal | `applySpotFeeFloor` | `test-spot-pump-gates.js` |
| P1c spot dump gate | `applySpotDumpGate` | `test-strategy-matrix.js` |
| P2a ATH fail-closed + 429 cache | `chart-indicators.js` | `test-strategy-matrix.js` |
| P2b bool config coerce | `config.js` | `test-config-bool.js` |
| Vladimir wide bid_ask | `applyBidAskWideRange` | `test-strategy-matrix.js` |
| Wide deploy tx safety | `sdk.js`, `liquidity.js`, `deploy.js` | manual — belum test file |

---

## Tugas (prioritas)

### P0 — Eval harness dulu (SEBELUM ubah kode)

Buat/extend fixture replay di `test/test-strategy-matrix.js` atau file baru `test/test-tuning-fixtures.js`:

| Fixture | Expected setelah tuning |
|---------|-------------------------|
| FABLE Jul 4 | **BLOCK** deploy (pump +34% atau fee <2 spot) |
| SEMAN dump | **BLOCK** spot (dump <-15%) |
| BABYANSEM spot | **ALLOW** (fee 3.96%, winner +4.84%) |
| DR TRUMP spot | **ALLOW** (fee 4.94%, winner) |
| brain-SOL Jul 15 wide bid_ask | Plan `downside_pct` 90%, bins >69, strategy bid_ask |
| P0-SOL spot low fee | **BLOCK atau fallback bid_ask** (fee 0.32%) |

Jalankan semua test suite sebelum & sesudah perubahan:

```bash
node test/test-spot-pump-gates.js
node test/test-strategy-matrix.js
node test/test-config-bool.js
node test/test-retry-ladder.js
```

### P1 — Tuning terfokus strategy-router (kode OK, config butuh owner approve)

Kandidat parameter — **proposal only di handoff**, eksekusi `user-config.json` = owner/Hermes/Grok:

| Parameter | Live | Kandidat arah | Data support |
|-----------|------|---------------|--------------|
| `autoStrategyMaxPumpPct1h` | 15 | Pertahankan atau turun ke 12–15 | FABLE blocked @15; gacor `hot` regime mixed |
| `autoStrategySpotFeeTvlMin` | 2.0 | Pertahankan 2.0 | SEMAN/FABLE blocked; winners spot ≥3% fee |
| `autoStrategyAllowSpot` | true | **Opsi A:** false (defensive) / **Opsi B:** true + gates ketat | Spot net negatif historis |
| `bidAskDownsidePctYoung` | 90 | Validasi 80–90% | Vladimir + gacor wide 200+ bins |
| `bidAskDownsidePctMature` | 65 | Validasi 60–70% | Mature pool brain-SOL class |
| `minUpsideCoverPctPump` | 30 | Review vs OOR pump atas | FABLE OOR pattern bid_ask 0% upside |

Deliverable P1: tabel **before/after simulation** pada 172 closes (trim outliers \|pnl\|>20%), hitung: berapa loss FABLE/SEMAN terhindar, berapa winner spot ikut ke-block.

### P2 — Gacor regime → strategy hints (read-only analisis → 1 PR kecil max)

Dari `wallet-playbook.json` + `report-wallet-playbook.mjs`:

1. Agregasi per `regime_key`: dominant strategy, avg `width_bins`, win_rate (min sample **≥3** closes)
2. Bandingkan dengan `buildDeployPlan` matrix di `strategy-router.js`
3. **Hanya** propose perubahan kalau regime gacor **align** dengan bot bid_ask wins (bukan copy sizing)

Contoh output yang diterima:

> "Regime `mcap_small|pump_hot|vol_low`: gacor 100% bid_ask medium 69 bins, bot bid_ask same regime avg +X%. Rekomendasi: defaultBinsBelow 69 untuk pump_hot small mcap."

Contoh output yang **ditolak**:

> "Turunkan minOrganic ke 60 karena gacor suka token organic 71."

### P3 — Out of scope (jangan kerjakan tanpa dispatch baru)

- Ubah `minTvl`, `minOrganic`, `maxTop10Pct`, `minMcap` screening
- Enable copytrade dari gacor
- Refactor besar `tools/dlmm/*`
- Ubah `user-config.json` live tanpa owner approve eksplisit
- `athEntryGateEnabled` masih **false** live — jangan enable tanpa owner

---

## Acceptance criteria

1. Semua existing test pass (minimal 4 file di atas)
2. Fixture replay documented — setiap perubahan gate punya pass/fail token
3. Simulasi retro 172 closes dengan outlier trim — angka konkret di handoff
4. **Zero** perubahan screening threshold di `user-config.json` tanpa section "OWNER APPROVE"
5. Handoff balik ke grok/Hermes: `notes/HANDOFF.md` entry + ringkasan 5 bullet

---

## File yang boleh disentuh

| File | Izin |
|------|------|
| `tools/strategy-router.js` | ✅ tuning pure functions |
| `test/test-strategy-matrix.js` | ✅ fixtures |
| `test/test-spot-pump-gates.js` | ✅ fixtures |
| `test/test-tuning-fixtures.js` | ✅ baru |
| `notes/lp_outcome_analysis.json` | ✅ regenerate |
| `user-config.json` | ❌ proposal only |
| `tools/screening.js` | ❌ out of scope |
| `config.js` defaults | ⚠️ hanya kalau test-driven + dokumentasi |

---

## Referensi cepat

```bash
# Regenerate outcome stats
python3 scripts/analyze_lp_outcomes.py

# Gacor report
node scripts/report-wallet-playbook.mjs

# Sample closed position dengan snapshot
node -e "
import fs from 'fs';
const st = JSON.parse(fs.readFileSync('state.json','utf8'));
const c = Object.values(st.positions).filter(p=>p.closed&&p.signal_snapshot).slice(-3);
console.log(JSON.stringify(c.map(p=>({pool:p.pool_name,strat:p.strategy,pnl:p.pnl_pct,snap:p.signal_snapshot})),null,2));
"
```

---

## Handoff balik (template)

```markdown
## YYYY-MM-DD HH:MM UTC | claude → grok

**Summary:** [apa yang dianalisis + apa yang diubah]

**Tasks:** [PR merged / proposal only]

**Retro sim:** [N closes, X losses avoided, Y winners blocked]

**Assignee:** grok (deploy) / hermes (config) / owner (approve)

**Status:** [open/closed]

**Blockers:** [none / butuh owner approve config]
```