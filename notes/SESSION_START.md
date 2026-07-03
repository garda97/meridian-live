# SESSION_START.md — Ritual awal sesi (Hermes · Claude · Grok)

**Baca file ini dulu** setiap sesi baru sebelum analisis, deploy, atau dispatch.

| Agent | Peran | Detail peran |
|-------|-------|--------------|
| **Hermes** | Otak | Screening pool, keputusan deploy/skip/close, routing ke Grok/Claude |
| **Grok** | Eksekutor | Infra VPS, fix bug, monitor daemon, deploy kode |
| **Claude** | Ace card | Analisis arsitektur mendalam, refactor berat (on-demand) |

Project: `/root/meridian` · screening_g97 **decommissioned** (backup di GitHub saja).

---

## Langkah 0 — Semua agent (WAJIB)

```bash
cd /root/meridian

# Bridge + handoff
python3 scripts/hermes_bridge.py connect
python3 scripts/agent_sync.py status
head -60 notes/HANDOFF.md
head -40 notes/BRIDGE.md

# Mode & config live (JANGAN percaya catatan lama — cek ini)
grep -E '"dryRun"|"athEntryGateEnabled"|"solRegimeGateEnabled"|"deployAmountSol"' user-config.json

# State operasional
node cli.js balance
node cli.js positions
tail -c 4000 decision-log.json

# Services
systemctl is-active meridian-daemon meridian-discord 2>/dev/null || true
journalctl -u meridian-daemon -n 8 --no-pager 2>/dev/null | tail -5
journalctl -u meridian-discord -n 8 --no-pager 2>/dev/null | tail -5
```

**Anti-phantom (Hermes/Grok):** jangan tulis dispatch sebagai teks — **jalankan** `hermes_bridge.py dispatch` lewat tool, lalu refresh `agent_sync.py status`.

---

## Langkah 1 — Materi LP Meteora (WAJIB baca)

Hermes & Claude belajar dari file, bukan hafalan sesi.

```bash
cd /root/meridian

# Teori + thread yang sudah dirangkum (Evil Panda, Printboard, MeteoraFR, dll.)
tail -200 notes/METEORA_LP.md

# Alpha X terbaru (cron 05:00 UTC harian)
LATEST=$(ls -t notes/x-scrape/*.md 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  echo "=== x-scrape: $LATEST ==="
  head -100 "$LATEST"
else
  python3 scripts/x_scrape_lp.py
fi

tail -5 logs/x-scrape-cron.log 2>/dev/null || true
```

**Checklist setelah baca:**
- [ ] Ada pool/token hot di Printboard? → watchlist manual, bandingkan gate Phase 2 di `METEORA_LP.md`
- [ ] Thread strategi baru? → catat; append ke `METEORA_LP.md` via dispatch **Grok** jika owner approve
- [ ] Konflik materi X vs `user-config.json`? → catat di notes, **jangan** ubah config sendiri

**Skills terkait:** `meridian-lp-strategy` (Langkah 0), `meridian-gmgn-audit`, `meridian-session-startup` (Hermes).

---

## Langkah 2 — Per agent

### Hermes (otak)

1. Jalankan **Langkah 0 + 1** di atas.
2. Baca `notes/HERMES.md` — routing, Discord, GMGN, hierarki simpan ilmu.
3. Cek Discord listener (monitor saja):
   ```bash
   node cli.js discord-signals
   journalctl -u meridian-discord -n 15 --no-pager | grep -E 'Connected|QUEUED|REJECT' | tail -8
   ```
4. GMGN ringkas kandidat:
   ```bash
   python3 scripts/meridian_gmgn_audit.py --candidates --limit 5
   ```
5. Report ke owner: daemon OK?, keputusan SCREENER/MANAGER terakhir, pool menarik, masalah infra.
6. Dispatch **Grok** P1 jika daemon/discord/LLM mati; **Claude** P2 untuk empty LLM response berulang.

**Skill startup:** `~/.hermes/skills/meridian-session-startup/SKILL.md`

**Jangan:** edit `user-config.json` tanpa owner; deploy on-chain manual; enable Telegram di Hermes (409 conflict dengan Meridian bot).

### Claude (ace card, on-demand)

1. Jalankan **Langkah 0 + 1** di atas.
2. Baca `notes/CLAUDE_AGENT.md` + `CLAUDE.md` § Architecture + § Persistent files.
3. Jika ada task di `HANDOFF.md` assignee `claude` → kerjakan, lalu handoff balik:
   ```bash
   python3 scripts/agent_sync.py handoff \
     --from claude --to hermes \
     --summary "..." --tasks "none" --status closed --done "..."
   ```
4. Investigasi teknis hanya kalau diminta: `agent.js`, `index.js`, empty LLM response, gate ATH/SOL regime.

**Slash command:** `/session-start` — jalankan ritual ini otomatis.

**Jangan:** ubah threshold live atau `dryRun` tanpa owner approve.

### Grok (eksekutor)

1. Jalankan **Langkah 0**; baca `notes/GROK.md` + task untuk `grok` di `HANDOFF.md`.
2. Verifikasi infra; fix; handoff balik ke Hermes setelah selesai.

---

## Konteks live (verifikasi Langkah 0 — bisa berubah)

| Item | Nilai terakhir diketahui (Jul 2026) |
|------|-------------------------------------|
| Fase | **Phase 2 live** — `dryRun: false` |
| Wallet | `Dats8FtZFPBTdeYMoBFkXDbLkaccAx8yUU9GESofDZjZ` |
| LLM | 9router `127.0.0.1:20128` · model `Hermes-free` |
| Gates | `athEntryGateEnabled: true`, `solRegimeGateEnabled: true`, `solDump1hPctThreshold: -3` |
| Deploy | `deployAmountSol: 0.5`, `maxPositions: 1`, strategy `bid_ask` + auto strategy |
| Discord | `meridian-discord` · Rick bot · MeteoraIDN · mode `merge` |
| X scrape | Cron `0 5 * * *` → `notes/x-scrape/YYYY-MM-DD.{json,md}` |

Selalu **override** tabel ini dengan output Langkah 0 (`balance`, `positions`, `decision-log`).

---

## File source of truth

| File | Isi |
|------|-----|
| `notes/SESSION_START.md` | **Ini** — ritual awal sesi |
| `notes/HERMES.md` | SOP lengkap Hermes |
| `notes/CLAUDE_AGENT.md` | SOP Claude |
| `notes/GROK.md` | SOP Grok |
| `notes/METEORA_LP.md` | Knowledge base LP + Printboard + akun X |
| `notes/x-scrape/` | Alpha harian dari X |
| `notes/HANDOFF.md` | Task queue antar agent |
| `notes/BRIDGE.md` | Status sinkron |
| `notes/CURRENT.md` | Fase project |
| `user-config.json` | Threshold screening + exit (live) |
| `decision-log.json` | Keputusan SCREENER/MANAGER (read-only) |

---

## Quick dispatch

```bash
# Hermes → Grok
python3 scripts/hermes_bridge.py dispatch \
  --assignee grok --priority P1 \
  --summary "..." --tasks "..."

# Hermes → Claude
python3 scripts/hermes_bridge.py dispatch \
  --assignee claude --priority P2 \
  --summary "..." --tasks "..."
```