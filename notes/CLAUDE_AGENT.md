# CLAUDE_AGENT.md — Ace Card Meridian (on-demand)

Claude = **kartu AS** — analisis mendalam & refactor berat. Relay OFF, jalan hanya saat owner/Grok dispatch manual.

## Startup wajib

```bash
cd /root/meridian
cat notes/BRIDGE.md | head -50
cat notes/HANDOFF.md | head -80
cat CLAUDE.md | head -80          # engineering manual Meridian
```

## Tugas kamu (fase: learning_dry_run)

### P1 — Pahami sistem dulu (read-only)

1. Baca `CLAUDE.md` § Architecture + § Persistent files — pahami ReAct loop SCREENER/MANAGER
2. Baca `agent.js`, `index.js` (cron screening 30m / management 10m)
3. Baca `tools/wallet.js`, `utils/helius-rotator.js` — infra yang baru ditambahkan Grok
4. Ringkas di handoff: apa yang perlu diperbaiki sebelum live

### P2 — Fix kualitas agent loop (kalau owner approve)

- Investigasi `Empty response, retrying` di log dry run — apakah model 9router, prompt, atau tool schema?
- Review `user-config.json` threshold screening (minTvl, minOrganic, dll) — cocok untuk belajar Meteora?
- Saran perbaikan `decision-log.json` readability untuk Hermes

### P3 — Jangan lakukan tanpa owner approve

- Ubah `user-config.json` threshold deploy live
- Matikan `DRY_RUN`
- Refactor besar `tools/dlmm.js` (2000+ baris) — pecah bertahap dengan plan dulu

## Slash commands built-in (dari `/root/meridian`)

| Command | Kegunaan |
|---------|----------|
| `/candidates` | Lihat pool kandidat |
| `/positions` | Posisi terbuka + PnL |
| `/screen` | Satu cycle screening |
| `/manage` | Satu cycle management |

## Handoff balik

```bash
python3 scripts/agent_sync.py handoff \
  --from claude --to hermes \
  --summary "Analisis selesai: ..." \
  --tasks "none" --status closed \
  --done "file1; file2"
```

## Konteks live sekarang

- Wallet: `Dats8FtZFPBTdeYMoBFkXDbLkaccAx8yUU9GESofDZjZ` (0 SOL)
- Mode: **DRY_RUN=true**, daemon `npm run dev` jalan
- LLM: 9router `Hermes-free` (bukan OpenRouter — key invalid)
- Screening cycle pertama: simulasi deploy RUSH-SOL, agent step 10+/20