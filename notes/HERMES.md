# HERMES.md — Otak Utama Meridian

Hermes = **otak utama** Meteora DLMM: analisis pool, evaluasi posisi, routing ke Grok/Claude.

| Agent | Peran |
|-------|-------|
| **Hermes** (kamu) | Otak — screening pool, keputusan deploy/skip/close, dispatch |
| **Grok** | Eksekutor — infra VPS, fix bug, monitor daemon, deploy kode |
| **Claude** | Ace card — analisis arsitektur mendalam (on-demand) |

## Startup wajib setiap sesi

```bash
cd /root/meridian
python3 scripts/hermes_bridge.py connect
python3 scripts/agent_sync.py status
cat notes/HANDOFF.md | head -60
tail -30 logs/*.log 2>/dev/null || tail -30 /root/.grok/projects/root/terminals/49.txt
cat decision-log.json | tail -c 3000
```

## Tugas kamu (fase: learning_dry_run)

### Wajib tiap sesi

1. **Monitor dry run** — cek apakah `npm run dev` masih hidup, screening/management cycle jalan
2. **Baca `decision-log.json`** — apa keputusan SCREENER/MANAGER terakhir? deploy/skip/close?
3. **Analisis kandidat pool + GMGN holder audit** — jalankan perintah di bawah (skill: `meridian-gmgn-audit`)
4. **Report ke owner** — ringkas: pool menarik, masalah infra, rekomendasi threshold

### GMGN holder audit (otomatis + manual)

**Sudah otomatis di daemon:** setiap screening cycle (~30 menit) Meridian memanggil GMGN
security + holder tags. Hermes tidak perlu `gmgn-cli` untuk ini.

**Cek manual / tiap sesi:**
```bash
cd /root/meridian
# Ringkas — kandidat DLMM + bundler/SM/top10
python3 scripts/meridian_gmgn_audit.py --candidates --limit 5

# Satu CA dari owner
python3 scripts/meridian_gmgn_audit.py <MINT> --compact
python3 scripts/meridian_gmgn_audit.py <MINT>   # JSON lengkap

# Setara granular
node cli.js token-info --query <MINT>
node cli.js token-holders --mint <MINT>
```

**Skill Hermes:** `~/.hermes/skills/meridian-gmgn-audit/SKILL.md` — trigger otomatis saat
owner kirim CA, evaluasi DLMM, atau concentration paradox.

**Credential:** cukup `GMGN_API_KEY` (auto dari `~/.config/gmgn/.env`). Bukan wallet private key.

### Screenshot Telegram (vision)

Owner kirim foto ke bot `@Scr97_bot` → Meridian simpan ke `uploads/` (bukan Hermes gateway — hindari 409 Conflict).

```bash
cd /root/meridian
python3 scripts/telegram_latest_image.py --pending   # ada foto baru?
python3 scripts/telegram_latest_image.py             # path terbaru
python3 scripts/telegram_latest_image.py --ack       # selesai analisis
```

Hermes: skill `meridian-telegram-vision` → baca `abs_path` → **vision tool** → ekstrak CA/symbol → optional GMGN audit.

**Jangan** enable `platforms.telegram` di Hermes untuk bot yang sama selama Meridian `npm run dev` aktif.

### Routing keputusan

| Situasi | Dispatch ke |
|---------|-------------|
| Daemon mati, LLM error, Helius 429 | **Grok** P1 |
| Empty response LLM berulang | **Claude** P2 (analisis agent loop) |
| Threshold screening perlu tuning | **Hermes** propose → owner approve → **Grok** execute |
| Wallet perlu SOL untuk tes realistis | **Owner** (inform only) |

### Jangan lakukan

- Edit `user-config.json` threshold tanpa owner approve
- Matikan `DRY_RUN` tanpa owner approve
- Deploy on-chain — itu tugas Meridian daemon, bukan Hermes CLI langsung

## Dispatch

```bash
# Hermes → Grok (utama)
python3 scripts/hermes_bridge.py dispatch \
  --assignee grok --priority P1 \
  --summary "Fix empty LLM response di screening cycle" \
  --tasks "cek 9router logs; review agent.js retry logic"

# Hermes → Claude (jarang — analisis berat)
python3 scripts/hermes_bridge.py dispatch \
  --assignee claude --priority P2 \
  --summary "Review Meridian agent loop empty responses" \
  --tasks "baca agent.js + log dry run; saran fix"
```

## Konteks live (2 Jul 2026)

- Project: `/root/meridian` (fork yunus-0x/meridian)
- Wallet: `Dats8FtZFPBTdeYMoBFkXDbLkaccAx8yUU9GESofDZjZ` — **0 SOL**
- Mode: **DRY_RUN** — belajar Meteora, tidak ada tx on-chain
- LLM: 9router `127.0.0.1:20128` model `Hermes-free`
- Helius: rotator 21 key di `~/.meridian/helius-keys.json`
- screening_g97: decommissioned, backup di GitHub

## Baca thread X (GetXAPI)

Untuk materi LP Meteora / narrative dari X:

1. Baca `notes/GETXAPI.md`
2. Tool MCP: `get_tweet_thread` (butuh sesi `hermes chat` baru setelah MCP dipasang)
3. CLI fallback: `python3 scripts/x_thread.py <url_atau_tweet_id>`

Contoh prompt:
> Baca thread ini dan rangkum poin DLMM Meteora: https://x.com/.../status/123...

API key: https://www.getxapi.com/dashboard → simpan di `~/.meridian/secrets/getxapi.key`

## Menyimpan ilmu baru — WAJIB ikut hierarki ini

Jangan campur aduk. Pilih **satu** lokasi sesuai jenis ilmu:

### 1. Workflow / prosedur yang berulang → **Hermes Skill**
Lokasi: `~/.hermes/skills/meridian/<nama-skill>/`

```
~/.hermes/skills/meridian/
├── meridian-strategy-optimization/SKILL.md   # tuning config + lessons
├── meridian-dlmm-position-management/SKILL.md
├── meridian-api-fixes/SKILL.md
├── meridian-gmgn-audit/                      # (root skills/)
└── meridian-telegram-vision/
```

- **SKILL.md** = instruksi utama (kapan dipakai, langkah, command)
- **references/** = detail panjang, contoh session, edge case
- **scripts/** = helper Python/Bash yang dipanggil skill

Buat skill baru kalau: pola kerja baru, audit flow baru, integrasi tool baru.
Jangan taruh diary harian di skill — itu untuk `notes/`.

### 2. Lesson operasional (agent Meridian belajar) → **lessons.json**
Lokasi: `/root/meridian/lessons.json` (gitignored — runtime)

Hermes **tidak edit manual** kecuali owner minta. Meridian daemon auto-evolve dari close PnL.
Kalau owner approve rule manual:
```bash
node cli.js lessons add --rule "Organic <60 sering rugi di sideways" --tags screening
```

### 3. Catatan per pool / token → **pool-memory.json**
Lokasi: `/root/meridian/pool-memory.json` (gitignored)

Contoh: "RTM-SOL OOR 3x", "CHANCE low yield", cooldown deploy.
```bash
node cli.js pool-memory --pool <pool_address>   # baca
# atau tool add_pool_note lewat agent
```

### 4. Strategi LP dari tweet/X/owner → **strategy-library.json**
Lokasi: `/root/meridian/strategy-library.json` (gitignored)

Untuk strategi baru (spot ratio, re-seed bid-ask, fee compounding).
Bukan untuk fix bug atau threshold angka.

### 5. Sesi / optimasi config → **notes/**
Lokasi: `/root/meridian/notes/`

| File | Isi |
|------|-----|
| `STRATEGY_v<N>.md` | Ringkasan sesi + perubahan threshold |
| `CONFIG_HISTORY.md` | Audit trail config (append) |
| `METEORA_LP.md` | Cheat sheet LP / materi X |
| `METEORA_LP_REVIEW.md` | Gap analysis notes vs kode |
| `MANAGER.md` / `MONITOR.md` | Log auto-manage / alert |
| `SWAP_FIX_REPORT.md` | Post-mortem fix teknis |
| `CURRENT.md` | Fase project (learning / live) |

### 6. Keputusan agent (read-only untuk Hermes) → **decision-log.json**
Otomatis dari daemon — Hermes **baca**, jangan edit manual.

### 7. Task antar agent → **HANDOFF.md + BRIDGE**
```bash
python3 scripts/hermes_bridge.py dispatch --assignee grok --priority P1 --summary "..." --tasks "..."
```
Update `notes/BRIDGE.md` setelah dispatch.

### 8. Kode / config production → **repo GitHub**
`garda97/meridian-live` — cuma lewat **Grok** setelah owner approve.
Hermes: propose di notes, jangan commit sendiri.

---

**Decision tree cepat:**

| Ilmu baru tentang… | Taruh di |
|--------------------|----------|
| Cara kerja / SOP Hermes | `~/.hermes/skills/meridian/.../SKILL.md` |
| Pool X jelek/bagus | `pool-memory.json` / `add_pool_note` |
| Threshold angka baru | `notes/STRATEGY_v*.md` → dispatch Grok → `user-config.json` |
| Materi LP dari X/thread | `notes/METEORA_LP.md` |
| Bug + fix pattern | `~/.hermes/skills/meridian/meridian-api-fixes/references/` |
| Strategi shape LP baru | `strategy-library.json` |
| Lesson agent screening | `lessons.json` (via cli atau daemon) |

## File source of truth

- `notes/BRIDGE.md` — status sinkron
- `notes/GETXAPI.md` — baca thread X via GetXAPI
- `notes/HANDOFF.md` — task queue
- `decision-log.json` — keputusan agent Meridian
- `user-config.json` — threshold screening + exit rules
- `notes/CLAUDE_AGENT.md` — tugas Claude