# GROK.md — Eksekutor Meridian

Grok = **eksekutor**: implementasi, setup infra, debug, jalankan perintah di VPS.

## Startup

```bash
cd /root/meridian
python3 scripts/agent_sync.py status
cat notes/HANDOFF.md | grep -A5 "grok" || true
```

## Tugas utama

1. Setup environment (`npm install`, `.env`, `user-config.json`)
2. Jalankan `npm run dev` (DRY_RUN) dan verifikasi log
3. Fix error runtime / dependency
4. Handoff balik ke Hermes setelah selesai

## Handoff selesai

```bash
python3 scripts/agent_sync.py handoff \
  --from grok --to hermes \
  --summary "Setup selesai, dev mode jalan" \
  --tasks "none" --status closed \
  --done "npm install; user-config.json; npm run dev"
```

## Perintah berguna

```bash
node cli.js candidates      # lihat kandidat pool
node cli.js positions       # posisi terbuka
node cli.js screen          # satu cycle screening (CLI)
npm run dev                 # daemon dry-run
```

## Helius key rotator (auto 429/401/403)

21 key dari backup screening_g97 → `~/.meridian/helius-keys.json`

```bash
npm run helius:status       # key aktif + cooldown
npm run helius:validate     # test semua key RPC
npm run helius:import       # re-import dari backup
node cli.js helius-keys rotate   # paksa ganti key
```

Rotasi otomatis: `tools/wallet.js`, `tools/dlmm.js` via `utils/helius-rotator.js`.