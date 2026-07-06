# CLAUDE_AGENT.md — Ace Card Meridian (on-demand)

Claude = **kartu AS** — analisis mendalam & refactor berat. Relay OFF, jalan hanya saat owner/Grok/Hermes dispatch manual.

**Saat Grok limit:** baca `notes/GROK_LIMIT_RUNBOOK.md` — terima dispatch dari Hermes, handoff balik ke Hermes (bukan Grok).

## Startup wajib setiap sesi

**Single source of truth:** `notes/SESSION_START.md` — jalankan Langkah 0–1, lalu baca file ini.

**Slash command:** `/session-start` — menjalankan ritual startup otomatis.

```bash
cd /root/meridian
# Atau cukup: /session-start dari Claude Code
head -80 notes/SESSION_START.md
python3 scripts/agent_sync.py status
head -60 notes/HANDOFF.md
grep '"dryRun"' user-config.json    # JANGAN asumsikan DRY_RUN dari catatan lama
node cli.js balance
node cli.js positions
tail -200 notes/METEORA_LP.md
LATEST=$(ls -t notes/x-scrape/*.md 2>/dev/null | head -1)
[ -n "$LATEST" ] && head -100 "$LATEST"
head -80 CLAUDE.md
```

## Tugas kamu (fase: Phase 2 live)

### P1 — Pahami sistem dulu (read-only)

1. Baca `CLAUDE.md` § Architecture + § Persistent files — ReAct loop SCREENER/MANAGER
2. Verifikasi mode: `grep dryRun user-config.json` + `node cli.js balance`
3. Baca `agent.js`, `index.js` hanya jika ada task handoff atau investigasi bug
4. Cek task terbuka assignee `claude` di `notes/HANDOFF.md`

### P2 — Fix kualitas agent loop (kalau owner/dispatch minta)

- Investigasi `Empty response, retrying` — model 9router, prompt, atau tool schema?
- Review gate Phase 2: ATH entry, SOL regime, auto strategy di `strategy-router`
- Saran readability `decision-log.json` untuk Hermes

### P3 — Jangan lakukan tanpa owner approve

- Ubah `user-config.json` threshold deploy live
- Ubah `dryRun`
- Refactor besar `tools/dlmm.js` — pecah bertahap dengan plan dulu
- Enable `tgeMaxAgeHours`, `shareExitEnabled`, `minEstimatedSharePct`, atau turunkan `pnlWarmupMinutes` ke 0

**Baseline config owner:** `notes/CONFIG_SAFETY_BASELINE.md` — baca sebelum propose threshold; eksekusi config = Hermes/Grok, bukan Claude.

## Slash commands built-in (dari `/root/meridian`)

| Command | Kegunaan |
|---------|----------|
| `/session-start` | Ritual awal sesi — bridge, state live, materi LP |
| `/candidates` | Lihat pool kandidat |
| `/positions` | Posisi terbuka + PnL |
| `/screen` | Satu cycle screening |
| `/manage` | Satu cycle management |
| `/balance` | Wallet SOL + token |

## Handoff balik

```bash
python3 scripts/agent_sync.py handoff \
  --from claude --to hermes \
  --summary "Analisis selesai: ..." \
  --tasks "none" --status closed \
  --done "file1; file2"
```

## Konteks live

**Selalu verifikasi** via `/session-start` — snapshot di bawah bisa stale.

- Wallet: `Dats8FtZFPBTdeYMoBFkXDbLkaccAx8yUU9GESofDZjZ`
- Mode: cek `user-config.json` → `dryRun: false` (Phase 2 live, Jul 2026)
- Gates: `athEntryGateEnabled: true`, `solRegimeGateEnabled: true`
- LLM: 9router `Hermes-free` di `127.0.0.1:20128`
- Services: `meridian-daemon`, `meridian-discord`