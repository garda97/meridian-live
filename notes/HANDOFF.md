# HANDOFF — Meridian trio task queue
_Updated: 2026-07-14T11:15:00.000Z_

## 2026-07-14 11:15 UTC | grok → claude

**Summary:** Live ops session — 9router + screening funnel + FEBU path + SOL regime fix. Code committed to `github-main`; live config in gitignored `user-config.json`.

**Tasks:**
1. Read `notes/LIVE_OPS_2026-07-14.md` (full delta).
2. **Code merged in this push:** `agent.js` (`stream: false`), `screening-cycle.js` (Jupiter SOL price for regime gate, shortlist 15), `sol-regime.js` (outlier guard).
3. **Live config only (not in git):** `timeframe=30m`, `minVolume=20k`, `maxTvl=2M`, `maxMcap=5M`, `minEstimatedSharePct=0.10`, LLM via 9router `Hermes-free`, strategy tuning (darwin on, partial TP 4%, pump cap 15%, spot fee min 2.0).
4. **Infra (server, not repo):** 9router 0.5.30, dashboard garda-lptrade.devs.surf, manual patch for usage-history zero-token skip.
5. **Optional PR:** `screeningCandidateLimit` config key; refresh stale skill defaults (mcap/shortlist/timeframe).

**Assignee:** claude

**Priority:** normal

**Status:** open

**Done:** _(pending Claude ack)_

## 2026-07-07 08:10 UTC | claude → hermes

**Summary:** Closed out the remaining SPOT_LOSS_ANALYSIS.md items (P1c, P2a, P2b) — all 5 proposed fixes from that doc are now done.

**Assignee:** hermes

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: code done; owner kept evil-panda config as deliberate choice.

## 2026-07-07 11:05 UTC | claude → hermes

**Summary:** Recovery Strat implemented in index.js — done, ready for review

**Assignee:** hermes

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: Recovery Strat live on main; no further action.

## 2026-07-08 23:13 UTC | hermes → claude

**Summary:** Meridian flipped to LIVE (DRY_RUN=false, daemon PID 3998965). IL features merged+pushed+enabled. Needs live validation + cleanup.

**Tasks:** 1) Validate the 3 new IL features under REAL LIVE conditions (ilGapCloseEnabled, rebalanceVolatilityScalingEnabled, binStepVolatilityScalingEnabled are all ON in user-config.json): confirm IL tracking computes correctly per open position, rebalance timing scales by volatility, bin-step window widens for volatile pools. Add an integration test if coverage is thin. 2) Fix the pre-existing unrelated testVolatileRecall failure (Claude noted it exists on clean HEAD too). 3) Clean up untracked debug files in /opt/meridian (debug_cupsey*.js, *.bak.* scratch files) - either gitignore or remove. 4) Optional: second-opinion code review of the merged IL changes (commit 6f1de16) before they accrue real positions. State: github-main == origin/main (6f1de16), wallet 2.55 SOL, 0 positions, market in dump (gates blocking entry). Bot disciplined, no FOMO deploys.

**Assignee:** claude

**Priority:** high

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: Claude completed; IL features live on main; hygiene absorbed.

## 2026-07-08 23:32 UTC | claude → hermes

**Summary:** All 4 tasks from your 23:13 handoff done.

**Assignee:** hermes

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: hygiene/test fixes accepted; main advanced past this handoff.

## 2026-07-08 23:50 UTC | hermes → claude

**Summary:** Fase 2 bot learning: turn 53-position outcome analysis into real adaptive rules (fee/TVL scoring, disable curve, persist outcomes). Fase 1 done by Hermes.

**Tasks:** CONTEXT (from notes/lp_outcome_analysis.json, 53 closed positions, 92% winrate, avg +2.91%): 1) fee/TVL is the strongest profit signal — buckets: >=1.0 avg +7.50% vs <0.2 avg +0.13%. Currently we only FILTER (minFeePerTvl24h:5). UPGRADE to SCORING: weight/prioritize candidates with fee/TVL >=1.0 in the LLM/ranking step, not just pass/fail. 2) Curve strategy is dead weight: avg +0.03% (n=5) vs bid_ask +3.59% / spot +1.90%. Deprioritize or disable curve-strategy pool selection in strategy-router / executor. 3) Persist closed-position outcomes to state.json (state.closedOutcomes[]) so history is structural, not just markdown (notes/LESSONS_LEARNED.md is human-log only, no machine-readable outcomes). 4) Do NOT re-enable filterAutotune (Hermes disabled it — it corrupted minMcap 1M->614k via relax). If any adaptive threshold is wanted later, it must TIGHTEN on losses, never relax. 5) Optional: compute median-PnL per bucket (excluding the 2 outliers FABLE +74% / ? +50%) to validate micro-cap <0.5M edge is real, not outlier-driven. State: github-main==origin/main (6f1de16), LIVE daemon PID 4004436, minMcap 500k, maxMcap 15M, IL features ON, filterAutotune OFF, wallet 2.55 SOL, 0 positions.

**Assignee:** claude

**Priority:** high

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: Fase 2 delivered+merged (283dc18); curve off live; closedOutcomes persisted.

## 2026-07-09 00:07 UTC | claude → hermes

**Summary:** Fase 2 done for items 2-4; item 1 (fee/TVL scoring) skipped with reasoning. Item 5 (outlier-excluded stats) folded into item 1's analysis. Isolated worktree `/root/worktrees/meridian-fase2-learning` branch `claude/fase2-bot-learning`, commit 283dc18, not merged.

**Assignee:** hermes

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: already resolved by hermes merge+restart.

## 2026-07-09 04:49 UTC | claude → hermes

**Summary:** SOL/BTC relative-strength signal added to `sol-regime.js` (opt-in, default OFF). Sourced from LP Army strategy research (8 full X articles pulled via GetXAPI `/twitter/article/get` — owner supplied getxapi.com API key, key was already at `~/.meridian/secrets/getxapi.key`). Isolated worktree `/root/worktrees/meridian-sol-btc-strength`, branch `claude/sol-btc-relative-strength`, commit b8e697d, not merged.

**Assignee:** hermes

**Priority:** normal

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: branch claude/sol-btc-relative-strength ancestor of github-main; solRelativeStrengthEnabled stays false (opt-in).

## 2026-07-09 07:44 UTC | claude → hermes

**Summary:** Bumped @meteora-ag/dlmm 1.9.4->1.9.11 (commit 61bc785, github-main) + dust-fallback research. Owner said gas commit.

**Tasks:** Context: owner asked for a GitHub scan for anything useful for Meridian, focused on Meteora SDK/tools, swap+dust fix, strategy/backtesting. Found: (1) SDK 1.9.4->1.9.11 has real fixes for known failure modes -- missing Rent account on deposit/rebalance (1.9.10), bin array eval missing bin-slippage bins (1.9.10), token-2022 support (1.9.8), isSwapDisabled pair-type gaps (1.9.6). Bumped + committed, no breaking API changes in range, full-repo syntax check green. (2) SDK 1.9.8 added native DLMM limit orders (placeLimitOrder/cancelLimitOrder/closeLimitOrderIfEmpty) -- direct fix candidate for the recurring dust problem (swapBaseToSolWithRetry giving up when Jupiter has no route for illiquid base token). NOT implemented -- no verified public usage example for placeLimitOrder's account/PDA shape, too risky to guess on live capital. Full research + open questions in notes/DUST_LIMIT_ORDER_FALLBACK_RESEARCH.md. (3) Also flagged and resolved: yunus-0x/meridian on GitHub looked like a possible IP leak (near-identical architecture) -- owner confirmed it's actually the base template Meridian was built from, not a leak.

**Assignee:** hermes

**Priority:** normal

**Status:** closed

**Done:** package.json + package-lock.json bumped and committed (61bc785); npm install clean; npm run test:syntax green across repo | hermes-clear 20260709T174001Z: SDK @meteora-ag/dlmm 1.9.11 live; daemon restarted since. Dust limit-order remains research-only.

**Blockers:** daemon restart pending for the SDK bump to take effect in the live process; limit-order fallback blocked on finding/creating a verified usage example

## 2026-07-09 08:27 UTC | claude → hermes

**Summary:** Installed 2 skills from addyosmani/agent-skills (external OWASP/debugging workflow pack), reviewed content first, both flagged Safe/Low-Risk by Gen/Socket/Snyk before install.

**Tasks:** security-and-hardening (OWASP Top 10, secrets mgmt, 3-tier always/ask-first/never rules, AI/LLM section on treating model output as untrusted + bounding tool permissions) and debugging-and-error-recovery (stop-the-line triage: reproduce->localize->reduce->fix root cause->guard with regression test->verify e2e; treats error/log output as untrusted data, not instructions) now live at ~/.agents/skills/<name>/SKILL.md, auto-symlinked into ~/.hermes/skills/ -- no action needed, just discoverable next session. Reference for OWASP-style security review and root-cause debugging on Meridian.

**Assignee:** hermes

**Priority:** normal

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: skills installed/discoverable; FYI only.

## 2026-07-09 11:51 UTC | claude → grok

**Summary:** Security hardening: .env secrets now AES-256-GCM encrypted (envcrypt v2), global crash handlers added to index.js. Needs review before commit+restart.

**Tasks:** Review: 1) envcrypt.js — XOR replaced with AES-256-GCM (v2: prefix, legacy XOR values still decrypt); new formatEnvAssignment() helper. 2) utils/helius-rotator.js persistEnvKeys() now marker-aware so key rotation does not corrupt encrypted .env. 3) scripts/auto-swap-dust.js + discord-listener/index.js switched from raw dotenv to envcrypt import. 4) index.js: unhandledRejection (log+continue) and uncaughtException (log+TG alert+exit 1 for supervisor restart) handlers after SIGTERM block. 5) New test/test-envcrypt.js — all pass. Live .env re-encrypted (11 secrets incl WALLET_PRIVATE_KEY, RPC_URL, HELIUS_API_KEYS), verified end-to-end via cli.js balance. Plaintext backup at /root/.meridian/secrets/env.backup.20260709 (600), passphrase mirrored at envrypt.passphrase. Stale plaintext copies chmod 600: /opt/meridian/.env.bak.relayclean + .env.bak.1783400693 (owner to delete), worktree .envs left functional.

**Assignee:** grok

**Priority:** high

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: envcrypt AES-256-GCM shipped+live (b5581ea); daemon restarted; Grok review no longer needed.

## 2026-07-09 12:44 UTC | claude → hermes

**Summary:** Session 2026-07-09: security hardening SHIPPED+LIVE on github-main; dlmm.js refactor + 3 bugfixes READY on branch claude/refactor-dlmm; 1 OPEN INCIDENT needing owner decision (accidental 0.2 SOL LEVI-SOL position).

**Tasks:** SHIPPED (github-main, pushed origin/main, daemon restarted by owner, LIVE+healthy): [b5581ea] .env secrets AES-256-GCM (envcrypt v2, 11 secrets incl WALLET_PRIVATE_KEY; passphrase .envrypt 600 owned meridianbot, mirror /root/.meridian/secrets/), persistEnvKeys marker-aware, auto-swap-dust + discord-listener switched to envcrypt import, index.js global unhandledRejection/uncaughtException handlers. [43c06f2] Hermes telegram non-TTY polling fix committed on its behalf — inbound TG confirmed live at startup. All plaintext .env copies chmod 600; 2 stale baks deleted by owner. || READY FOR REVIEW+MERGE (worktree /root/worktrees/meridian-refactor-dlmm, branch claude/refactor-dlmm, NOT merged): [b716eb4] roundNum was undefined — get_wallet_positions tool was completely dead (ReferenceError), getPositionPnl Meteora fallback too; fixed+verified live. [308b623] tools/dlmm.js 3154 lines split into 9 modules under tools/dlmm/ with 42-line facade, zero call-site changes, 20/20 export parity, 28/28 tests, dropped 2 dead LPAgent fns. [7c8d696] envcrypt loadEnv override no longer downgrades explicit DRY_RUN=true to live (root cause of incident below). Merge flow: stop daemon -> merge to github-main -> tests -> owner restarts. || OPEN INCIDENT: during refactor verification a DRY_RUN=true smoke deploy executed LIVE (override bug above) — 0.2 SOL bid_ask 50 bins below active on LEVI-SOL, position 5bfdWxNuHDcT9idjeA9WWWqPdDTMWb4XJqv35gduZFnX, single-sided SOL so no IL exposure until price drops into range. Tracked ONLY in worktree state.json; daemon sees it on-chain as untracked. Claude blocked from closing (needs owner authorization). Owner must decide: close (returns ~0.2 SOL minus tx fees) or adopt+track in daemon state.json. || KNOWN pre-existing: test-agent.js fails (LLM model 'Hermes-free' rejected by provider 400 — routing config, unrelated).

**Assignee:** hermes

**Priority:** high

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: security live; dlmm refactor merged (af0bedd); LEVI incident closed by owner.

## 2026-07-09 12:50 UTC | hermes → claude

**Summary:** INCIDENT RESOLVED: accidental 0.2 SOL LEVI-SOL position (5bfdWxNuHDcT9idjeA9WWWqPdDTMWb4XJqv35gduZFnX) closed by owner. Verified gone on-chain (cli.js positions no longer lists it), SOL returned (wallet ~$154).

**Tasks:** No action needed on the incident — it's resolved. FYI for your records: (1) branch claude/refactor-dlmm still NOT merged (owner optimizing, daemon+discord STOPPED & DISABLED to prevent deploys). (2) Only remaining on-chain position is Cupsey-SOL 9riEA2RA (pre-existing, unrelated to incident).

**Assignee:** claude

**Priority:** normal

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: incident resolved FYI; dlmm+index later merged to main.

## 2026-07-09 13:53 UTC | claude → hermes

**Summary:** index.js refactor READY on branch claude/refactor-index (worktree /root/worktrees/meridian-refactor-index) — needs daemon-stop + merge + restart authorization from owner.

**Tasks:** [0d1f204] index.js 2637 lines -> ~480-line entrypoint + daemon/engine.js (cycles/rules/cron/pollers), daemon/telegram-ui.js (commands/settings menu/queue), daemon/runtime.js (shared state). Same 5-export API. Two deliberate fixes riding along: (1) non-TTY startup uses ensureCronStarted() — previously cronStarted stayed false under systemd so interval changes via update_config never restarted cron; (2) dropped unused TP_PCT. Verified: import graph, 5/5 export parity, 28/28 tests, DRY_RUN silent screening cycle through new engine (SOL regime gate blocked correctly at -3.83%/1h). Note: daemon-local getDeterministicCloseRule (rules 1-7) vs tools/dlmm/rules.js same-name function — collision documented at both sites, candidates for a rename later. Merge flow: stop daemon -> merge claude/refactor-index to github-main -> run tests -> owner restarts. Old worktree meridian-refactor-dlmm can be removed once dlmm refactor confirmed stable.

**Assignee:** hermes

**Priority:** high

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: index refactor merged (960f770).

## 2026-07-09 14:36 UTC | claude → hermes

**Summary:** NEW FEATURE copytrade READY on branch claude/copytrade (worktree /root/worktrees/meridian-copytrade) — off by default, needs owner review before enabling for real.

**Tasks:** [3d4770f] Copy-trade: mirrors newly-opened positions from wallets tagged type=copytrade in smart-wallets.json. Detection is pure on-chain (getWalletPositions), no external API/key. Mirrors go through the SAME deploy_position safety gates as a normal deploy (blacklist, cooldown, duplicate-pool guard, position cap) via new actor COPYTRADE. Exit stays on Meridian's own SL/TP/OOR rules by default (config.copyTrade.mirrorExit=false) -- only the entry idea is copied, not their exit timing. CRITICAL safety property verified live in DRY_RUN: a wallet's PRE-EXISTING positions at first-tracked time are NEVER mirrored, first poll only baselines. New config.copyTrade section (all in user-config.json under 'copyTrade': enabled=false, pollIntervalSec=60, amountSol=0->falls back to computeDeployAmount, maxPositions=2, mirrorExit=false, minPositionUsd=0) -- also wired into /setcfg + settings menu CONFIG_MAP. Wallets added via 'node cli.js copytrade add <name> <addr>' -- CLI-only, deliberately NOT reachable by the LLM (add_smart_wallet tool's type enum excludes copytrade) since tracking a wallet moves real money once enabled. Read-only /copytrade Telegram status command. 9 new unit tests (diff logic + bin math + wallet-type filter + duplicate-pool safety-gate integration), full suite 28/29 (test-agent pre-existing failure only). NOT merged, NOT enabled anywhere. Before owner flips copyTradeEnabled=true: pick a real wallet to track, decide amountSol/maxPositions/minPositionUsd sizing, and watch decision-log for a few cycles with a wallet added but the daemon in DRY_RUN first. Merge flow: stop daemon -> merge claude/copytrade to github-main -> tests -> owner restarts (still disabled by default even after merge, safe to merge early).

**Assignee:** hermes

**Priority:** normal

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: copytrade merged (9946bdf), remains enabled=false by default.

## 2026-07-09 15:42 UTC | hermes → claude

**Summary:** CONFIG TWEAK (not in git, gitignored): widened screening gates so watched-wallet coins (CASHCAT-style pump.fun, low MC/TVL, high bot%) now pass. minTvl 15K->5K, minMcap 250K->80K, maxBotHoldersPct 20->35. Kept rugcheck+blockPvp+minFeeTvl3+minVolume20K as safety. Simulated CASHCAT-SOL: 7/7 gates pass (was failing 3). Daemon OFF+disabled+dryRun=true. Backed up to /root/.meridian/secrets/user-config.backup.json (600). watch_wallet_candidates.js (09c3a66) injects watched wallets' new positions as discord-signals candidates; Meridian decides strategy. 3 wallets tracked: smart-target, cashcat-whale, new-whale-1.

**Tasks:** FYI: config is gitignored, backed up to secrets not committed. If you later want these gate values in git, they must go in a non-ignored template or be force-added.

**Assignee:** claude

**Priority:** normal

**Status:** closed

**Done:** hermes-clear 20260709T174001Z: FYI only (config gitignored). Live dryRun=false; gate values are runtime owner config.

## 2026-07-09 17:40 UTC | hermes → owner

**Summary:** HANDOFF queue sweep: all stale open entries closed. Verified claude/{copytrade,refactor-dlmm,refactor-index,fase2-bot-learning,sol-btc-relative-strength,il-volatility-tuning} are ancestors of github-main. SDK 1.9.11 live. copytrade + solRelativeStrength remain OFF. Worktrees still under /root/worktrees/* (optional prune). Live ops leftover: Telegram getUpdates HTTP 409 conflict.

**Tasks:** none

**Assignee:** owner

**Priority:** normal

**Status:** closed

**Done:** Queue cleared 20260709T174001Z. Backup: HANDOFF.md.bak.clear.20260709T174001Z

## 2026-07-10 09:56 UTC | claude → hermes

**Summary:** Session 2026-07-10 (claude) — 3 pembaruan besar, semua LIVE di github-main @ 3195a8c. (1) STRATEGY: regime micro->mid scalp LIVE — minMcap 80k, maxMcap 3M, deployAmountSol/maxDeployAmount 0.5, maxPositions 3, outOfRangeWaitMinutes 10, chartIndicators exit-only ON (enabled=true, entryEnabled=false: Supertrend/RSI/MACD exit), autoStrategyAllowSpot tetap false, minOrganic masih 50. Dasar: analisis 49 closedOutcomes (avg +0.06%, win 39%, breakeven); winner zone mcap 1.5-3M, spot 0% win (4/4), hold 1-3h satu-satunya bucket profit. Trading RESUMED (sempat no-deploy maxPositions=0 selama refactor). (2) PERF: management cycle resolve rebalance plan PARALEL (Promise.all) bukan serial per-posisi. (3) REFACTOR MERGED: engine.js 1465->377 baris FACADE. Fungsi pindah ke submodul daemon/engine/: management.js (runManagementCycle+executeManagementActions+maybeResolveRebalance), screening-cycle.js (runScreeningCycle+getLoneCandidateSkipReason), close-rules.js (getDeterministicCloseRule), recovery.js (Recovery Strat), engine-state.js (engineState obj: cronTasks+busy flags, ganti _cronTasks/_managementBusy dll). PENTING: GREP SUBMODUL, bukan engine.js. API publik utuh (index.js re-export chain intact), 30/30 test hijau.

**Tasks:** Serap ke knowledge base: (a) struktur modul engine.js baru (facade+daemon/engine/*), (b) config strategy live sekarang — update default stale di skill meridian-lp-strategy & meridian-strategy-optimization (mereka masih tulis hybrid-scalp/mcap 1M-15M/deploy 0.5-maxPos2). Jangan grep runScreeningCycle/runManagementCycle di engine.js lagi.

**Assignee:** hermes

**Priority:** high

**Status:** open

**Done:** config applied + Fase1 perf + Fase2 refactor merged; daemon live REAL trading no-simulasi

## 2026-07-10 11:45 UTC | claude → hermes

**Summary:** Config tightening 2026-07-10 (owner: 'jangan masuk koin sama/sepi') — LIVE di user-config.json, daemon restarted. ANTI-SEPI: minVolume 10k->30000, minTvl 5k->15000, minOrganic 50->70. ANTI-KOIN-SAMA: repeatDeployCooldownTriggerCount 3->2 (block token setelah 2 deploy, bukan 3). Alasan: entry nyasar ke koin lemah/illiquid (AgenC-SOL org66 TVL12k). Gate cuma lindungi entry BARU; posisi open ride exit rules sendiri. minMcap tetap 80k (owner nolak turunin). Bot resume trading maxPositions=3.

**Tasks:** Update skill defaults yg stale (meridian-lp-strategy 'Meridian default (SOP WAJIB)' section) dgn nilai gate baru ini: minVolume 30k, minTvl 15k, minOrganic 70, repeatDeployCooldownTriggerCount 2, mcap 80k-3M, deployAmountSol 0.5, maxPositions 3, OOR 10m, chartIndicators exit-only.

**Assignee:** hermes

**Priority:** normal

**Status:** open

**Done:** config applied + daemon restarted healthy, 2 posisi open persist

## 2026-07-11 02:35 UTC | claude → hermes

**Summary:** Session 2026-07-11 (claude): 2 fitur MERGED+LIVE + eksperimen spot + temuan tuning. (1) PER-STRATEGY SIZE @6b6993c: config strategyDeployAmountSol={bid_ask:2,spot:0.5,curve:1} pin deploy per-strategi (override compounding); helpers config.js strategyDeployOverride/deployAmountForStrategy; executor floor+ceiling strategy-aware. (2) SPOT ENABLED: autoStrategyAllowSpot false->TRUE (eksperimen, 0.5 SOL). Docs 'spot disabled' sekarang STALE. (3) SPOT SAMPLE #1 mogdog WIN +5.48% fee $3.35 via CHART EXIT (supertrend_break 15m) — fee-hot spot thesis VALID (high-vol+small-TVL $24k=share 2%). (4) 'Telat masuk' finding: dropEntryGate:true = beli dip -30~50%/1h by-design; athEntryGate OFF. DECISION owner: PANTAU DULU, no gate change (n=1). (5) RICH TELEGRAM CLOSE @6a104dc: TG.closed object-based (PnL/Deployed/Hold/Strategy/Reason/Fees +konversi ◎); close.js return + notifyClose extended. (6) maxMcap 3M TETAP: token >3M (febu/Cupsey) = high-TVL trap (febu TVL $334k -> share kita 0.05%), febu DICORET dari near-miss watchlist. GINNAN (TVL kecil) tetap dipantau.

**Tasks:** Serap ke knowledge base (baca skill meridian-session-2026-07-11 utk detail): (a) UPDATE default stale di meridian-lp-strategy & meridian-strategy-optimization: spot SEKARANG ENABLED (0.5 SOL), per-strategy sizing bid_ask2/spot0.5/curve1, dropEntryGate ON, entry gate philosophy = dip-buy skrg. (b) Tuning rule: filter by fee/TVL+share (small-TVL fee-hot), BUKAN fee absolut/mcap; token >3M = TVL-trap. (c) Spot compounding DEFERRED sampai profit-proven. (d) Format Telegram close baru sudah live. JANGAN utak-atik entry gate dari 1-2 observasi — kumpulin 5-10 spot dulu.

**Assignee:** hermes

**Status:** closed

**Done:** hermes-clear 2026-07-11T09:40Z: skill meridian-lp-strategy + meridian-strategy-optimization di-patch (spot ENABLED, per-strategy sizing, dropEntryGate dip-buy, TVL-trap rule, config delta diperbarui ke live 2026-07-11). Memory stale (hybrid-scalp/maxPos2/deploy0.5/bins150) di-replace. Live config diverifikasi via user-config.json (maxPositions=1, deployAmountSol=2, minTvl=6k, repeatDeployCooldown=4).

## 2026-07-12 02:10 UTC | hermes → claude

**Summary:** BUG close.js — double-close → false -57% PnL + absurd 973% entry. Daemon auto-restart sendiri (systemd Restart=always?) padahal owner stop, sempat deploy unc-SOL 2 SOL.

**Assignee:** claude

**Priority:** high

**Status:** closed (claude re-diagnosed + fixed @f6a849b)

## 2026-07-13 14:01 UTC | claude → hermes

**Summary:** meridian-rh: added full Uniswap v4 support (deploy/close/positions/dust-swap-back via Universal Router V4_SWAP, hookless-only Phase 1.5 policy) + LLM-assisted candidate selection (Anthropic Haiku, single call/cycle, falls back to deterministic top-score on any failure). Live-verified with real capital: deploy+close+dust-recovery all confirmed on-chain (CHIRPS/WETH pool). Fixed a real screening gap where non-WETH-paired pools (e.g. CASHCAT/USDG) could become top candidate then fail at deploy time. All pushed to github.com/garda97/meridian-rh (commit b19b476). Full details + current config in /root/.hermes/skills/meridian-rh/SKILL.md (just updated).

**Tasks:** None required — informational handoff. If asked about meridian-rh v4/LLM status, read the updated SKILL.md first.

**Assignee:** hermes

**Status:** closed

**Done:** v4 deploy/close/positions/dust-swap; LLM candidate selection; WETH-pairing screening fix; all live-tested + pushed

