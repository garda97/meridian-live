# CURRENT — Meridian project state

## Phase

**learning_dry_run** — belajar Meteora DLMM + familiarisasi Meridian sebelum live deploy.

**Trio aktif:** Hermes (monitor+analisis) · Grok (infra+daemon) · Claude (review agent loop, on-demand)

## Owner decisions

- screening_g97 di-decommission; backup ada di GitHub (`garda97/screening_g97`) + `/root/screening_g97_final_backup/`
- Project baru: fork [yunus-0x/meridian](https://github.com/yunus-0x/meridian) di `/root/meridian`
- Mode awal: **DRY_RUN=true** — tidak ada transaksi on-chain
- Trio agent: Hermes (otak) + Grok (eksekutor) + Claude (ace card, on-demand)

## Perubahan terbaru

- Clone Meridian repo ke `/root/meridian`
- Scaffold trio bridge: `scripts/agent_sync.py`, `scripts/hermes_bridge.py`
- Notes: `BRIDGE.md`, `HANDOFF.md`, `HERMES.md`, `GROK.md`

## Next steps

1. ~~`npm install`~~ ✅
2. ~~`user-config.json` + `.env`~~ ✅ (DRY_RUN=true; wallet key perlu format base58 — GMGN PEM tidak compatible)
3. `npm run dev` — jalankan daemon dry-run, pelajari screening/management cycle
4. Hermes: `hermes chat` dari `/root/meridian`, baca `notes/HERMES.md`
5. Owner: siapkan `WALLET_PRIVATE_KEY` base58 kalau mau test balance/deploy dry-run penuh