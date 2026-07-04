# BRIDGE — Hermes ↔ Grok ↔ Claude (Meridian)

_Updated: 2026-07-04T05:31:13.855048+00:00 by **claude**_

## Quick status

| Item | Value |
|------|-------|
| Phase | `Phase 2 live` |
| Git branch | `github-main` |
| Uncommitted files | 26 |
| Last commit | 5c7012d docs: professional README + CHANGELOG, dashboard thresholds API (68 minutes ago) |
| DRY_RUN | `False` |
| user-config.json | yes |
| .env | yes |
| Recent decisions | 0 |

## Latest handoff

**2026-07-04 05:31 UTC** | `claude` → `hermes`
> P1 phantom PnL warmup guard selesai — SAFE TO DEPLOY; + fix breaking call site est-share dari refactor paralel

Tasks: `VERDICT: SAFE TO DEPLOY. [P1 PHANTOM PNL WARMUP] Root cause FABLE (deploy → 5s → peak phantom +74% confirmed 2 ticks → trailing arm → RULE_2 take profit → close 15s, real 0%): PnL RPC path menghasilkan spike sampah saat deposit belum settle, dan confirmPeak 2 tick @3s dua-duanya baca data sampah yang sama — pnlSanityMaxDiffPct tidak nangkep karena reported & derived dihitung dari data salah yang sama. FIX: isInPnlWarmup(pos, warmupMinutes) pure exported di state.js — window dihitung dari MAX(deployed_at, last_rebalance_at) karena rebalance (apalagi migrate path, akun baru) mengubah deposit dan bisa phantom lagi. Selama warmup: (1) confirmPeak tidak stage/raise peak (pending peak dibersihkan), (2) trailing tidak bisa arm di updatePnlAndCheckExits, (3) RULE_2 take profit di-gate di getDeterministicCloseRule — dan karena poller pakai fungsi yang sama, poller otomatis ikut; (4) partial TP terlindungi transitif (butuh confirmed peak yang tidak akan naik). STOP LOSS SENGAJA TETAP LIVE selama warmup — rug beneran di menit pertama lebih bahaya daripada close spurious 0%. Config pnlWarmupMinutes default 3 menit (management + CONFIG_MAP + example), 0/null = off. Test test-pnl-warmup.js BARU 14 assert: replay skenario FABLE persis (phantom 74% 2 tick → peak tetap 0), trailing gated meski peak terkontaminasi pre-fix, SL fire -15% saat warmup, rebalance restart clock, post-warmup flow normal. [BONUS FIX PENTING] Refactor paralel (bukan saya) mengubah signature estimateSharePct ke object-args + nambah call site di getTopCandidates — dua call site saya di index.js masih positional = SILENT BREAK (est_share jadi null semua di screening cycle setelah restart). Sudah saya selaraskan ke object-args + test di-update. CATATAN untuk yang commit: call site baru di tools/screening.js pakai solPriceUsd HARDCODED 150 (komentar 'Approx') — SOL live ~$81, jadi estimated_share_pct dari jalur getTopCandidates OVERSTATED ~1.8x; jalur index.js saya pakai harga live currentBalance.sol_price (akurat). Saran: alirkan harga live ke getTopCandidates atau minimal ganti konstanta — bukan blocker, metric informatif, tapi angkanya menyesatkan kalau dipakai kalibrasi threshold. VERIFIED: 9 suite inti pass (termasuk pnl-warmup baru + est-share fixed) + npm run test:syntax 0 error. CONSTRAINT: user-config.json tidak disentuh, daemon tidak di-restart (masih kode lama — warmup guard aktif setelah restart). BACKLOG SISA dari session handoff Grok: P2 rugcheckTop10MaxPct commit (kerjaan commit = owner/Grok, kode sudah ada), P2 test-management-priority.js (belum — butuh extract getDeterministicCloseRule dari index.js dulu, refactor kecil tapi menyentuh file daemon, saya tunda kecuali diminta). DEPLOY: perubahan menumpuk banyak di working tree (LP gaps + warmup + kerjaan paralel rugcheck/README) — owner review git diff lalu commit + restart per runbook. PRIORITAS RESTART: warmup guard ini P1 — selama daemon jalan kode lama, phantom spike masih bisa mengulang FABLE di posisi SEMAN yang aktif sekarang.`

## Read next

1. `notes/HERMES.md` — otak utama
2. `notes/GROK.md` — eksekutor
3. `notes/CURRENT.md` — fase project
4. `notes/HANDOFF.md` — task queue
5. `CLAUDE.md` — engineering manual Meridian
