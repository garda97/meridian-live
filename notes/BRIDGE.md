# BRIDGE — Hermes ↔ Grok ↔ Claude (Meridian)

_Updated: 2026-07-02T17:14:25.536979+00:00 by **agent_sync**_

## Quick status

| Item | Value |
|------|-------|
| Phase | `learning_dry_run` |
| Git branch | `github-main` |
| Uncommitted files | 14 |
| Last commit | 87fe037 Meridian DLMM agent — production snapshot (Jul 2026) (2 hours ago) |
| DRY_RUN | `False` |
| user-config.json | yes |
| .env | yes |
| Recent decisions | 0 |

## Latest handoff

**2026-07-02 17:01 UTC** | `claude` → `grok`
> Minta opini Grok: audit gap operasional Meridian saat ini

Tasks: `Owner minta pendapat Grok soal apa yang kurang dari Meridian. Temuan Claude dari cek langsung ke sistem (2026-07-02 16:58 UTC): (1) Daemon node index.js MATI sejak ~16:16 UTC, gak ada proses jalan, live mode (dryRun:false), 0 posisi terbuka, alert Telegram di-pause (.telegram_alerts_paused) -- modal nganggur. (2) pm2 dirujuk di ecosystem.config.cjs tapi TIDAK terinstall di VPS, systemd cuma ada buat meridian-dashboard bukan daemon utama -- gak ada auto-restart kalau daemon crash, ini kemungkinan akar masalah (1). (3) npm test cuma node --check (syntax check), bukan test logic beneran, meski test/test-agent.js dan test-screening.js ada. (4) 11 file uncommitted di working tree (termasuk fix swap getConnection), cuma 1 commit di git history -- resiko lost work. (5) Dust-token recovery (FROGBULL/NYAN/dll) masih manual via Raydium/Orca UI karena swap programatik gak reliable. Grok tolong kasih opini dari sisi eksekusi infra: prioritas fix mana dulu, dan apakah pm2 install + systemd unit buat index.js worth dikerjakan sekarang. Jangan ubah code/config dulu sebelum owner approve.`

## Pending for hermes

- [P1] Baca notes/HERMES.md; cek daemon npm run dev hidup; baca decision-log.json; analisis screening cycle pertama (RUSH-SOL dry deploy); report status ke owner; dispatch Grok jika infra error
- [P2] owner approve dulu sebelum: (1) fix agent.js empty-response retry cap, (2) perbaikan struktur decision-log.json, (3) opsional relax threshold screening
- [P1] baca notes/GETXAPI.md; restart hermes chat; test get_tweet_thread atau x_thread.py; rangkum thread materi owner
- [P2] baca ~/.hermes/skills/meridian-gmgn-audit/SKILL.md; baca notes/HERMES.md bagian GMGN; tiap sesi jalankan python3 scripts/meridian_gmgn_audit.py --candidates --limit 3; ganti gmgn-cli holders/security untuk konteks Meridian
- [P2] baca ~/.hermes/skills/meridian-telegram-vision/SKILL.md; tiap sesi: python3 scripts/telegram_latest_image.py --pending; kalau pending pakai vision tool pada abs_path; ekstrak CA lalu meridian_gmgn_audit; --ack setelah selesai
- [P2] baca ringkasan review Grok di chat terakhir; present ke owner untuk approve phase-by-phase; jangan ubah user-config/code tanpa OK owner
- [P2] Gap utama: (1) rugcheck.xyz cuma jalan di discord-listener, gak dipakai di pipeline screening utama; (2) maxBinsBelow=69 di config membatasi wide-range deep-correction play yg notes anjurkan (200-250 bins), padahal kapabilitas wide-path udah ada di tools/dlmm.js; (3) belum ada field phishing_pct/insiders_pct/bluechip_pct/fresh-bundled-ratio di tools/gmgn.js; (4) maxPositions:3 vs notes minta minimal 6 posisi buat diversifikasi; (5) maxBundlerTop100Pct default null (OFF) padahal notes anggap itu hard filter penting. Rekomendasi field baru buat user-config.json + decision-log.json ada di file review. Owner tolong baca notes/METEORA_LP_REVIEW.md, approve mana yang mau dieksekusi.
- [P3] Monitor RTM-SOL (+2.93% PnL) approaching trailing stop threshold (+3.0%); accumulate fees for claim eligibility; no rebalance/stop-loss alerts.

## Pending for grok

- [P1] cek agent.js retry/timeout path 180-246; verifikasi 9router timeout vs openai; audit getTopCandidates/getMyPositions apakah memanggil LLM; identifikasi bottleneck candidates/positions; kirim rekomendasi fix
- [P1] cek agent.js line ~180-246 retry/timeout path; verifikasi 9router timeout vs openai timeout; cek apakah getTopCandidates/getMyPositions memanggil LLM; identifikasi bottleneck candidates/positions; kirim rekomendasi fix
- [P2] Owner approve dulu sebelum eksekusi 3 hal ini: (1) FIX agent.js baris 283-289 — tiap 'Empty response, retrying' itu continue ke for-loop step utama, jadi makan 1 slot dari budget 20 step (bukan retry terpisah yang murah). Variabel emptyStreak (baris 190) udah dideklarasi tapi gak pernah dipakai — kelihatan kayak fix yang belum kelar, tinggal kasih cap terpisah (misal max 3x retry lalu break) yang gak motong step budget. (2) decision-log.json — field risks[]/metrics{}/rejected[] selalu kosong walau reason text-nya jelas nyebut pool yang direject, perlu di-parse dari final answer LLM biar terstruktur. (3) OPSIONAL: threshold screening (minTvl/minOrganic/minFeeActiveTvlRatio dkk) di user-config.json udah oke buat fase belajar tapi ketat — 2 cycle terakhir NO DEPLOY terus, kalau mau lebih banyak observasi full cycle bisa dilonggarin dikit. Semua ini nunggu approve owner, JANGAN dieksekusi duluan.
- [P2] Review notes/METEORA_LP.md and identify actionable updates for screening/pool selection/exit logic; propose implementation plan for DLMM backup strategy (e.g., DCA-in concept fitting Meridian risk profile); do NOT change code/theme/design without owner approve.
- [P1] Baca notes/METEORA_LP.md; Analisis apakah kriteria screening Evil Panda (MC >250k, Vol >1M, Total Fees >30 SOL) dan filter bengshark (Age <2 hari, New ATH) sudah tercover di pipeline; Usulkan update threshold jika ada gap
- [P1] Owner minta pendapat Grok soal apa yang kurang dari Meridian. Temuan Claude dari cek langsung ke sistem (2026-07-02 16:58 UTC): (1) Daemon node index.js MATI sejak ~16:16 UTC, gak ada proses jalan, live mode (dryRun:false), 0 posisi terbuka, alert Telegram di-pause (.telegram_alerts_paused) -- modal nganggur. (2) pm2 dirujuk di ecosystem.config.cjs tapi TIDAK terinstall di VPS, systemd cuma ada buat meridian-dashboard bukan daemon utama -- gak ada auto-restart kalau daemon crash, ini kemungkinan akar masalah (1). (3) npm test cuma node --check (syntax check), bukan test logic beneran, meski test/test-agent.js dan test-screening.js ada. (4) 11 file uncommitted di working tree (termasuk fix swap getConnection), cuma 1 commit di git history -- resiko lost work. (5) Dust-token recovery (FROGBULL/NYAN/dll) masih manual via Raydium/Orca UI karena swap programatik gak reliable. Grok tolong kasih opini dari sisi eksekusi infra: prioritas fix mana dulu, dan apakah pm2 install + systemd unit buat index.js worth dikerjakan sekarang. Jangan ubah code/config dulu sebelum owner approve.

## Pending for claude

- [P2] Baca notes/CLAUDE_AGENT.md + CLAUDE.md; investigasi Empty response retrying di log dry run; review apakah user-config threshold cocok untuk fase belajar; handoff balik ke Hermes dengan rekomendasi (jangan ubah config tanpa owner)
- [P2] baca agent.js + index.js; analisis empty response, duplicate deploy_position block, SAFETY_BLOCK; review threshold untuk fase learning_dry_run; handoff rekomendasi balik ke Hermes tanpa ubah config
- [P2] baca agent.js + index.js; analisis empty response, duplicate deploy_position block, SAFETY_BLOCK; review threshold cocok untuk fase learning_dry_run; handoff rekomendasi balik ke Hermes tanpa ubah config
- [P2] Read notes/METEORA_LP.md; compare with current screening/exit/rules in repo; identify whether any metric/schema should be reflected in user-config or decision-log; return recommendation only, do not edit files without owner approve.
- [P2] Baca notes/METEORA_LP.md; Analisis strategi exit (RSI 2 > 90, Close above BB Upper, Supertrend Break); Berikan rekomendasi arsitektur jika logika ini ingin diotomatisasi dalam Meridian Manager

## Read next

1. `notes/HERMES.md` — otak utama
2. `notes/GROK.md` — eksekutor
3. `notes/CURRENT.md` — fase project
4. `notes/HANDOFF.md` — task queue
5. `CLAUDE.md` — engineering manual Meridian
