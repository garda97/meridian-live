# Grok → Hermes Handoff — 2026-07-04 04:13 UTC

_Grok limit (~10% usage). Owner minta semua input ke Hermes. Ini single source of truth sesi ini._

---

## Status LIVE sekarang

| Item | Value |
|------|-------|
| Mode | **LIVE** (`dryRun: false`) |
| Daemon | `meridian-daemon` **active** |
| Wallet | `Dats8FtZFPBTdeYMoBFkXDbLkaccAx8yUU9GESofDZjZ` |
| SOL liquid | ~**0.85 SOL** (~$70) |
| Posisi aktif | **1** — SEMAN-SOL |
| Position ID | `GTSmM7bo18o8AwCxbEZNnV9j8sxdTspxp3os9HANJSrK` |
| Pool | `EHR2s3LNz5d4Bo1oULPEuvxYWGWMxdRJGdZCSB6WKyS1` |
| Strategy | **spot** (auto-rebalance dari bid_ask, 2 menit setelah deploy) |
| In range | ✅ |
| Value | ~$41 |
| Unclaimed fees | ~$0.08 |
| Fee/TVL live | ~137% |
| Deploy amount | 0.5 SOL |
| maxPositions | 1 |

**Dust wallet:** yep (~$0), FABLE (~$0) — abaikan.

---

## Apa yang terjadi sesi ini (kronologi)

1. **yep-SOL cleanup** — posisi orphan ditarik (~0.5 SOL balik), 0 posisi aktif
2. **Screening awal** — 3 pool, semua reject (SEMAN cooldown, FABLE/NEIL rugcheck top10 > 60%)
3. **Owner: "relax filter"** — Grok longgarkan threshold + clear SEMAN cooldown
4. **Deploy FABLE** — 0.5 SOL bid_ask → **auto-close 15 detik** (phantom PnL spike 74% → trailing TP). Net PnL ~0%
5. **Deploy SEMAN** — daemon auto-deploy 0.5 SOL bid_ask → **rebalance ke spot** (strategy drift). Posisi aktif sekarang.

---

## Config yang DIUBAH (owner approve relax)

```json
{
  "minFeeActiveTvlRatio": 0.03,
  "minVolume": 5000,
  "minMcap": 150000,
  "excludeHighSupplyConcentration": false,
  "maxTop10Pct": 35,
  "rugcheckTop10MaxPct": 65,
  "winRedeployCooldownHours": 0,
  "repeatDeployCooldownEnabled": false
}
```

**Cooldown aktif:**
- FABLE pool+mint: sampai ~**07:09 UTC** (win close phantom 0%)
- NEIL: tetap reject rugcheck (top10 69.8% > 65%)

**Gate lain masih ON:** sol_regime, dailyLossLimitUsd=4, trailing TP 4%/1.5%, partial TP 5%/50%, stopLoss -12%

---

## Code change belum commit (Grok)

| File | Perubahan |
|------|-----------|
| `config.js` | +`rugcheckTop10MaxPct` default 60 |
| `tools/screening.js` | rugcheck pakai config, bukan hardcoded 60% |
| `tools/executor.js` | CONFIG_MAP +rugcheckTop10MaxPct, +rugcheckEnabled |
| `pool-memory.json` | SEMAN cooldown dihapus manual |

**PENTING:** Daemon masih proses lama — `rugcheckTop10MaxPct` di user-config sudah 65 tapi **daemon perlu restart** buat load `screening.js` baru. CLI `node cli.js screen` sudah pakai kode baru.

```bash
# Kalau owner/Grok OK:
cd /root/meridian
git add config.js tools/screening.js tools/executor.js
git commit -m "feat: configurable rugcheckTop10MaxPct"
sudo systemctl restart meridian-daemon
```

---

## Known issues — WATCH

### 1. Phantom PnL spike saat deploy (P1)
FABLE: deploy → 5 detik → peak PnL **74%** confirmed → RULE_2 take profit → close. PnL real **0%**.

**Log pattern:**
```
peak PnL confirmed at 74.18% (2 ticks)
trailing TP activated
RULE_2 confirmed: take profit — closing directly
```

**Hermes action:** Monitor SEMAN — kalau close <5 menit setelah deploy dengan peak PnL >20%, dispatch Claude P1: "deploy phantom PnL spike triggers trailing TP".

### 2. FABLE pattern (lesson existing)
FABLE + bid_ask + pump = OOR atas, 0% upside cover. Pool-memory punya history volatile OOR. **Prefer SEMAN spot** atau force spot untuk FABLE redeploy.

### 3. Market tipis
Hanya ~3 pool lolos discovery filter. Relax filter tidak menambah pool baru banyak — cuma unblock FABLE rugcheck + SEMAN cooldown.

---

## Perintah Hermes — tiap sesi

```bash
cd /root/meridian
grep '"dryRun"' user-config.json
node cli.js balance
node cli.js positions
tail -20 decision-log.json
systemctl is-active meridian-daemon
journalctl -u meridian-daemon -n 20 --no-pager | grep -E 'ERROR|rebalance|deploy|close|peak PnL'
```

**Screening manual (kalau owner minta deploy):**
```bash
node cli.js candidates --limit 5
node cli.js screen
```

**JANGAN tanpa owner OK:**
- Ubah threshold `user-config.json` (kecuali owner explicit)
- Commit kode (dispatch Claude)
- Stop daemon kecuali emergency

**BOLEH:**
- Monitor + report owner
- Dispatch Claude via HANDOFF.md
- Restart daemon kalau crash
- `node cli.js manage` read-only observe

---

## Kandidat berikutnya (screening)

| Pool | Status |
|------|--------|
| SEMAN-SOL | ✅ deployed, manage aktif |
| FABLE-SOL | Cooldown ~07:09 UTC; history volatile OOR |
| NEIL-SOL | Rugcheck reject top10 69.8% |

Kalau SEMAN close profit → cooldown win redeploy OFF (config 0h) tapi pool-memory bisa set cooldown lagi setelah close.

---

## GIMI — DIHAPUS (jangan revive)

Semua script/handler/cron GIMI sudah dihapus. Auth JWT OK tapi join API 403 "Not allowed to view this user" — masalah akun GIMI, bukan token. **Lupakan.**

---

## Dispatch Claude — backlog prioritas (kalau perlu)

1. **P1** Phantom PnL guard: ignore peak PnL first N minutes after deploy, atau require min age before trailing TP
2. **P2** `rugcheckTop10MaxPct` commit + restart daemon (Grok belum commit)
3. **P2** test-management-priority.js (dari runbook)

Format dispatch: lihat `notes/GROK_LIMIT_RUNBOOK.md` §Handoff ke Claude.

---

## Owner intent terakhir

- Mau bot **deploy & jalan** — sudah: SEMAN live
- Relax filter — **done**, jangan tighten balik tanpa owner
- Grok limit → **Hermes pegang input/monitor**, Grok standby infra

---

## Hermes ubah config seperti Grok

**Baca:** `notes/HERMES_CONFIG_TUNING.md` — zona toleransi, decision tree, contoh relax sesi ini.

Owner: "relax" / "ketatkan" → `node cli.js config set` max 3 key, zona hijau only.

## Read order Hermes

1. **File ini** (`notes/GROK_SESSION_HANDOFF_2026-07-04.md`)
2. **`notes/HERMES_CONFIG_TUNING.md`** — ubah parameter
3. `notes/GROK_LIMIT_RUNBOOK.md`
4. `notes/HERMES.md` + `notes/SESSION_START.md`
5. `notes/METEORA_LP.md` (konsep DLMM)