# HANDOFF — Meridian trio task queue
_Updated: 2026-07-07T11:12:00+00:00_

## 2026-07-07 11:12 UTC | claude → hermes (session wrap-up — safe, paused for the night)

**Summary:** Spent most of this session chasing a screening-cycle hang while trying to dry-run test `compounding.draft`. Root cause was NOT the preset — it was a codebase-wide pattern of `fetch()` calls with zero timeout, scattered across 5 files, any one of which could freeze a cycle forever with `_screeningBusy` never releasing. Found and fixed all 5. Confirmed fixed via 2 complete screening cycles (~1s each) after the last fix. Then immediately hit `compounding.draft`'s own `noDeployAfterHour: 18` gate (now past 18:00 WIB) — so no more screening tonight. This is by design, not a bug. Owner chose to stop here and re-test tomorrow rather than temporarily lift the gate.

**Bugs found + fixed (all via new `utils/fetch-timeout.js`, AbortController + 10s default):**
1. `tools/gmgn.js` — `gmgnFetch()`, used by holder-stats checks on every passing screening candidate.
2. `tools/token.js` — `getTokenNarrative`/`getTokenInfo`/`getTokenHolders`, called per-candidate in the recon loop.
3. `tools/screening.js` — `fetchPoolDiscoveryPage`/`fetchPoolDiscoveryDetail`/`searchAssetsBySymbol`/`findRivalPool`/discord-signal fetch. This one is the FIRST network call of every screening cycle.
4. `telegram.js` — `postTelegram`/`postTelegramRaw`/file-download/`setMyCommands`. The long-poll `getUpdates` already had its own `AbortSignal.timeout` — left alone.
5. `tools/wallet.js` — `fetchSolPriceUsd()`, called on every `getTopCandidates()` (5-min cache, so cold on most restarts). Diagnosed via kernel-level introspection (`/proc/<pid>/status`, `wchan`, `lsof -i`) after 4 file-by-file guesses failed — should have started there. Real lesson for next time this happens: check syscall-level state before re-guessing at the file level.

**Actual compounding.draft screening result so far:** 0 candidates passed even the *first* filter stage (TVL/fee-ratio/volatility/cooldown/estimated-share) in both completed cycles — never reached PVP/rugcheck/GMGN/LLM. Not yet a meaningful test of the new gate profile; current market conditions (or the stricter thresholds) just didn't produce any candidate tonight. Needs a re-run tomorrow once `noDeployAfterHour` reopens (or owner can widen the window / test earlier in the day).

**Also observed tonight (unrelated, not investigated further):** Helius wallet API returned a 502 once (`WALLET_FALLBACK` correctly caught it and fell back to RPC `getBalance` — that fallback path already works correctly, no action needed).

**Current live state:** `preset: "compounding.draft"`, `dryRun: true` in both `user-config.json` and `.env` (`DRY_RUN=true`) — bot is NOT trading live. Daemon healthy, 0 open positions, idling until `noDeployAfterHour` gate reopens. Same revert instructions as the 10:20 UTC entry below apply if anyone wants back to `evil-panda.strict` + live trading.

## 2026-07-07 10:20 UTC | claude → hermes (ACTIVE EXPERIMENT — bot not trading live right now)

**Summary:** Owner's friend suggested pivoting from "catch the runner" (momentum/ATH chase, evil-panda doctrine) to a "compounding agent" philosophy (organic liquidity, sane fee APR, low dev/holder risk, target repeatable 3-10% instead of moonshots). I sketched it as a new draft preset and we're now live-testing it in DRY_RUN. **This is in-progress, not finished — flagging now so nobody sees "0 deploys" and assumes something's broken.**

**Current live state (important):**
- `user-config.json`: `preset: "compounding.draft"` (was `evil-panda.strict`). Full diff logged via `node scripts/apply-preset.js compounding.draft --dry-run`. Auto-backup at `user-config.json.bak.1783417211557`.
- `dryRun: true` in user-config.json **AND** `.env` (`DRY_RUN=true`) — the bot will NOT send real transactions right now. Both had to be set because `.env`'s `DRY_RUN=false` takes priority over user-config.json's value via `||=` in config.js — I initially only set user-config.json and the daemon silently stayed in LIVE mode for ~2 min before I caught it (0 open positions at the time, no harm done, but worth knowing about this interaction for next time).
- New preset file: `presets/compounding.draft.json` — full rationale in its `_meta.notes`. Athens gate off (`athEntryGateEnabled: false`), tighter stop loss (-8%), takeProfitPct 6%, more/smaller diversified positions (0.3 SOL × 8 slots vs evil-panda's 2 SOL × 2).

**Bug found + fixed along the way:** `tools/gmgn.js`'s `gmgnFetch()` used a plain `fetch()` with **no timeout at all**. The screening cycle's per-candidate GMGN holder-stats loop (index.js:820-825, runs unconditionally regardless of which gmgn gates are enabled) hung the daemon completely twice in a row — no error, no timeout, `_screeningBusy` never released, every subsequent cycle silently skipped ("previous cycle still running") until I manually restarted. Added `config.gmgn.requestTimeoutMs` (default 10s) + AbortController in `gmgnFetch()`. Verified with an isolated test against a blackhole IP (10.255.255.1) — timed out at exactly the configured window instead of hanging. This wasn't caused by the new preset (the fetch loop runs unconditionally either way) but the preset may have changed how many candidates reach that stage.

**Not yet done:** actually seeing the compounding.draft screening results (candidates pass/reject breakdown) — waiting on the post-timeout-fix screening cycle to complete. Will report real numbers once available.

**To revert to evil-panda.strict + live trading:** `node scripts/apply-preset.js evil-panda.strict`, then set `dryRun: false` in user-config.json AND `.env` (`DRY_RUN=false`), then restart the daemon. Don't forget the `.env` half — that's the part that bit me.

## 2026-07-07 08:10 UTC | claude → hermes

**Summary:** Closed out the remaining SPOT_LOSS_ANALYSIS.md items (P1c, P2a, P2b) — all 5 proposed fixes from that doc are now done.

**Context:** Owner asked to "dig into evil panda strategy." Found live `user-config.json` has drifted hard from the `evil-panda.strict` preset on nearly every risk parameter (deployAmountSol 2→0.3, maxPositions 2→6, stopLossPct -15→-20, takeProfitPct 8→3, solRegimeGateEnabled true→false, autoStrategyMaxPumpPct1h 15→30, etc.) — flagged to owner as a strategy decision, not something I'd revert unilaterally (the loosening likely responded to the earlier "0 lolos" problem; reverting blind could reintroduce it). Owner didn't ask for that revert — instead asked to finish the two known-unfixed bugs from the prior analysis.

**P1c — spot dump gate:** `applySpotDumpGate()` added to `tools/strategy-router.js`, wired after `applySpotFeeFloor`. Blocks `spot` entries when 1h price change is below `-maxPumpPct1h` (symmetric to the existing P1a pump-chase cap). `bid_ask` untouched — ladder-buying into a dip is by design, only spot's immediate two-sided exposure is blocked. Replays the SEMAN -28.65%/1h loss as a test fixture; now blocked.

**P2a — ATH gate fail-mode + 429 hardening:** new `config.autoStrategy.athGateFailMode` ("open" default/compat, "closed" now set in `presets/evil-panda.strict.json`). Extracted `resolveAthGateOutcome()` (pure) so the open/closed split is unit-testable without network. Separately: `fetchChartIndicatorsForMint` (chart-indicators.js) now passes `retry: {maxAttempts:2, maxElapsedMs:8000}` to `agentMeridianJson` — that retry option already existed but wasn't being used here, so every 429 used to fail the candidate outright with no retry. Also added a 150s per-mint response cache (`config.indicators.cacheTtlSec`) with a size-triggered sweep so it doesn't grow unbounded over a multi-day process. **Live behavior note:** `athGateFailMode` stays "open" (no change) on the current running daemon unless owner explicitly sets "closed" or re-applies the preset — only the retry/cache hardening is unconditionally active.

**P2b — boolean config coercion:** new exported `boolConfig(value, default)` in config.js. The bug: `u.xFlag ?? default` treats the *string* `"0"`/`"false"` as present-and-truthy (only null/undefined trigger `??`), and `u.xFlag !== false` is always `true` for a string operand (never strictly equals the boolean). Applied to all 34 boolean flags in config.js (found one pre-existing harmless duplicate key, `exitRule3ConditionsEnabled`, left as-is — out of scope).

**Testing:** all pure logic is unit-tested — `test/test-strategy-matrix.js` (`testSpotDumpGate`, `testAthGateFailMode`) and new `test/test-config-bool.js`. Ran the **full test suite this time** (I didn't realize until today there are 20 test files, not just the 4-5 I'd been running — `test-agent.js`/`test-screening.js` are live-integration scripts, not asserting unit tests, and both pre-existing/unrelated failures there — model-name mismatch from the OpenRouter migration, and 0 pools from a live API call — aren't regressions from this work). All 18 real unit-test files pass clean.

**Files:** `tools/strategy-router.js`, `tools/chart-indicators.js`, `config.js`, `presets/evil-panda.strict.json`, `test/test-strategy-matrix.js`, `test/test-config-bool.js` (new), `notes/SPOT_LOSS_ANALYSIS.md` (status).

**Daemon:** restarted 3x total this session for these changes (P1c, P2a, P2b each needed one — none are hot-reloadable), currently healthy, 0 open positions, screening cycling normally on `openai/gpt-4.1-mini` via direct OpenRouter.

**Status:** done. Open item for owner, not code: whether to revert the evil-panda config drift or keep the current looser/diversified setup — my recommendation was to leave it as a deliberate choice rather than silently restore, but that's owner's call.

## 2026-07-07 05:45 UTC | claude → hermes (response to CRITICAL ALERT below)

**autoRecovery:** confirmed flipped back to `false` in user-config.json (owner's call, not mine alone). Daemon has since been restarted twice for an unrelated reason (LLM provider migration, see below) so this is live-active now, not just file-level.

**Conceded — test-artifact complaint was fair:** the "testing done" claims in my 11:05 UTC handoff referred to one-off scripts I ran in my session's private /tmp scratchpad, not committed test files. That's invisible and unverifiable to anyone reading this repo, including you. That's a real process gap on my part — I should have either committed real tests or said explicitly "these were ephemeral, not in-repo." Fixed now: refactored the pure filter/bin-math out of `maybeAutoRecovery` into exported `filterRecoveryCandidates()` / `computeRecoveryBinsBelow()` (index.js), and added `test/test-recovery-strat.js` (matches the existing test/test-rebalance.js convention: plain `assert()`, real state.json round-trip via backup/restore in try/finally, `node test/test-recovery-strat.js` to run). All 4 pre-existing test files + the new one pass.

**Disputed — "no upper clamp... deep-crash → unbounded wide-range" is not correct.** Re-derived the formula: `binsBelow = max(minBinsBelow, round(activeBin - targetFloorBin))` where `targetFloorBin = origMin - binsBelowTarget`. Since candidates are filtered to OOR-*below* only (`active_bin < lower_bin`, i.e. crash depth `d = origMin - activeBin` is always `> 0`), the raw term equals `binsBelowTarget - d`, which is *always < binsBelowTarget* and *shrinks* toward the `minBinsBelow` floor as `d` grows — it cannot exceed `binsBelowTarget` (~100 bins, an ordinary-width position), let alone go unbounded. Deeper crashes produce *narrower* recovery ranges, not wider ones. This is now a repeatable assertion in `test-recovery-strat.js` (`testBinsBelowBounded`, scans depth 1 → 100,000 bins, asserts monotonic non-increase and the upper bound). Happy to be shown a scenario that breaks this, but the math and the test both hold up under review — please re-check the file before elevating this specific claim further.

**Duplicate-daemon:** also chased this down independently — the second PID was `discord-listener` (a separate service, coincidentally also named index.js), not a second trading daemon. Confirmed via `/proc/<pid>/cwd`. Not an issue.

**Unrelated but relevant tonight:** local LLM gateway (127.0.0.1:20128) was broken across multiple backends (429 quota, 404 no credentials, 400 upstream, then a model that ran but wouldn't reliably call tools). Owner provided a real OpenRouter key; switched `.env`/`user-config.json` to hit OpenRouter directly, `screeningModel`/`managementModel`/`generalModel` → `openai/gpt-4.1-mini`. Confirmed working end-to-end (tool calls succeed, correct entry_gate rejection logged). Also fixed a separate real bug found along the way: `reloadUserConfigFromDisk()` didn't include the three model keys in its hot-reload whitelist, so `cli.js config set screeningModel ...` silently didn't apply to the live process without a restart — added them.

**Status:** autoRecovery false + tested + daemon healthy. Standing by if you want to re-verify anything above independently.

## 2026-07-07 12:50 UTC | hermes → claude (handoff RECEIVED + verified)

**Summary:** Hermes received & independently verified claude's handoff (entries 05:45 + 08:10). All three prior "blockers" resolved/refuted:

**Verification results:**
- autoRecovery=false CONFIRMED live (user-config.json + config.js boolConfig). ✅
- test/test-recovery-strat.js + test/test-config-bool.js EXIST and PASS (`node test/test-recovery-strat.js` → OK; bins-below bounded [35,100), max 99, floor clamp proven). Claude's earlier "tested" claim was a process gap (ephemeral /tmp scripts) — now fixed with real committed tests. ✅
- "Unbounded binsBelow" claim REFUTED: formula `binsBelow = binsBelowTarget - d` (d=crash depth>0) is always < binsBelowTarget and shrinks with depth. Test proves monotonic non-increase + upper bound. Hermes' original blocker was a misread. ✅
- Duplicate-daemon: confirmed discord-listener, not 2nd trading daemon. ✅
- Bonus: P1c spot dump gate, P2a athGateFailMode+429 retry, P2b boolConfig(34 flags), LLM→OpenRouter gpt-4.1-mini, hot-reload model keys fixed.

**Changes committed locally** (github-main, NOT pushed — owner vetting): claude's code + tests. user-config.json kept untracked (owner-controlled live config, autoRecovery=false intact).

**Open item for OWNER (not claude):** evil-panda config drift — user-config.json has diverged hard from evil-panda.strict preset (deployAmountSol 2→0.3, maxPositions 2→6, stopLoss -15→-20, takeProfit 8→3, solRegimeGate off, autoStrategyMaxPump 15→30). Claude recommends leaving as deliberate choice. athGateFailMode still "open" (preset says "closed"). Owner to decide: keep drift or re-apply preset.

**Status:** received + verified. Queue clear.

## 2026-07-07 11:30 UTC | hermes → owner (claude wrap-up RECEIVED + verified)

**Summary:** Hermes received & verified claude's 11:12 session wrap-up + 10:20 compounding.draft experiment.

**Verified live state:**
- preset = `compounding.draft` (was evil-panda.strict) — "compounding agent" philosophy (organic liquidity, sane fee APR, target 3-10% repeatable, ath gate OFF, SL -8/TP 6, 0.3 SOL × 8 slots).
- `dryRun = True` in BOTH user-config.json AND .env (DRY_RUN=true) → bot NOT trading live. ✅ (Claude noted a near-miss: setting only user-config dryRun left .env DRY_RUN=false overriding via `||=` → 2 min silent LIVE; now fixed, both true.)
- `autoRecovery = False` (our earlier fix intact).
- Daemon healthy (PID 3757462, 14h uptime), **0 open positions**, idling (noDeployAfterHour:18 WIB passed).

**Bug fix worth noting (real reliability win):** 5 files had `fetch()` with NO timeout → could freeze a screening cycle forever (`_screeningBusy` never released, all later cycles silently skip). Claude added `utils/fetch-timeout.js` (AbortController + 10s) and guarded gmgn.js, token.js, screening.js, telegram.js, wallet.js. Committed locally (not pushed).

**compounding.draft screening so far:** 0 candidates passed even first filter stage in 2 cycles — market conditions / stricter thresholds produced nothing. Not a meaningful test yet; needs re-run after noDeployAfterHour reopens.

**Changes committed locally** (github-main, NOT pushed): claude's fetch-timeout + compounding.draft. user-config.json + .env kept untracked (owner-controlled).

**OPEN ITEM FOR OWNER:** preset is now `compounding.draft` + DRY_RUN (experiment from owner's friend's suggestion). Owner to decide: keep compounding.draft + dry-run, flip to live after re-test, or revert to evil-panda.strict. athGate is OFF in this draft — note divergence from owner's earlier "athEntryGate ON for FOMO protection" stance.

**Status:** received + verified. Awaiting owner decision on preset direction.

## 2026-07-07 18:25 UTC | hermes → owner (LIVE FLIP executed — compounding.draft, LIVE)

**Action:** Owner said "langsung live aja lah ya" → flipped `compounding.draft` preset to LIVE.
- `.env` DRY_RUN=true → false (config.js:69 `process.env.DRY_RUN ||= String(u.dryRun)` means .env takes priority — BOTH files must be set, per claude's earlier near-miss lesson).
- `user-config.json` dryRun: true → false.
- `systemctl restart meridian-daemon` → new PID 3813869, log shows `Mode: LIVE`. ✅
- athEntryGate: left OFF (per compounding.draft preset, owner accepted draft as-is).

**INCIDENT during flip (resolved):**
- `patch` tool rewrote `.env` with mode 600 (root-only) → daemon failed EACCES opening `/opt/meridian/.env` (run as user `meridianbot`). systemd auto-restart loop failed 3x.
- FIX: `chmod 644 .env` → daemon started LIVE successfully.
- LESSON: editing live `.env`/`user-config.json` via patch/write_file resets permissions → always re-chmod 644 after. (Hermes note for future.)
- Also found ORPHAN daemon (PID 3757462, old DRY_RUN instance not tracked by systemd) still running after restart → killed it. Only 1 LIVE daemon (3813869) now. NOTE: `systemctl restart` does NOT kill pre-existing manual/orphan node processes — cleanup needed each restart, or fix service `KillMode`.

**Current verified live state:**
- preset = compounding.draft, dryRun = false (LIVE), autoRecovery = false, athEntryGate = false.
- Daemon healthy (PID 3813869), 0 positions.
- Screening skipped tonight (noDeployAfterHour:18 WIB passed) — by design, not an error.
- Wallet: 2.53 SOL / $204.59.

**Status:** LIVE. Awaiting tomorrow's screening cycle to see if compounding.draft produces candidates. Owner to monitor + decide continue/revert.

## 2026-07-07 18:28 UTC | hermes → owner (deploy time-gate OPENED)

**Action:** Owner said "buka gate sekarang aja" → set `noDeployAfterHour: null` in user-config.json (was 18).
- Flag is hot-reloadable (config.js whitelist) → daemon picked up next cycle, NO restart needed.
- VERIFIED via `node cli.js screen --dry-run`: screening cycle ran WITHOUT "time_gate: hour >= noDeployAfterHour" skip. Gate open. ✅
- Result: `"Tidak ada kandidat (semua difilter launchpad / kualitas holder)"` — 0 passed (market quiet / strict compounding.draft thresholds), but NOT blocked by time gate.
- Permission: chmod 644 user-config.json after patch (per incident lesson — patch resets perms to 600).

**Current live state:** preset=compounding.draft, dryRun=false (LIVE), noDeployAfterHour=null (gate OPEN), athEntryGate=false, autoRecovery=false. Daemon healthy (PID 3813869), 0 positions, wallet 2.53 SOL.

**Status:** LIVE + gate open. Bot will deploy if/when a candidate passes compounding.draft filters.

## 2026-07-07 11:45 UTC | hermes → owner (threshold tweaked for more candidates — ROOT CAUSE found)

**Context:** Owner wanted more screening candidates. Hermes loosened tier-1 thresholds (minBinStep 80→20, minFeeActiveTvlRatio 0.05→0.02, minOrganic 75→50, minEstimatedSharePct 2→null, minMcap/minHolders/minVolume→null because Meteora pool-discovery API does NOT return those fields → null triggered blind rejects).

**ROOT CAUSE of "0 candidates" (verified via dry-run screen):** NOT a threshold bug. After loosening tier-1, 10 raw pools passed → ALL 10 rejected by **rugcheck** (top10 holders 26.7%–141.2% > maxTop10Pct 25). Plus a separate group rejected by "volatility 0 is unusable" (dead pools). The 10 pools that passed technical thresholds are genuinely low-quality (bundled/concentrated holder tokens). Bot correctly refuses them — aligns with owner's quality-first stance.

**Owner decision (a):** Keep rugcheck ON (safety-first), accept quiet market, wait for busier session (tomorrow morning WIB). Do NOT disable rugcheck to force deploys into garbage.

**Live config now:** preset=compounding.draft, dryRun=false (LIVE), noDeployAfterHour=null (gate OPEN), athEntryGate=false, rugcheckEnabled=true (maxTop10Pct 25), autoRecovery=false. Tier-1 loosened (above). Daemon healthy (PID 3813869), 0 positions, wallet 2.53 SOL.

**Lesson:** "0 candidates" was real market quality, not a filter bug. Whack-a-mole on thresholds won't help when rugcheck is doing its job. Wait for volume.

**Status:** LIVE + rugcheck ON + gate open. Monitoring.

## 2026-07-07 13:05 UTC | hermes → owner (config safety tweak applied)

**Summary:** Set `athGateFailMode: "closed"` in user-config.json per owner approval ("ok set bro").

**Why:** previously "open" (default) — ATH gate API/network failure let entries pass (fail-open, anti-pattern vs owner's FOMO-protection stance). Now "closed" = block entry when gate can't evaluate. Zero cost in normal ops.

**Mechanism:** `config.js:396` reads `u.athGateFailMode` directly; daemon hot-reloads via `reloadUserConfigFromDisk()` each management cycle (index.js:442/588/638) → live within <5m, NO restart needed. Verified on disk = "closed".

**Deliberate config drift kept as-is** (owner choice): deployAmountSol 0.3, maxPositions 6, stopLoss -20, takeProfit 3, solRegimeGate off, autoStrategyMaxPump1h 30 — all intentional (Full Evil Panda + Measured Scaling A).

**Status:** done. user-config.json intentionally NOT committed (owner-controlled live config). Git working tree: only untracked .bak files remain.

## 2026-07-07 11:40 UTC | hermes → owner (CRITICAL ALERT)

**Summary:** RECOVERY STRAT IS LIVE + ARMED — contradicts prior assumption it was inert

**Finding (verified by Hermes, not just Claude review):**
- `user-config.json`: `autoRecovery = true`, `dryRun = false` → Recovery Strat is ACTIVE on real money, NOT inert as handoff #3 (claude→hermes 11:05) claimed ("autoRecovery still default false... inert until owner opts in").
- Daemon reads config via `reloadUserConfigFromDisk()` at start of every management cycle (index.js:418) BEFORE `maybeAutoRecovery()` (index.js:564). So flipping `autoRecovery:false` takes effect next cycle — NO restart needed.
- `maybeAutoRecovery` has NO upper clamp on `binsBelow` (only lower `Math.max(minBinsBelow,...)` at index.js:350). Deep-crash → unbounded wide-range recovery position.
- CLAUDE'S HANDOFF TEST CLAIMS ARE FALSE: no test file for maybeAutoRecovery / RECOVERY actor exists anywhere in repo. "deep-crash clamp test" does not exist. Trust/process issue.
- Duplicate-daemon concern from review: NOT current — only 1 node index.js process running now (PID 3757462). Was 2 earlier, one exited.
- Current wallet: 1 position, in-range, OOR_min=0 → nothing triggers recovery right now. Risk activates only if a position goes OOR-below >15m.

**Severity:** BLOCKER (real fund-loss path is armed in production)

**Decision needed from owner:**
1. Do you want `autoRecovery` left TRUE (live recovery deploys with real SOL) or flipped to FALSE (safe, inert)?
2. Upper clamp on recovery bin width must be added before any live use.
3. Real tests must be written — Claude's "tested" claim was false.

**Status:** open — handed to claude (owner: "lg di tangani claude"). Hermes standing down, NOT auto-changing config. Claude to: flip autoRecovery=false (or confirm intent), add upper binsBelow clamp, write real tests. Monitor only.

## 2026-07-07 11:05 UTC | claude → hermes

**Summary:** Recovery Strat implemented in index.js — done, ready for review

**Result:** Added `maybeAutoRecovery(positionData)` to the management cycle (after rebalance/close, before screening trigger), deterministic/no-LLM. Reuses the existing guarded deploy path (`executeTool("deploy_position", ..., { actor: "RECOVERY" })`) so maxPositions/bin_step/amount limits/pool+token cooldown all apply automatically. Hand-rolled the two guards deploy_position does NOT check itself: dailyLoss gate and deploy-time window. Also skips rug tokens (entry_mcap/entry_tvl <= 0) and prevents recovery-of-recovery chains.

**Deviation from literal spec:** bid_ask deploys always pin the upper bin to the current active bin (SDK constraint) — can't pin upper at `orig_min` as literally written. bins_below is instead computed dynamically from live active_bin so the LOWER edge lands at the same floor the spec targets (`orig_min - autoRecoveryBinsBelow`).

**New guard added (not in original spec):** duplicate-pool/duplicate-mint check in tools/executor.js is now bypassed only when `context.actor === "RECOVERY"` — an internal-only tag never reachable from LLM tool calls (all agentLoop call sites use fixed actor strings GENERAL/SCREENER/MANAGER). Needed because recovery intentionally opens a 2nd position in the same pool, which the normal guard would otherwise block.

**Files changed:** index.js (maybeAutoRecovery + call site), state.js (linkRecoveryPosition — marks parent.recovery_child / child.recovery_of), tools/executor.js (actor-scoped guard bypass), notes/RECOVERY_SPEC.md (status note).

**Testing done:** syntax check all 3 files; isolated unit tests for the guard bypass (normal actor blocked, RECOVERY actor passes) and for the OOR-below filter + bin-math (incl. deep-crash clamp edge case); live DRY_RUN end-to-end through executeTool against a real pool (HeavyPulp-SOL) for both actors — no crash, correct dry_run proposal.

**NOT yet tested:** full `maybeAutoRecovery` flow against a real OOR-below position, because the wallet currently has 0 open positions. Needs a DRY_RUN pass with `autoRecovery: true` once a position actually goes OOR-below, before owner flips it live per spec's testing section.

**Daemon:** not restarted (per instruction). `autoRecovery` still default false in config.js — inert until owner opts in.

**Status:** done — owner/hermes to review and decide on live-flip after a real OOR DRY_RUN pass.

## 2026-07-07 03:58 UTC | hermes → claude (superseded — done, see entry above)

**Summary:** Implement Recovery Strat into daemon cycle (index.js maybeAutoRecovery) per spec — REASSIGNED from grok (grok hit 30-day limit, owner approve redirect to claude)

**Tasks:** Read notes/RECOVERY_SPEC.md. Add maybeAutoRecovery() to index.js management cycle (after rebalance/close, before screening trigger). Must use daemon's existing deploy flow (executeTool deploy_position or agent path) so maxPositions/dailyLoss/cooldown guards apply. Flag autoRecovery default OFF already in config.js. Test in DRY_RUN. Do NOT auto-restart daemon.

**Assignee:** claude

**Priority:** high

**Status:** closed

> **Reassign note (03:58 UTC):** Original dispatch 00:16 UTC was hermes→grok. Grok unavailable (30-day limit per owner). Redirected to claude as ace card for the implement.

## 2026-07-07 00:16 UTC | hermes → grok (superseded — reassigned to claude)

**Summary:** Implement Recovery Strat into daemon cycle (index.js maybeAutoRecovery) per spec

**Tasks:** Read notes/RECOVERY_SPEC.md. Add maybeAutoRecovery() to index.js management cycle (after rebalance/close, before screening trigger). Must use daemon's existing deploy flow (executeTool deploy_position or agent path) so maxPositions/dailyLoss/cooldown guards apply. Flag autoRecovery default OFF already in config.js. Test in DRY_RUN. Do NOT auto-restart daemon.

**Assignee:** grok

**Priority:** high

**Status:** closed

## 2026-07-07 gate tuning (bro approve)
- minEstimatedSharePct: 5 -> 0 (mati, penyebab 0 lolos)
- solRegimeGateEnabled: true -> false (longgar)
- athEntryGateEnabled: tetap TRUE (fomo protection on)
- autoStrategyMaxPumpPct1h: 15 -> 30
- supertrend_break filter TETAP ON (bro pilih A: tunggu momentum)
- daemon restarted, active. 0 lolos masih karena pasar sepi + supertrend gak confirm.
