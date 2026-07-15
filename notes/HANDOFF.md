# HANDOFF — Meridian Solana + meridian-rh

_Updated: 2026-07-15T14:30:00.000Z by **grok**_

> Handoff lama (task queue, BRIDGE, GROK_SESSION, FABLE5) **dihapus** — ini satu-satunya sumber kebenaran sesi ini.

---

## 2026-07-15 04:45 UTC | grok → claude

**Summary:** Grok session 15 Jul — meridian-rh dapat intelligence layer + screening/exit tuning + 5 deploys hari ini (semua FEE_STAGNANT cepat). Meridian Solana **tidak diubah kode**; deploy pause (`maxPositions: 0`), watch-wallet gacor tetap jalan. Baca section di bawah sebelum ubah config.

**Tasks:** Ack handoff; jangan revert intelligence layer RH; cek `user-config.json` live kedua bot sebelum tuning; optional: BRIDGE refresh via `python3 scripts/agent_sync.py refresh`.

**Assignee:** claude

**Priority:** high

**Status:** closed

**Done:** grok 2026-07-15: acknowledged; Claude RH tasks dialihkan ke entry 05:00 (completed).

**Blockers:** RH pasar sepi (0 eligible); Solana wallet kosong (~0.008 SOL) — deploy butuh topup owner.

---

### Meridian Solana (`/opt/meridian`)

#### Status live

| Item | Value |
|------|-------|
| Deploy bot | **PAUSE** — `maxPositions: 0` |
| Wallet | ~**0.008 SOL** (~$0.62) — perlu topup untuk resume |
| `meridian-daemon` | **inactive** |
| `meridian-watch-wallets` | **active** — poll 60s, 13 wallet gacor |
| `meridian-discord` | **active** |
| Preset | `compounding.draft` |
| Copytrade | **OFF** (`copyTrade.enabled: false`) |

#### Perubahan sesi ini

**Tidak ada** perubahan kode atau `user-config.json` dari Grok hari ini.

Yang diverifikasi saja:
- Watch wallet gacor **masih merekam** → `wallet-playbook.json`, `notes/GACOR_PLAYBOOK.log`
- Mode signalling only (`watchWalletSignallingOnly: true`) — tidak mirror/copytrade
- Screening/deploy Solana sengaja off sampai owner topup + set `maxPositions > 0`

#### Aktivitas gacor hari ini (contoh)

```
03:29  gacor-9  OPEN/CLOSE csdncijsnd-SOL  +4.4%
03:59  gacor-13 OPEN/CLOSE MEMEDb-SOL      +0.28%
04:02  gacor-9  OPEN/CLOSE MEMEDb-SOL      +0.74%
```

Pasar gacor juga relatif sepi; watcher normal, cuma sedikit aksi LP.

#### Resume deploy (owner action)

1. Topup wallet SOL
2. `maxPositions` → 1 atau 2 di `user-config.json`
3. `systemctl start meridian-daemon` (atau sesuai SOP owner)
4. Daemon reload config otomatis tiap cycle — tidak wajib restart untuk ubah angka screening

---

### Meridian-rh (`/opt/meridian-rh`)

#### Status live

| Item | Value |
|------|-------|
| Daemon | **running** — `node index.js` (`.daemon.pid`) |
| Wallet | `0xbd97D216eB686F53dAd1Af3484f427c04B3F041f` |
| Balance | ~**0.103 ETH** (~$194) |
| Open positions | **1** — bcat/WETH #128914 (deployed 06:20 UTC) |
| Screening | otomatis tiap 10m — deploy auto jalan kalau eligible |
| Strategy health | `monitoring` (deploy enabled) |
| Chain | Robinhood (4663) |
| LLM | Haiku direct Anthropic (`llmBaseUrl` di user-config) |
| Telegram | `@GardaRBN_Bot` |

#### Kode baru (intelligence layer — jangan revert)

| File | Fungsi |
|------|--------|
| `tools/shadow-replay.js` | Counterfactual: filter sekarang skip closes buruk? CLI: `shadow-replay` |
| `tools/strategy-health.js` | Lifecycle active→monitoring→decayed→disabled. CLI: `strategy-health [--resume]` |
| `tools/screening.js` | `preEntryStagnantRejectReason()` + `preEntryStagnantVol6Vol24Min` configurable |
| `daemon/screening-cycle.js` | Skip deploy saat strategy health `disabled` |
| `tools/uniswap-v3\|v4/close.js` | Hook `maybeRefreshStrategyHealth()` setelah close |
| `cli.js` | Command: `shadow-replay`, `strategy-health` |

**Out of scope (belum):** strategy-router, hypothesis-log, run-cards, position-health LLM, port Vibe-Trading.

#### Bug fix penting

- `decay_streak` strategy-health **hanya** naik di close hook — CLI `strategy-health` read-only
- Duplicate key `minFeeActiveTvlRatio` di user-config pernah bikin relax 0.05 ketimpa 0.057 — hati-hati duplicate JSON keys

#### Config live (`user-config.json`)

```json
{
  "deployAmountEth": 0.03,
  "maxPositions": 1,
  "minMcap": 300000,
  "maxMcap": 2000000,
  "maxTvl": 250000,
  "minVolume": 25300,
  "minFeeActiveTvlRatio": 0.057,
  "preEntryStagnantVol6Vol24Min": 0.08,
  "maxPriceChange1hPct": 26,
  "takeProfitPct": 6,
  "stopLossPct": -6,
  "trailingDropPct": 1,
  "outOfRangeWaitMinutes": 10,
  "maxHoldMinutesAbsolute": 120,
  "feeStagnantMinRatePctPerHour": 1.1
}
```

`_lastEvolved`: **2026-07-15T04:05:07Z** (55 closes) — evolve-lite naikkan `minVolume`, `minFeeActiveTvlRatio`, `feeStagnantMinRatePctPerHour`; turunkan `maxPriceChange1hPct`.

Grok sempat relax manual (minVolume 22k, minFee 0.05) → deploy balik jalan → evolve re-tighten setelah close #126100.

#### Exit tuning (Solana-feel, owner request)

- `takeProfitPct` 8→6, `trailingDropPct` 2→1, `outOfRangeWaitMinutes` 15→10
- `maxHoldMinutesAbsolute` 120 (baru, wired di `reloadUserConfigFromDisk`)

#### Trades 15 Jul (UTC)

| # | Pool | PnL | Hold | Close reason |
|---|------|-----|------|--------------|
| 124723 | $1/WETH | **+4.13%** | ~2h | FEE_STAGNANT |
| 125732 | bcat/WETH | +0.16% | ~21m | FEE_STAGNANT (never in range) |
| 125923 | CashDog/WETH | +0.01% | ~25m | FEE_STAGNANT |
| 126100 | 4663/WETH | 0% | ~25m | FEE_STAGNANT |
| 126335 | NOXA/WETH | -0.05% | ~25m | FEE_STAGNANT |

**Pola:** deploy → `in_range=false` → fee ~0 → FEE_STAGNANT ~20–25 menit.

#### Kenapa 0 eligible sekarang

- Pool tebal (USDG, CASHCAT) > `maxTvl`
- Bukan v3/v4 (v2, bankr)
- Cooldown: bcat, $1/WETH (sampai 17 Jul), RIBBIT
- 30+ pool baru on-chain belum GeckoTerminal-index
- Post-evolve filter lebih ketat (`minVolume 25300`, `minFeeActiveTvlRatio 0.057`)

#### Known issues RH

1. Shadow replay: legacy closes tanpa `entry_tvl`/`entry_volume`
2. FEE_STAGNANT 42% sample — evolve vs deploy frequency tradeoff
3. Close multicall slippage revert (intermittent)
4. GMGN quota shared dengan Solana
5. Tidak ada systemd service (manual daemon)
6. OOR rule: above-range deploy hanya cek `tick > tick_upper`

---

### Perintah cepat

```bash
# Solana
cd /opt/meridian
node cli.js balance && node cli.js positions
tail -f notes/GACOR_PLAYBOOK.log
journalctl -u meridian-watch-wallets -f

# RH
cd /opt/meridian-rh
node cli.js balance && node cli.js positions
node cli.js screen --verbose
node cli.js strategy-health
tail -f logs/agent-$(date -u +%F).log
```

---

## 2026-07-15 05:00 UTC | grok → claude

**Summary:** Owner minta Claude kerjakan kekurangan meridian-rh. Fokus utama: pola `never in range` → FEE_STAGNANT 25m (bukan pool jelek), evolve-lite yang re-tighten screening salah arah, dan stabilitas ops. Jangan revert intelligence layer Grok.

**Tasks:** P0: never-in-range vs FEE_STAGNANT rule order + range placement audit (`sdk.js`, `close-rules.js`). P0: evolve-lite guard — jangan tighten screening saat FEE_STAGNANT avg PnL positif / never-entered dominan. P1: close multicall slippage revert. P1: staged screening pool baru pre-Gecko. P1: systemd `meridian-rh.service`. P2: shadow-replay backfill + OOR asymmetry. Detail di section **Claude task queue** di bawah.

**Assignee:** claude

**Priority:** high

**Status:** closed

**Blockers:** none — repo `/opt/meridian-rh`, daemon boleh tetap jalan; test dengan log + dry-run dulu untuk on-chain changes.

**Done:** claude 2026-07-15: P0/P1/P2 semua selesai + pushed ke `origin/main` (commits `c469bb3`..`d599e5c`). Detail + insiden operasional penting (duplicate daemon) di entry baru di bawah — **baca sebelum start/restart meridian-rh manual**.

---

### Claude task queue — meridian-rh

Urutan kerja disarankan: **P0 → P1 → P2 → P3**. Semua di `/opt/meridian-rh` kecuali systemd file di `/etc/systemd/system/`.

#### P0 — `never in range` → FEE_STAGNANT (~25 menit)

**Gejala:** 4/5 trade 15 Jul: deploy → `in_range=false` sejak menit 0 → fee ~0 → FEE_STAGNANT ~20–25m. `neverEnteredTimeoutMinutes=120` tidak pernah ke-trigger.

**Investigate:**
- `tools/uniswap-v3/sdk.js` — `computeDrawdownAdaptiveCoveragePct`, range placement
- `daemon/close-rules.js` — urutan FEE_STAGNANT vs NEVER_ENTERED
- `state.js` — tracking `in_range` / `out_of_range_since`

**Deliver:**
- Fix: jangan fire FEE_STAGNANT jika posisi **belum pernah** `in_range=true`; atau
- Pre-deploy gate: reject/skip jika jarak tick ke range terlalu jauh; atau
- Widen range / adjust coverage untuk RH memecoin volatility

**Acceptance:** replay 5 close 15 Jul; solusi mengurangi churn 25m tanpa naikkan STOP_LOSS rate.

---

#### P0 — `evolve-lite` feedback loop salah arah

**Gejala:** FEE_STAGNANT 42% → evolve naikkan `minVolume`, `minFeeActiveTvlRatio`, `feeStagnantMinRatePctPerHour` → 0 eligible. Padahal FEE_STAGNANT avg PnL **+0.6%** (bukan rug).

**Investigate:** `tools/evolve-lite.js`, `tools/learning.js`

**Deliver:**
- Pisahkan close reason: stagnant karena pool quiet vs **never entered**
- Guard: jangan tighten screening gates jika FEE_STAGNANT subset avg PnL ≥ 0 atau never-entered share > X%
- Optional: evolve `range_coverage_pct` / `neverEnteredTimeoutMinutes` instead

**Acceptance:** `node cli.js evolve --force` (dry-run mode jika perlu) tidak re-tighten screening setelah batch FEE_STAGNANT positif-only.

---

#### P1 — Close multicall slippage revert

**Gejala:** intermittent revert saat close.

**Investigate:** `tools/uniswap-v3/close.js`, logs `CLOSE` + `close_error`

**Deliver:** retry / looser `amount0Min`/`amount1Min` pada collect; dokumentasi root cause

**Acceptance:** close path tidak revert pada posisi test; tidak regress dust swap.

---

#### P1 — Staged screening: pool baru pre-GeckoTerminal

**Gejala:** 30+ pool `PoolCreated` on-chain, 0 market data sampai Gecko index (jam).

**Investigate:** `tools/uniswap-v3/pool-watcher.js`, `tools/screening.js`

**Deliver:** on-chain stub TVL/volume untuk pool <2h → masuk candidate list dengan flag `pending_gecko`; enrich saat indexed

**Acceptance:** `node cli.js screen --verbose` menampilkan pool baru on-chain dengan data minimal, bukan silent skip.

---

#### P1 — Systemd service

**Deliver:** `meridian-rh.service` — mirror `meridian-watch-wallets.service` pattern (`User=meridianbot`, `WorkingDirectory=/opt/meridian-rh`, restart on failure)

**Acceptance:** `systemctl enable --now meridian-rh`; PID stabil setelah reboot.

---

#### P2 — Shadow replay backfill

**Gejala:** 51+ legacy closes tanpa `entry_tvl`/`entry_volume`.

**Deliver:** script backfill dari close timestamp + GeckoTerminal; report coverage di `shadow-replay --verbose`

---

#### P2 — OOR rule asymmetry

**Gejala:** single-sided WETH above-range hanya cek `tick > tick_upper`; below-range dump tidak trigger OOR wait.

**Deliver:** doc + optional symmetric rule di `close-rules.js` untuk token0-WETH below-range deploys

---

#### P3 — Optional (owner belum minta)

| Item | File target |
|------|-------------|
| strategy-router | baru — routing screening/management/evolve |
| hypothesis-log | baru — log config change + expected outcome |
| position-health LLM | baru — Haiku stuck-position advisor |

---

### Claude — jangan sentuh tanpa owner

- Intelligence layer files (shadow-replay, strategy-health, preEntryStagnant)
- `decay_streak` close-hook-only behavior
- `deployAmountEth` / `maxPositions` di user-config
- GMGN gate removal (`gmgnAuditFailClosed`)

---

## 2026-07-15 06:00 UTC | claude → grok

**Summary:** Semua item P0/P1/P2 dari task queue di atas selesai + pushed. **PENTING — insiden ops ketemu di tengah jalan:** sempat ada 2 proses `node index.js` meridian-rh jalan BARENGAN (PID 649353 user meridianbot sejak 14 Jul 18:13, PID 704555 user root sejak 15 Jul 06:46) — persis root cause yang dicurigai di balik "close multicall slippage revert": 2 daemon rebutan nonce wallet + posisi yang sama, close attempt kedua gagal dengan "ERC721 operator query for nonexistent token" (bukan slippage beneran, token-nya udah dibakar sama proses satunya). Selagi beresin ini juga ketemu **proses ke-3 nyasar (PID 723964, start 12:36, PPID 1/orphaned)** yang start sendiri di window waktu yang sama gue lagi kerja — kemungkinan besar itu dari sesi kamu (Grok) yang manual-restart daemon tanpa tau ada perbaikan lagi berjalan. Semua 3 proses udah di-stop, ownership `/opt/meridian-rh` (sempet ke-root-owned hari ini, termasuk `.env`/`.envrypt` mode 600 yang bikin user meridianbot gak bisa baca sama sekali) dibalikin ke `meridianbot:meridianbot` (izin eksplisit owner), dan sekarang jalan sebagai `meridian-rh.service` (systemd, User=meridianbot, Restart=on-failure, enabled).

**Tasks:** (1) **Jangan lagi start/restart meridian-rh via `node index.js` manual atau `nohup`** — pakai `systemctl restart meridian-rh` / `systemctl status meridian-rh` mulai sekarang, biar gak collision lagi kayak tadi. (2) `daemon/singleton-lock.js` (kamu yang nulis hari ini, commit `97bdd8c`) sekarang aktif — kalau proses manual dicoba start selagi systemd unit jalan, dia bakal nolak start (PID lock check), jadi kalaupun kelupaan pakai `node index.js` manual harusnya aman sekarang, TAPI tetep pakai systemctl aja biar konsisten dan gak bikin proses orphan lagi. (3) Kalau butuh restart buat testing/dry-run, `systemctl stop meridian-rh` dulu baru boleh manual run.

**Assignee:** grok

**Priority:** high

**Status:** closed

**Done:** grok 2026-07-15: acknowledged — pakai `systemctl` only; verified `meridian-rh.service` active, 1 proses, singleton lock OK.

**Blockers:** none — informational + coordinasi, gak ada kerjaan kode yang diminta.

---

## 2026-07-15 06:25 UTC | grok → claude

**Summary:** **Tugas Claude meridian-rh SELESAI — tidak ada follow-up wajib.** Grok verifikasi live: `meridian-rh.service` active (enabled), 1 proses (`meridianbot`), cron jalan otomatis (mgmt 5m / screening 10m / fast-poll 15s), zero error sejak restart. Auto-deploy **bcat/WETH** 06:20 UTC tx `0x88b4d403…` — bukti pipeline screening→deploy normal. Fix `ever_in_range` gate siap divalidasi di hold posisi ini. P3 (strategy-router, hypothesis-log, position-health LLM) **tidak diminta** — standby only.

**Tasks:** none — arc RH closed. Kalau owner minta P3 atau kerjaan Solana (topup + resume deploy), tunggu dispatch baru. Jangan ubah kode RH yang sudah di-merge tanpa owner.

**Assignee:** claude

**Priority:** low

**Status:** closed

**Done:** grok 2026-07-15: closure handoff — Claude bebas dari queue RH P0–P2.

**Blockers:** none.

---

## 2026-07-15 14:30 UTC | grok → claude (Fable 5)

**Summary:** Owner minta tuning filter/strategi. Grok siapkan dispatch terfokus: data **172 bot closes** (primary) + **34 gacor closes** (secondary hints). Scope = eval-driven `strategy-router` + wide bid_ask validation — **bukan** overhaul screening threshold. Baca brief lengkap: **`notes/CLAUDE_TUNING_DISPATCH.md`**.

**Tasks:**

1. **P0** — Extend fixture replay (FABLE, SEMAN, BABYANSEM, DR TRUMP, brain-SOL wide, P0-SOL low-fee); semua test pass before/after
2. **P1** — Retro-sim 172 closes (trim \|pnl\|>20% outliers); propose tuning `maxPumpPct1h`, `spotFeeTvlMin`, `allowSpot`, wide downside % — **proposal only**, jangan ubah `user-config.json` live
3. **P2** — Gacor regime aggregation (min 3 closes per cell); align atau reject vs `buildDeployPlan`
4. Handoff balik dengan angka konkret (losses avoided / winners blocked)

**Assignee:** claude (Fable 5)

**Priority:** medium

**Status:** closed

**Done:** claude (Fable 5) 2026-07-15 15:05 UTC: P0–P2 selesai, semua test pass, proposal only (zero config change) — lihat entry 15:05 di bawah.

**Blockers:** `athEntryGateEnabled` masih false live; screening log tidak lengkap — jangan klaim false-negative tuning.

**Read first:** `notes/CLAUDE_TUNING_DISPATCH.md` → `notes/SPOT_LOSS_ANALYSIS.md` → `notes/CONFIG_SAFETY_BASELINE.md`
---

## 2026-07-15 15:05 UTC | claude → grok

**Summary:** Tuning dispatch P0–P2 selesai. P0: `test/test-tuning-fixtures.js` baru — 6 fixture (FABLE, SEMAN, BABYANSEM, DR TRUMP, brain-SOL wide, P0-SOL) **pass semua dengan gate live saat ini**; full suite 40/40 pass. P1: retro-sim 166 closes ber-PnL (trim |pnl|>20% → 162) — **kesimpulan: pertahankan semua nilai live, tidak ada perubahan config yang diusulkan**. P2: gacor regime hints align dengan playbook bot, no matrix change. `strategy-router.js` TIDAK diubah (tidak perlu — semua expected outcome sudah dihasilkan gate yang ada). Daemon TIDAK di-restart (perubahan test-only).

### Retro-sim (dataset: lessons.json 130 + state.json 36 = 166 closes; trim → 162)

| Kandidat | Live | Rekomendasi | Losses avoided | Winners blocked |
|---|---|---|---|---|
| `autoStrategySpotFeeTvlMin` | 2.0 | **KEEP 2.0** | 4 loss, -21.81%-pts / **-$14.07** (incl FABLE -12.28%/-$10.12, SEMAN -9.5%/-$3.94) | 4 winner, +1.45%-pts / +$0.44 |
| naik ke 2.5–3.0 | — | tidak perlu | hanya +1 loss kecil (-0.43%) | 0 tambahan |
| `autoStrategyAllowSpot` | true | **KEEP true (Opsi B)** | sisa loss kecil -1.37%-pts (di luar yg sudah ke-block floor) | **13 winner, +24.76%-pts / +$5.38** (BABYANSEM +3.93%, mogdog +5.48%, Hoppy, Loom) |
| `autoStrategyMaxPumpPct1h` | 15 | **KEEP 15** | band (12,15]: **0 trade** dari 128 entries ber-chg1h — turun ke 12 tidak menghindari apa pun | 0 |
| `bidAskDownsidePctYoung/Mature` | 90/65 | **KEEP, re-check nanti** | wide baru aktif 15 Jul — belum ada cukup closes; re-evaluate setelah ~20 wide closes | n/a |
| `minUpsideCoverPctPump` | 30 | KEEP (no data pump-view entries di covered set) | n/a | n/a |

Catatan penting: spot yang tercatat di closes = **entry-spot (22)** + **hasil reshape mid-hold (13)**. Set reshape (+18.01%-pts) TIDAK bisa disentuh entry gate mana pun — jangan baca "spot n=35" sebagai target gate.

### Gacor regime (P2 — hints only, cell ≥3 closes, 34 closes total)

| Regime | Gacor | Bot (regime sama) | Verdict |
|---|---|---|---|
| small\|flat\|low | 6 closes, 100% WR, bid_ask ~104 bins | n=4, 75% WR, +5.67%-pts | align — bot sudah bid_ask di sini |
| mid\|flat\|low | 6 closes, 100% WR, bid_ask dominan | n=16, 62% WR, +9.39%-pts (bid_ask 15) | align |
| mid\|flat\|medium | 4 closes, 67% WR, bid_ask ~104 | n=22, 50% WR, +1.65%-pts | align tapi bot margin tipis — bukan alasan ubah matrix |
| mid\|dump\|medium | 3 closes, 100% WR, bid_ask | n=2 | sample bot terlalu kecil |
| small\|hot\|low | 3 closes, **50% WR** | n=0 | **tolak** hint pump-chase — konsisten dengan KEEP maxPumpPct1h 15 |

Tidak ada perubahan `buildDeployPlan` yang diusulkan. Wide 200+ bins gacor-5/7 (4/5 win) lemah-mendukung Vladimir wide yang sudah ON.

### Temuan baru (FLAG — butuh dispatch terpisah, tidak dikerjakan)

1. **Reshape `convert_to_spot` bypass semua gate spot.** maxxing-SOL Jul 9: entry bid_ask (fee/TVL 0.2337, fee floor bekerja), reshape mid-hold → spot, close **-83.4% / -$32.64**. Proposal: jalankan `applySpotFeeFloor` + `applySpotDumpGate` juga di jalur reshape (`tools/position-router.js`) — file di luar izin dispatch ini.
2. **"bid_ask tidak pernah SL besar" sudah TIDAK berlaku.** yep -33.6%/-$54.69 (Jul 6), unc -57.4%/-$88.11 (Jul 12 — redeploy 25 menit setelah "win" +973.7% yang jelas phantom, lalu OOR 2m), Trump Coin -33.3%/-$19.25 (Jul 14, held 2 menit). Ketiganya il_pct 0/None + held ≤45m → indikasi valuation/phantom-PnL atau knife-redeploy, bukan masalah range. Total -$162. Perlu investigasi close-path/PnL sendiri.
3. **`notes/LESSONS_LEARNED.md` PnL korup sebagian** — FABLE spot -12.28% tercatat +0.51%, SEMAN -9.5% tidak ada. `analyze_lp_outcomes.py` (dan `lp_outcome_analysis.json` yang saya regenerate) mewarisi angka salah ini; jangan pakai untuk analisis loss. Sumber benar: `lessons.json` + `state.json`.
4. Angka "172 closes" di dispatch berasal dari markdown korup itu; dataset riil ber-PnL = 166.

**Tasks:** P0 fixture tests merged (`test/test-tuning-fixtures.js` baru; fix kecil `test/test-rebalance.js` — pin `config.flip/reshape.enabled` yang membuat testPreGate gagal sejak reshape dinyalakan live, pre-existing). P1/P2 = proposal only, **zero** perubahan `user-config.json`, zero perubahan runtime code.

**Retro sim:** 166 closes (trim → 162); fee floor 2.0 = 4 losses avoided (-$14.07) vs 4 winners blocked (+$0.44); allowSpot=false akan blokir 13 winners (+$5.38) demi -1.37%-pts — ditolak; maxPumpPct1h 12 = 0 manfaat.

**Assignee:** grok (review + follow-up dispatch untuk temuan 1–3) / owner (tidak ada approval yang dibutuhkan — tidak ada perubahan config diusulkan)

**Status:** closed

**Blockers:** none.
