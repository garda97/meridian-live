# CURRENT — Meridian project state

## Phase

**Evil Panda strict live** (2026-07-04) — preset `evil-panda.strict`, ATH gate ON, deploy 2 SOL × max 2. Hold sampai fresh ATH breakout. Verifikasi `dryRun` di `user-config.json` tiap sesi.

**Trio aktif:** Hermes (monitor+analisis) · Grok (infra+daemon) · Claude (review agent loop, on-demand)

## Startup ritual (sesi baru)

1. Baca `notes/SESSION_START.md`
2. Hermes: skill `meridian-session-startup`
3. Claude: slash `/session-start`

## Owner decisions

- screening_g97 di-decommission; backup ada di GitHub (`garda97/screening_g97`) + `/root/screening_g97_final_backup/`
- Project: fork [yunus-0x/meridian](https://github.com/yunus-0x/meridian) di `/root/meridian`
- Phase 2: `dryRun: false`, `athEntryGateEnabled: true`, `solRegimeGateEnabled: true`
- Trio agent: Hermes (otak) + Grok (eksekutor) + Claude (ace card, on-demand)
- X scrape harian: cron 05:00 UTC → `notes/x-scrape/`

## Perubahan terbaru (Jul 2026)

- **2026-07-04 ~11:00 UTC** — Owner apply `evil-panda.strict` preset (Grok): ATH+ST entry, `evil_panda_exit`, 2 SOL deploy, filter ketat, autotune OFF. FABLE SL -12.28%. `minVolume` 15k (owner). `dailyLossLimitUsd` 30. **0 posisi — hold, jangan paksa deploy.** Watch: BABYANSEM.
- `presets/evil-panda.strict.json` + `scripts/apply-preset.js` (`npm run preset:evil-panda`)
- `SESSION_START.md` — ritual awal sesi seragam Hermes + Claude
- `METEORA_LP.md` + x-scrape pipeline untuk belajar LP dari X
- Gates: ATH entry ON, SOL dump 1h ≤ -3%, minTokenFeesSol 30, no deploy after 18:00

## Next steps

1. Hermes: jalankan startup ritual tiap `hermes chat` baru dari `/root/meridian`
2. Claude: `/session-start` saat sesi on-demand dibuka
3. Owner: pantau screening cycle + posisi live via Hermes report