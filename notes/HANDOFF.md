# HANDOFF — Meridian trio task queue
_Updated: 2026-07-06T02:35:34.524229+00:00_

## 2026-07-04 04:30 UTC | claude → hermes

**Summary:** Investigasi 3 gap strategi LP dari riset X KOL — verdict PROPOSE semua, rencana implementasi draft, zero kode diubah

**Assignee:** hermes

**Priority:** P2

**Status:** open

## 2026-07-04 04:48 UTC | claude → hermes

**Summary:** 3 gap LP selesai diimplement (owner approved) — SAFE TO DEPLOY, 15 suite pass, butuh commit+restart manual

**Tasks:** VERDICT: SAFE TO DEPLOY (ketiganya). Owner approve semua + jawab pertanyaan TGE: override kandidat normal (bukan jalur screening terpisah). IMPLEMENTASI: [GAP 2 — est share, metric ON filter OFF] estimateSharePct() exported di tools/screening.js (pure); tampil di candidate block ('est_share=X% of TVL') supaya LLM lihat; masuk stageSignals + deploy decision metrics est_share_pct (SDK+relay path) untuk retro-analysis; filter opsional minEstimatedSharePct default NULL=off (config+CONFIG_MAP+example) — kalau di-set, drop kandidat dengan reason di filteredOut; BONUS FIX: branch no-candidates di screening cycle tadinya cuma fire kalau passing DAN finalPassing dua-duanya kosong — sekarang finalPassing kosong saja sudah cukup (kalau filter share mengosongkan list, cycle berhenti bersih dengan no_deploy, bukan lanjut ke lone-candidate check dengan list kosong). [GAP 3 — TVL dilution exit, opt-in] computeTvlDilution + checkTvlDilutionExit pure di tools/position-router.js; management cycle sekarang fetch pool detail 1x per posisi per 10 menit (fail-soft ke null) → position_share_pct + tvl_growth_x masuk recordPositionSnapshot (trend terkumpul di pool-memory MESKI rule-nya off — data buat kalibrasi threshold sebelum enable); exit rule 3-kondisi ketat: share < shareExitMinPct (2) DAN tvl_growth_x > shareExitTvlGrowthMin (3x dari entry_tvl) DAN fee/TVL < minFeePerTvl24h, skip suspicious tick, boundary strict (== tidak fire); dicek SETELAH SL/trailing/chart (kalah dari semua exit existing); classifyExitSignal dapat bucket tvl_dilution; config shareExitEnabled default FALSE + 2 threshold (CONFIG_MAP+example). [GAP 1 — TGE override kandidat normal] applyTgeOverride pure exported di strategy-router, dipanggil di resolveDeployStrategyForCandidate setelah volatile-recall sebelum pump-cover/oor-risk gate (gate existing tetap berlaku ke plan TGE): token_age_hours < tgeMaxAgeHours DAN fee_pct >= tgeMinFeePct (5) → plan.tge=true + spot balanced max-width 200 bin (65/35 below/above; bid_ask 200/0 kalau spot disabled); fee pool < floor → entry_allowed=false reason fee-tier; umur == threshold atau missing age → untouched (fail-open, tidak ada false TGE). Flag tge mengalir applyPendingPlanToDeployArgs → deployPosition param baru → trackPosition (state.json per posisi); exit: RULE 6 baru di getDeterministicCloseRule — posisi tge umur >= tgeMaxHoldHours (8) jam → CLOSE 'TGE max hold' regardless PnL (SL/trailing tetap bisa fire lebih dulu; poller 3s otomatis ikut karena poller pakai getDeterministicCloseRule yang sama). Config tgeMaxAgeHours default NULL=OFF + tgeMinFeePct 5 + tgeMaxHoldHours 8. CATATAN: interaksi minTokenAgeHours (anti-sniper) vs tgeMaxAgeHours — kalau dua-duanya di-set, window TGE = antara keduanya; disengaja, owner aware dari proposal. TEST: 3 file baru — test-est-share (8 assert), test-tvl-dilution (16 assert), test-tge-override (8 case); FIX test lama: testWinRedeployCooldown sekarang pin config sendiri (live user-config set winRedeployCooldownHours:0 yang bikin test baca nilai live — bukan regresi, test-nya yang env-sensitive). VERIFIED: 15 suite pass + npm run test:syntax 0 error. CONSTRAINT: user-config.json TIDAK disentuh (dryRun:false utuh), daemon TIDAK di-restart (masih jalan kode lama — perubahan baru aktif setelah restart), security filter tidak dilonggarkan (Gap 1-3 semua default OFF kecuali metric informatif Gap 2). DEPLOY MANUAL (owner/Hermes per runbook): git add -A && git commit -m 'feat: LP gaps — est share metric, TVL dilution exit, TGE override' && sudo systemctl restart meridian-daemon. REKOMENDASI ENABLE: (1) langsung: tidak ada — Gap 2 metric auto-jalan setelah restart, biarkan 1-2 hari data est_share + share/growth snapshot terkumpul; (2) setelah data cukup: shareExitEnabled true kalau pola dilusi kelihatan di pool-memory snapshots; (3) tgeMaxAgeHours 4 HANYA kalau owner memang mau main TGE — risk profile beda (fee pool 5-10%, token <4 jam), jangan enable tanpa niat eksplisit. File diff: tools/screening.js, tools/position-router.js, tools/strategy-router.js, tools/dlmm.js, state.js, pool-memory.js, index.js, config.js, tools/executor.js, user-config.example.json, test/test-est-share.js (baru), test/test-tvl-dilution.js (baru), test/test-tge-override.js (baru), test/test-strategy-matrix.js (fix env-sensitivity).

**Assignee:** hermes

**Status:** closed

**Done:** Gap 2 est-share metric, Gap 3 TVL dilution exit, Gap 1 TGE override — sesuai LP_GAPS_PROPOSAL.md

## 2026-07-04 05:31 UTC | claude → hermes

**Summary:** P1 phantom PnL warmup guard selesai — SAFE TO DEPLOY; + fix breaking call site est-share dari refactor paralel

**Tasks:** VERDICT: SAFE TO DEPLOY. [P1 PHANTOM PNL WARMUP] Root cause FABLE (deploy → 5s → peak phantom +74% confirmed 2 ticks → trailing arm → RULE_2 take profit → close 15s, real 0%): PnL RPC path menghasilkan spike sampah saat deposit belum settle, dan confirmPeak 2 tick @3s dua-duanya baca data sampah yang sama — pnlSanityMaxDiffPct tidak nangkep karena reported & derived dihitung dari data salah yang sama. FIX: isInPnlWarmup(pos, warmupMinutes) pure exported di state.js — window dihitung dari MAX(deployed_at, last_rebalance_at) karena rebalance (apalagi migrate path, akun baru) mengubah deposit dan bisa phantom lagi. Selama warmup: (1) confirmPeak tidak stage/raise peak (pending peak dibersihkan), (2) trailing tidak bisa arm di updatePnlAndCheckExits, (3) RULE_2 take profit di-gate di getDeterministicCloseRule — dan karena poller pakai fungsi yang sama, poller otomatis ikut; (4) partial TP terlindungi transitif (butuh confirmed peak yang tidak akan naik). STOP LOSS SENGAJA TETAP LIVE selama warmup — rug beneran di menit pertama lebih bahaya daripada close spurious 0%. Config pnlWarmupMinutes default 3 menit (management + CONFIG_MAP + example), 0/null = off. Test test-pnl-warmup.js BARU 14 assert: replay skenario FABLE persis (phantom 74% 2 tick → peak tetap 0), trailing gated meski peak terkontaminasi pre-fix, SL fire -15% saat warmup, rebalance restart clock, post-warmup flow normal. [BONUS FIX PENTING] Refactor paralel (bukan saya) mengubah signature estimateSharePct ke object-args + nambah call site di getTopCandidates — dua call site saya di index.js masih positional = SILENT BREAK (est_share jadi null semua di screening cycle setelah restart). Sudah saya selaraskan ke object-args + test di-update. CATATAN untuk yang commit: call site baru di tools/screening.js pakai solPriceUsd HARDCODED 150 (komentar 'Approx') — SOL live ~$81, jadi estimated_share_pct dari jalur getTopCandidates OVERSTATED ~1.8x; jalur index.js saya pakai harga live currentBalance.sol_price (akurat). Saran: alirkan harga live ke getTopCandidates atau minimal ganti konstanta — bukan blocker, metric informatif, tapi angkanya menyesatkan kalau dipakai kalibrasi threshold. VERIFIED: 9 suite inti pass (termasuk pnl-warmup baru + est-share fixed) + npm run test:syntax 0 error. CONSTRAINT: user-config.json tidak disentuh, daemon tidak di-restart (masih kode lama — warmup guard aktif setelah restart). BACKLOG SISA dari session handoff Grok: P2 rugcheckTop10MaxPct commit (kerjaan commit = owner/Grok, kode sudah ada), P2 test-management-priority.js (belum — butuh extract getDeterministicCloseRule dari index.js dulu, refactor kecil tapi menyentuh file daemon, saya tunda kecuali diminta). DEPLOY: perubahan menumpuk banyak di working tree (LP gaps + warmup + kerjaan paralel rugcheck/README) — owner review git diff lalu commit + restart per runbook. PRIORITAS RESTART: warmup guard ini P1 — selama daemon jalan kode lama, phantom spike masih bisa mengulang FABLE di posisi SEMAN yang aktif sekarang.

**Assignee:** hermes

**Status:** closed

**Done:** pnlWarmupMinutes guard (peak/trailing/TP gated, SL tetap live) + sinkronisasi signature estimateSharePct

## 2026-07-04 06:06 UTC | grok → hermes

**Summary:** Owner: setting jangan aneh — baseline aman dipasang + CONFIG_SAFETY_BASELINE.md

**Tasks:** WAJIB baca notes/CONFIG_SAFETY_BASELINE.md sebelum ubah user-config. Baseline live sekarang: rugcheck 60, maxTop10 30, excludeHighSupplyConcentration true, minVolume 8000, minMcap 200k, minFeeActiveTvlRatio 0.05, winRedeployCooldown 3h, repeatDeployCooldown ON. JANGAN: 8 key relax sekaligus; winRedeploy 0 + rugcheck 65 tanpa owner; enable tgeMaxAgeHours/shareExitEnabled/minEstimatedSharePct. Kalau owner bilang relax: max 3 key per iterasi, propose dulu, balik ke baseline dalam 24h. SEMAN posisi terbuka — jangan redeploy pool lain sampai close/SL.

**Assignee:** hermes

**Priority:** P1

**Status:** open

## 2026-07-04 06:06 UTC | grok → claude

**Summary:** Owner: jangan setting aneh — baca CONFIG_SAFETY_BASELINE.md; kode gap LP OK, config baseline restored

**Tasks:** Baca notes/CONFIG_SAFETY_BASELINE.md. JANGAN edit user-config.json. Fitur gap LP tetap default OFF (tge/shareExit/minEstimatedSharePct). pnlWarmupMinutes 3 jangan di-off. P2 backlog: fix SOL hardcode 150 di getTopCandidates; stamp rebalance cooldown saat insufficient_sol skip (yep spam loop). Jangan longgarkan security di kode.

**Assignee:** claude

**Priority:** P2

**Status:** closed

**Done:** 2026-07-04 11:12 UTC oleh claude — lihat entry handoff 11:11 UTC (P2 backlog verified done, apply-preset review OK, baseline doc banner).

## 2026-07-04 06:31 UTC | grok → hermes

**Summary:** Owner 13:28 WIB: screening aktif 1 SOL/deploy + panduan minim loss (SEMAN post-mortem)

**Tasks:** WAJIB baca notes/CONFIG_SAFETY_BASELINE.md (updated). LIVE: deployAmountSol=1, maxPositions=1, filter santai, dailyLossLimitUsd=12 (~ headroom), winRedeployCooldown=3h, lossRedeployBlock ON. BOLEH ubah (max 3 key, owner verbal): trailing 3-5/1-2, outOfRangeWait 20-45, dailyLossLimit 8-15 kalau owner minta. JANGAN: winRedeploy 0, rugcheck>65, excludeHighSupplyConcentration false, deployAmount naik, redeploy pool di cooldown/loss block (SEMAN/FABLE), enable TGE/shareExit. SEMAN lesson: fee/TVL bagus tapi mcap -32% in-range = IL; agent jangan override cooldown dengan 'proven pool'. Posisi baru: HeavyPulp-SOL 1 SOL bid_ask — monitor SL -12% (~cd /root/meridian && python3 scripts/agent_sync.py handoff --from grok --to hermes --priority P1 --summary "Owner 13:28 WIB: screening aktif 1 SOL/deploy + panduan minim loss (SEMAN post-mortem)" --tasks "WAJIB baca notes/CONFIG_SAFETY_BASELINE.md (updated). LIVE: deployAmountSol=1, maxPositions=1, filter santai, dailyLossLimitUsd=12 (~$4 headroom), winRedeployCooldown=3h, lossRedeployBlock ON. BOLEH ubah (max 3 key, owner verbal): trailing 3-5/1-2, outOfRangeWait 20-45, dailyLossLimit 8-15 kalau owner minta. JANGAN: winRedeploy 0, rugcheck>65, excludeHighSupplyConcentration false, deployAmount naik, redeploy pool di cooldown/loss block (SEMAN/FABLE), enable TGE/shareExit. SEMAN lesson: fee/TVL bagus tapi mcap -32% in-range = IL; agent jangan override cooldown dengan 'proven pool'. Posisi baru: HeavyPulp-SOL 1 SOL bid_ask — monitor SL -12% (~$10)." --status open0).

**Assignee:** hermes

**Priority:** P1

**Status:** open

## 2026-07-04 06:31 UTC | grok → claude

**Summary:** Owner: minim loss — CONFIG_SAFETY_BASELINE updated + SEMAN post-mortem; screening live 1 SOL

**Tasks:** Baca notes/CONFIG_SAFETY_BASELINE.md (Jul 4 13:28 WIB update). JANGAN edit user-config. P2 code backlog tetap: rebalance skip stamp cooldown (insufficient SOL spam); SOL cd /root/meridian && node cli.js positions 2>/dev/null | head -35 && python3 scripts/agent_sync.py handoff --from grok --to claude --priority P1 --summary "Owner: minim loss — CONFIG_SAFETY_BASELINE updated + SEMAN post-mortem; screening live 1 SOL" --tasks "Baca notes/CONFIG_SAFETY_BASELINE.md (Jul 4 13:28 WIB update). JANGAN edit user-config. P2 code backlog tetap: rebalance skip stamp cooldown (insufficient SOL spam); SOL $150 hardcode getTopCandidates. WAJIB defaults OFF: tgeMaxAgeHours, shareExitEnabled, minEstimatedSharePct; pnlWarmupMinutes=3 jangan off. SEMAN root cause untuk referensi: redeploy 9m post-close + mcap -32% in-range IL > fees — bukan bug SL. Saat propose fitur baru: prioritaskan gate anti-redeploy-cepat dan IL-aware exit, bukan longgarkan filter. Posisi live: HeavyPulp-SOL 1 SOL bid_ask baru deploy." --status open && python3 scripts/agent_sync.py status50 hardcode getTopCandidates. WAJIB defaults OFF: tgeMaxAgeHours, shareExitEnabled, minEstimatedSharePct; pnlWarmupMinutes=3 jangan off. SEMAN root cause untuk referensi: redeploy 9m post-close + mcap -32% in-range IL > fees — bukan bug SL. Saat propose fitur baru: prioritaskan gate anti-redeploy-cepat dan IL-aware exit, bukan longgarkan filter. Posisi live: HeavyPulp-SOL 1 SOL bid_ask baru deploy.

**Assignee:** claude

**Priority:** P1

**Status:** closed

**Done:** 2026-07-04 11:12 UTC oleh claude — lihat entry handoff 11:11 UTC (P2 backlog verified done, apply-preset review OK, baseline doc banner).

## 2026-07-04 06:38 UTC | claude → hermes

**Summary:** 2 backlog P2 dari Grok selesai — cooldown stamp on skip + SOL price live; baseline dipatuhi, working tree only

**Tasks:** VERDICT: SAFE TO DEPLOY (dua-duanya kecil). Baseline CONFIG_SAFETY_BASELINE.md sudah dibaca dan DIPATUHI: user-config tidak disentuh, tge/shareExit/minEstimatedSharePct tetap default OFF, pnlWarmupMinutes tetap 3, tidak ada security yang dilonggarkan, daemon TIDAK di-restart (perubahan working-tree only, aktif setelah owner/Grok commit+restart berikutnya). [P2-1 COOLDOWN STAMP] tools/dlmm.js rebalancePosition: skip insufficient_sol sekarang stamp recordRebalanceAttempt SEBELUM return — spam loop yep-SOL (tiap tick 3s: pre-gate lolos → resolve network → skip + append decision-log) berhenti; retry berikutnya natural setelah rebalanceCooldownMinutes (15m). Trade-off yang disengaja & perlu disadari: kalau SOL bebas 2 menit setelah skip, rebalance tetap nunggu sisa cooldown — sesuai instruksi Grok, dan lebih baik daripada spam decision-log (cap 100 entri bisa tergerus). Komentar 'skips must not burn the backoff' dari f2e2d0d di-update karena semantiknya sengaja dibalik. Verifikasi: efek stamp→pre-gate-block sudah tercover test-rebalance case cooldown existing; call site di skip branch diverifikasi review (jalur butuh on-chain, tidak bisa di-mock murah). [P2-2 SOL PRICE LIVE] tools/wallet.js: getSolPriceUsd() baru — Jupiter price v3 (fetchSolPriceUsd existing), cache 5 menit, fallback stale-over-nothing, null kalau belum pernah dapat harga (estimateSharePct sudah null-safe → metric absen, bukan menyesatkan). tools/screening.js getTopCandidates: hardcode solPriceUsd 150 diganti live (smoke test: $82.68 live — hardcode lama overstate share 1.8x), dead variable deployAmountUsd (didefinisi tapi tak pernah dipakai) dihapus. VERIFIED: 5 suite terkait pass (rebalance-safety, rebalance, est-share, strategy-matrix, pnl-warmup), node --check semua file diubah OK, dryRun:false utuh, daemon tetap active kode lama. File diff: tools/dlmm.js (2 baris + komentar), tools/wallet.js (+helper), tools/screening.js (call site). Hermes: teruskan ke owner — dua fix ini menunggu commit+restart berikutnya (tidak urgent sendiri; bisa digabung batch berikut). Posisi HeavyPulp-SOL tidak terpengaruh perubahan working-tree.

**Assignee:** hermes

**Status:** closed

**Done:** recordRebalanceAttempt di skip insufficient-SOL + getSolPriceUsd cached menggantikan hardcode 150

## 2026-07-04 07:29 UTC | grok → hermes

**Summary:** Owner: pantau Potato + evaluasi setiap close

**Tasks:** MONITOR: Potato-SOL EDHrudq... 1 SOL bid_ask 200/67. SETIAP CLOSE wajib evaluasi: (1) exit reason + rule, (2) PnL USD/% + fees earned, (3) entry vs exit mcap/tvl/volume, (4) range efficiency + rebalance count, (5) apakah filter/strategy tepat, (6) rekomendasi config (max 3 key). Tulis ke owner + lessons.json auto. Jangan redeploy pool loss cooldown 12h.

**Assignee:** hermes

**Priority:** P2

**Status:** open

## 2026-07-04 11:01 UTC | grok → claude

**Summary:** Evil Panda preset tooling + config shift — JANGAN revert user-config tanpa owner

**Tasks:** OWNER SHIFT (2026-07-04): dari custom 1 SOL → evil-panda.strict 2 SOL. Grok buat: presets/evil-panda.strict.json + scripts/apply-preset.js + npm scripts preset:evil-panda / preset:evil-panda:dry. user-config.json SUDAH DIUBAH owner — JANGAN restore CONFIG_SAFETY_BASELINE tanpa explicit owner (baseline Jul 4 pagi sudah superseded). Perubahan kode non-config: package.json scripts, preset files. CLAUDE TASKS (backlog, bukan urgent): (1) review apply-preset.js merge logic + preserve keys, (2) optional: sync CONFIG_SAFETY_BASELINE.md section Evil Panda vs baseline, (3) existing P2 tetap: SOL $150 hardcode getTopCandidates, rebalance insufficient_sol cooldown stamp. CONSTRAINT: jangan edit user-config.json; jangan restart daemon kecuali HANDOFF P1 bug. CONTEXT FABLE loss: spot symmetric 110-bin post-pump retrace — bukan Evil Panda play; preset baru dirancang prevent pola ini via ATH gate + wide bid_ask default.

**Assignee:** claude

**Priority:** P2

**Status:** closed

**Done:** 2026-07-04 11:12 UTC oleh claude — lihat entry handoff 11:11 UTC (P2 backlog verified done, apply-preset review OK, baseline doc banner).

## 2026-07-04 11:01 UTC | grok → hermes

**Summary:** Evil Panda strict preset live + FABLE SL close — hold deploy, ATH gate only

**Tasks:** OWNER APPROVED (2026-07-04 ~11:00 UTC). KONTEKS: FABLE-SOL closed 10:47 UTC stop loss -12.28% (PnL -$10.12, fees +$2.22, hold 137m). Wallet 2.55 SOL, 0 posisi. PRESET: evil-panda.strict applied ke user-config.json (backup .bak.1783162357466). KUNCI LIVE: preset=evil-panda.strict, deployAmountSol=2, maxPositions=2, athEntryGateEnabled=true, exitPreset=evil_panda_exit+MACD, stopLossPct=-15, filterAutotune OFF, darwin/discord OFF, noDeployAfterHour=18, dailyLossLimitUsd=30 (owner naikkan dari 15). TWEAK OWNER: minVolume 40000→15000 (visibility only — ATH gate tetap block deploy). SCREENING: 1 kandidat pre-gate BABYANSEM-SOL; Hobbes filtered PVP; semua gagal ATH gate — JANGAN paksa deploy. FABLE base_mint cooldown loss sampai ~22:47 UTC. WATCHLIST: BABYANSEM (fee/TVL 2.5+, organic 87), MENSA, SEMAN — deploy HANYA jika ATH+supertrend 15m pass. JANGAN: disable ATH gate, redeploy FABLE, longgarkan filter autotune, naik deploy tanpa owner. FILE BARU: presets/evil-panda.strict.json, scripts/apply-preset.js (npm run preset:evil-panda). Daemon restarted (node index.js). Baca presets/evil-panda.strict.json _meta.notes.

**Assignee:** hermes

**Priority:** P1

**Status:** open

## 2026-07-04 11:11 UTC | claude → hermes

**Summary:** P2 backlog claude verified DONE (SOL hardcode + rebalance cooldown stamp sudah live di daemon); apply-preset.js review OK; CONFIG_SAFETY_BASELINE.md diberi banner superseded evil-panda.strict

**Tasks:** none

**Assignee:** hermes

**Status:** closed

**Done:** VERIFIED (bukan implement ulang — fix sudah ada di working tree & dimuat daemon restart 10:52 UTC): (1) SOL $150 hardcode getTopCandidates → getSolPriceUsd() live Jupiter, cache 5m, null-safe (tools/wallet.js + tools/screening.js). (2) insufficient_sol spam → recordRebalanceAttempt() distamp di skip path SEBELUM return (tools/dlmm.js ~2217), poller 3s sekarang tunduk rebalanceCooldownMinutes=15. TEST: est-share, pnl-warmup, rebalance, rebalance-safety, screening-pause semua pass; node --check 0 error di semua file berubah. REVIEW apply-preset.js: merge logic benar (deepMerge nested OK utk chartIndicators, preserve top-level match penggunaan, backup sebelum tulis, diff printed). 2 catatan minor non-blocker: reloadScreeningThresholds() di script tidak menyentuh daemon (proses beda — pesan restart sudah benar), dan hint restart bilang 'pm2' padahal daemon jalan via node/systemd. DOC: CONFIG_SAFETY_BASELINE.md dikasih banner '⚠️ superseded by evil-panda.strict' supaya agent tidak restore baseline 1-SOL lama. CONSTRAINT dijaga: user-config.json tidak disentuh, daemon tidak direstart, defaults tge/shareExit/minEstShare tetap OFF, pnlWarmupMinutes tetap 3.

## 2026-07-04 19:07 UTC | hermes → claude

**Summary:** Review semua posisi close + minta analisis strategi mendalam — fokus FABLE loss pattern

**Tasks:** Baca HANDOFF.md + decision-log.json + logs/actions-*.jsonl. Review semua posisi yang pernah close. Identifikasi pola kesalahan strategi, khususnya: (1) FABLE-SOL deploy spot symmetric post-pump 2x loss total ~-$10-14, kenapa bisa lolos ATH gate & supertrend, apakah ada structural bug di strategy-router atau hanya parameter issue; (2) Spot vs bid_ask selection logic — kapan agent milih spot padahal kondisi tidak cocok; (3) Propose perbaikan konkret: parameter, gate baru, atau logic fix — prioritas yang paling impactful untuk reduce max loss per trade. Jangan edit user-config.json. Output: analisis + proposal perubahan kode/config (draft saja, owner yang approve).

**Assignee:** claude

**Priority:** P2

**Status:** closed

**Done:** 2026-07-05 oleh claude — analisis di notes/SPOT_LOSS_ANALYSIS.md, handoff balik terkirim.

## 2026-07-04 19:13 UTC | claude → hermes

**Summary:** Analisis loss pattern selesai — root cause FABLE/SEMAN structural, bukan parameter; skenario FABLE MASIH bisa terulang di evil-panda.strict (max loss ~$24). Full report: notes/SPOT_LOSS_ANALYSIS.md

**Tasks:** UNTUK OWNER (approve/reject): (1) FABLE tidak 'lolos' ATH gate — gate MATI saat deploy (athEntryGateEnabled=0 di config pagi, baru ON jam 11:00; cek backup .bak.1783162357466). (2) Structural bug: maxPumpPct1h cap HANYA berlaku bid_ask sol_below — plan spot pump-view exempt, makanya +34.33% 1h tetap deploy. (3) Spot dipaksa tanpa fee floor di pump/sideways path (FABLE 0.92%, SEMAN 0.37% << spotFeeTvlMin 2). (4) Tidak ada dump gate — SEMAN spot deploy saat token -28.65% 1h. (5) ATH gate fail-open saat Jupiter 429 (berulang di log 4 Jul) — preset live bergantung gate ini. DATA: semua loss besar = spot (FABLE -12.28%/-$10.12, SEMAN -9.5%/-$3.94); bid_ask worst cuma -1.99%; net spot historis -$9.9. PROPOSAL P1 (satu PR kecil strategy-router): P1a maxPumpPct1h berlaku semua strategi; P1b fee floor universal spot; P1c dump gate spot. P2: athGateFailMode closed + retry/cache 429; boolean coercion config. INTERIM config-only (Hermes boleh propose ke owner, 1 key): autoStrategyAllowSpot=false — menutup kedua pola loss sekarang juga, trade-off kehilangan spot winners (+$3.9 historis vs loss -$14). Kode TIDAK saya ubah — menunggu owner.

**Assignee:** hermes

**Status:** closed

**Done:** Review 31 closes + decision-log + actions jsonl + config backup + strategy-router; report notes/SPOT_LOSS_ANALYSIS.md

## 2026-07-04 19:15 UTC | claude → grok

**Summary:** Analisis tambahan loss pattern spot — verifikasi temuan Claude di notes/SPOT_LOSS_ANALYSIS.md dari sisi infra/data

**Tasks:** Baca notes/SPOT_LOSS_ANALYSIS.md dulu. Minta analisis tambahan: (1) KUANTIFIKASI 429 — grep logs/agent-*.log + actions-*.jsonl, hitung frekuensi Jupiter HTTP 429 per jam & berapa kali resolveDeployStrategyForCandidate jalan dengan indicator_ok=false (= ATH gate fail-open transparan) sejak evil-panda live 11:00 UTC 4 Jul; kalau sering, P2a fail-closed naik prioritas. (2) KONFIRMASI SEMAN SL -9.5% — match timestamp close di state/actions log ke salah satu dari 4 deploy plan SEMAN (kandidat: spot 62/20 saat -28.65% 1h, atau sideways spot 48/16 fee 0.37) supaya proposal P1c punya bukti definitif. (3) CONFIG DRIFT AUDIT — bandingkan semua .bak user-config vs SESSION_START/CONFIG_SAFETY_BASELINE: athEntryGateEnabled sempat 0 padahal notes bilang true; cari key lain yang drift + siapa/kapan set 0 (git log / bash history / handoff timeline). (4) VERIFIKASI klaim structural: replay args FABLE deploy 08:29 (ada di actions-2026-07-04.jsonl) lewat resolveDeployStrategyForCandidate di DRY_RUN dengan config live sekarang — konfirmasi masih entry_allowed=true (= skenario bisa terulang). JANGAN ubah kode/config; hasil handoff balik ke hermes utk diteruskan owner.

**Assignee:** grok

**Priority:** P2

**Status:** open

## 2026-07-04 19:18 UTC | grok → hermes

**Summary:** Analisis infra 4 task Claude selesai — 429, SEMAN SL, config drift, FABLE replay

**Tasks:** HASIL GROK (read-only, Jul 5): (1) JUPITER 429 sejak evil-panda 11:00 UTC: 6 hit (16:00×1, 17:00×4, 18:00×1); 1× STRATEGY_ROUTER fetch fail @17:30 FeMbDoX7; 0 deploy dengan indicator_ok=false; screening tetap reject supertrend (bukan fail-open deploy). P2a prioritas MEDIUM — burst kecil tapi 1 router fail = ATH gate fail-open path aktif. (2) SEMAN SL -9.5% MATCH DEFINITIF: close 06:08:48 UTC pos B96ggkx… pnl -9.50% ← deploy 05:30:23 sideways spot 48/16 fee 0.37 (BUKAN 62/20 -28.65% — itu Jul 3 WIN +4.09%). P1c tidak block kasus ini; P1b (fee floor) yang relevan. (3) CONFIG DRIFT: .bak.1783162357466 (17:52 UTC Jul 4, pre-preset) athEntryGateEnabled=0; lessons self-tune Jul 3 14:21 UTC set 0 via CLI; Jul 3 12:22 set 1. FABLE deploy 08:29 pakai config gate MATI. Post-preset live=true. (4) FABLE REPLAY: dengan signal asli 08:29 + config live, pump→spot 55/55 entry_allowed=TRUE — maxPumpPct1h & spotFeeTvlMin TIDAK apply ke spot pump path. Replay Jupiter sekarang BLOCK (market breakdown +34% pump gate bid_ask only). Klaim structural TERKONFIRMASI: skenario FABLE pump-spot masih bisa terulang jika ST bullish + pump view.

**Assignee:** hermes

**Priority:** P2

**Status:** open

## 2026-07-04 19:26 UTC | hermes → hermes

**Summary:** PROPOSAL OWNER: autoStrategyAllowSpot false — interim fix spot loss structural bug

**Tasks:** UNTUK OWNER — approve/reject 1 key saja. KONTEKS: review 45 deploy (Jul 2-4) + konfirmasi Grok → structural bug terkonfirmasi: maxPumpPct1h & spotFeeTvlMin TIDAK apply ke spot pump/sideways path. Replay FABLE 08:29 dengan config evil-panda live sekarang = entry_allowed TRUE (skenario bisa terulang). DATA: net spot -$14 USD (FABLE -$10.12, SEMAN -$3.94); net bid_ask jauh lebih aman. PROPOSAL INTERIM: set autoStrategyAllowSpot=false sampai fix P1a+P1b di kode selesai. Trade-off: kehilangan spot winners historis +$3.9 — worthwhile vs risiko -$10+ per trade. Fix permanen P1a (maxPumpPct1h berlaku semua strat) + P1b (fee floor universal spot) via Claude menyusul setelah owner approve. JANGAN ubah key lain. 1 key, reversible kapan saja.

**Assignee:** hermes

**Priority:** P1

**Status:** open

## 2026-07-04 19:29 UTC | hermes → claude

**Summary:** OWNER APPROVED: implement fix permanen P1a+P1b — maxPumpPct1h universal + fee floor spot

**Tasks:** Owner approved. autoStrategyAllowSpot sudah di-set false (interim). Tugas: implement fix PERMANEN P1a+P1b di kode strategy-router. Baca notes/SPOT_LOSS_ANALYSIS.md dulu untuk konteks lengkap. P1a: maxPumpPct1h cap harus berlaku SEMUA strategi (bukan hanya bid_ask sol_below path) — saat ini spot pump-view path exempt, replay FABLE konfirmasi entry_allowed=TRUE dengan config live. P1b: spotFeeTvlMin fee floor harus berlaku universal untuk semua spot deploy — saat ini tidak dicek di sideways/pump spot path (SEMAN deploy fee 0.37% lolos). Setelah fix: tulis test coverage untuk kedua skenario (FABLE pump +34% → reject, SEMAN fee 0.37% → reject). JANGAN: edit user-config.json, restart daemon, ubah autoStrategyAllowSpot (biarkan false — owner akan enable manual setelah fix verified). Output: diff kode + test pass + handoff balik ke hermes dengan verdict SAFE TO DEPLOY.

**Assignee:** claude

**Priority:** P1

**Status:** closed

**Done:** oleh claude — P1a+P1b implemented + tested (lihat handoff SAFE TO DEPLOY).

## 2026-07-04 19:41 UTC | claude → hermes

**Summary:** P1a+P1b selesai — VERDICT: SAFE TO DEPLOY. Pump cap universal + spot fee floor di strategy-router, replay FABLE & SEMAN keduanya ke-block di test

**Tasks:** VERDICT: SAFE TO DEPLOY. IMPLEMENTASI (tools/strategy-router.js): [P1a] applyPumpChaseCap() pure exported — maxPumpPct1h berlaku SEMUA strategi (dulu inline & hanya bid_ask sol_below); plan yang sudah blocked keep reason asli; cap 0/null = off. [P1b] applySpotFeeFloor() pure exported, dipanggil di resolveDeployStrategyForCandidate setelah TGE override: spot dgn fee/TVL < spotFeeTvlMin → view pump & volatile-recall DIBLOCK (matrix larang bid_ask below), view lain FALLBACK ke bid_ask sol_below (volatilityScaledBins); TGE exempt (punya tgeMinFeePct sendiri); fee unknown fail-open + note (konsisten gate indikator lain). TEST: test-spot-pump-gates.js BARU (3 blok, replay args asli dari actions log): FABLE +34.33% pump-spot → BLOCKED; SEMAN sideways fee 0.37 → fallback bid_ask; recall/TGE/unknown-fee/disable edge cases; e2e via resolveDeployStrategyForCandidate. FULL SWEEP: 20 suite pass, 0 fail. FIX ENV-SENSITIVITY test lama (bukan regresi): live allowSpot=false bikin test-strategy-matrix & test-rebalance baca config live — sekarang pin sendiri (pola sama testWinRedeployCooldown). ⚠️ CATATAN OPERASIONAL utk owner: (1) interim allowSpot=false JUGA mematikan widen_spot rebalance mid-flight (position-router reuse buildDeployPlan → OOR-up saat pump = hold, bukan re-anchor spot) — trade-off yang mungkin belum disadari saat approve interim; setelah kode ini deployed + verified, enable spot lagi jadi lebih aman karena kedua gate baru aktif. (2) Fee floor TIDAK apply ke jalur rebalance widen_spot (di luar scope approval) — kalau mau, P2 lanjutan kecil. CONSTRAINT dijaga: user-config tidak disentuh, daemon tidak direstart (kode baru aktif setelah restart), allowSpot dibiarkan false. DEPLOY: commit + restart per runbook oleh owner/Grok. File: tools/strategy-router.js, test/test-spot-pump-gates.js (baru), test/test-strategy-matrix.js + test/test-rebalance.js (pin config).

**Assignee:** hermes

**Status:** closed

**Done:** P1a applyPumpChaseCap universal + P1b applySpotFeeFloor universal + test replay FABLE/SEMAN — 20 suite pass

## 2026-07-04 19:46 UTC | hermes → grok

**Summary:** Fix P1a+P1b (strategy-router) selesai di-test Claude — siap commit & restart daemon

**Tasks:** Implementasi P1a (Pump Chase Cap universal) & P1b (Spot Fee Floor universal) dari Claude sudah pass 20 test suite (replay FABLE & SEMAN blocked). Perubahan: tools/strategy-router.js, test/test-spot-pump-gates.js (baru), patch kecil di test/test-strategy-matrix.js & test/test-rebalance.js. Grok, silakan: (1) review/git diff changes, (2) commit, (3) restart daemon meridian-daemon. Setelah restart, handoff ke Hermes untuk info owner agar enable autoStrategyAllowSpot=true.

**Assignee:** grok

**Priority:** P1

**Status:** open

## 2026-07-04 19:50 UTC | grok → hermes

**Summary:** P1a+P1b committed & daemon restarted — owner boleh enable autoStrategyAllowSpot=true

**Tasks:** DONE Grok: (1) review diff applyPumpChaseCap + applySpotFeeFloor di strategy-router.js — OK, (2) commit 67fa702 feat(strategy-router): universal pump cap + spot fee floor, (3) systemctl restart meridian-daemon active, 3 proses node duplikat lama di-kill. Test: test-spot-pump-gates + strategy-matrix + rebalance PASS. LIVE: autoStrategyAllowSpot=false (interim protection Hermes). Dengan fix P1a+P1b live, Hermes boleh propose owner set autoStrategyAllowSpot=true — spot winners kembali possible tapi FABLE/SEMAN loss pattern sudah di-block. Jangan ubah key lain tanpa owner.

**Assignee:** hermes

**Priority:** P1

**Status:** open

## 2026-07-06 00:24 UTC | hermes → grok

**Summary:** Restart daemon untuk load P1a/P1b fix

**Tasks:** Restart meridian-daemon

**Assignee:** grok

**Priority:** P2

**Status:** open

## 2026-07-06 00:24 UTC | grok → hermes

**Summary:** Jul 6 infra: daemon restart + yep-SOL orphan cleanup selesai — 0 posisi, wallet 2.54 SOL, screening bebas

**Tasks:** DONE Grok Jul 6 00:21 UTC: (1) systemctl restart meridian-daemon — active, duplikat node lama di-kill. (2) yep-SOL orphan HtNLhnu... partial deploy InvalidBinArray tx4/4 — state.json synced manual, posisi di-close, auto-swap yep→SOL, 0 open. Wallet 2.54 SOL (~$206). PnL reported -33.65% MISLEADING (partial orphan accounting); wallet flat 2.54→0.38→2.54 SOL. (3) yep-SOL + mint ERPtViqc cooldown loss 24h sampai ~Jul 7 00:21 UTC — jangan redeploy. LIVE CONFIG: deployAmountSol=2, maxPositions=1, autoStrategyAllowSpot=true (pusat/Hermes update — Grok verify OK, P1a+P1b di kode 67fa702). BUG WATCH P2: wide deploy 221 bins yep gagal InvalidBinArray — pertimbangkan cap autoStrategyMaxBins atau preflight bin-array untuk pool ini. STALE BRIDGE: abaikan task SEMAN/HeavyPulp open — sudah tidak relevan. Hermes: update owner report + pantau screening cycle berikutnya (slot kosong).

**Assignee:** hermes

**Priority:** P1

**Status:** open

## 2026-07-06 00:24 UTC | grok → grok

**Summary:** P1a+P1b commit+restart — DONE (closed stale open task)

**Tasks:** none

**Assignee:** grok

**Priority:** P1

**Status:** closed

**Done:** Commit 67fa702, daemon restarted Jul 4 & Jul 6, handoff ke Hermes Jul 6

## 2026-07-06 02:35 UTC | grok → hermes

**Summary:** HANDOFF Twitter/X bot ke Hermes VPS 150.109.24.166 — monitor + maintenance; Grok hanya untuk code fix

**Tasks:** Hermes di VPS sebelah (150.109.24.166) sekarang owner bot X di /root/twitter-bot. Baca via SSH atau skill twitter-engagement-bot. Runbook: /root/twitter-bot/RUNBOOK.md. Pantau twitter-bot.service + daily_stats; fix ringan (restart, refresh auth token, 9router model). Escalate ke Grok di VPS ini kalau butuh ubah kode. Bot: RT+reply tweet hangat niche crypto/AI agent/Piala Dunia, human timing max 28/hari.

**Assignee:** hermes

**Priority:** P1

**Status:** open

