# HANDOFF → Claude: Meridian Solana R:R redesign + preset clean (A1)

**Date:** 2026-07-26  
**From:** Hermes (CLI, owner session)  
**To:** Claude Code (engineering)  
**Owner:** garda97 / dikagarda97  
**Job id (optional):** meridian-rr-v1-a1  
**Priority:** P0 strategy — **NOT** live deploy

---

## 0. One-line mission

Redesign Meridian Solana **risk:reward + one clean preset**, sync docs, leave system in **dryRun=true** and **daemon still OFF**. Do **not** start trading.

---

## 1. Why this job exists

Owner chose option **A** (redesign R:R + preset clean) after Hermes deep-dive.

Facts already verified by Hermes (2026-07-26):

| Fact | Value |
|------|--------|
| Install path | `/opt/meridian` (fork garda97/meridian-live, ~295M) |
| Secrets/data | `/root/.meridian/` (Helius keys, etc.) |
| Wallet | `Dats8FtZFPBTdeYMoBFkXDbLkaccAx8yUU9GESofDZjZ` · **0.0 SOL** |
| meridian-daemon | **inactive + disabled** |
| meridian-discord / watch-wallets | **inactive** (stopped ~2026-07-25) |
| dashboard / health-watchdog / metlex | inactive |
| user-config preset | `compounding.draft` (applied 2026-07-07; previous `evil-panda.strict`) |
| dryRun in user-config | **false** (dangerous if daemon started) |
| deployAmountSol / maxPositions | 0.5 / 1 |
| TP / SL / maxLoss | **+4% / -8% / -12%** ← core problem |
| athEntryGateEnabled | **false** (docs say should be ON) |
| solRegimeGateEnabled | true (−3%/1h) |
| copyTrade | OFF |
| sprayModeEnabled | true (0.05 SOL) ← turn OFF in redesign |
| strategy default | bid_ask + autoStrategy ON |
| closedOutcomes sample | **19 closes · ~8W/11L · avg ≈ −1.36%** |
| notes/CURRENT.md | Still “Evil Panda strict live 2026-07-04” → **docs drift** |
| LLM | `http://127.0.0.1:20128/v1` model `Meridian` (local 9router) |
| RPC | Helius pump endpoint in user-config |

Hermes full analysis (human-readable): chat 2026-07-26 “deep dive Meridian Solana”.

---

## 2. Scope (IN)

1. **Backup** before any write (see §5).
2. **Audit** `state.json` closedOutcomes + relevant `lessons.json` / decision-log — quantify *why* expectancy negative (shape, exit reason, OOR vs SL vs TP, age, fee if available).
3. **Design R:R** with coherent numbers (proposal baseline in §6 — adjust if audit demands).
4. **Create new preset** e.g. `presets/garda-rr-v1.json` (or `compounding.strict.json` if naming better fits repo).
5. **Apply preset** to `user-config.json` via existing `scripts/apply-preset.js` if possible; else careful merge.
6. **Force safety:**
   - `dryRun: true`
   - daemon remains **stopped/disabled**
   - `sprayModeEnabled: false`
   - `copyTrade.enabled: false`
   - `filterAutotuneEnabled: false`
   - `autoRecovery: false`
   - `athEntryGateEnabled: true`
   - keep `maxPositions: 1`, `deployAmountSol: 0.5` (do **not** increase size)
7. **Sync docs:** rewrite `notes/CURRENT.md` to match live config; short note in `notes/BRIDGE.md` / handoff queue that Evil Panda phase is obsolete for this job.
8. **Verify** config dump + optional **one** `screen --dry-run` / CLI dry path if cheap on RPC/LLM — no mainnet spend.
9. **Write completion report** to:
   - `/root/shared-telegram/REPORT_CLAUDE_MERIDIAN_RR_V1.md`
   - and `/opt/meridian/notes/RR_V1_REDESIGN.md`

---

## 3. Scope (OUT) — hard no

- `systemctl start` meridian-daemon / discord / watch-wallets / dashboard (unless owner later says so in a new handoff)
- Raise `deployAmountSol` above 0.5 or maxPositions > 1
- Enable copyTrade
- Live deploy / close / swap with real SOL
- Wallet key rotation or `.env` secret rewrite (except dryRun/safety knobs via user-config)
- “Optimize” 50 unrelated knobs
- Work on `/opt/meridian-rh` (Robinhood) — **wrong tree**
- Commit/push git without explicit owner OK (prepare commit message only)

---

## 4. Key paths

```
/opt/meridian/                    # code + runtime config
/opt/meridian/user-config.json    # LIVE knobs (edit carefully)
/opt/meridian/config.js           # defaults
/opt/meridian/state.json          # positions + closedOutcomes
/opt/meridian/lessons.json
/opt/meridian/decision-log.json
/opt/meridian/strategy-library.json
/opt/meridian/presets/            # evil-panda.strict.json, compounding.draft.json
/opt/meridian/scripts/apply-preset.js
/opt/meridian/notes/CURRENT.md    # DRIFT — fix
/opt/meridian/notes/BRIDGE.md
/opt/meridian/notes/HANDOFF.md
/opt/meridian/CLAUDE.md           # engineering manual
/opt/meridian/cli.js
/root/.meridian/                  # helius keys, skill notes — do not leak keys in report
/root/shared-telegram/            # this handoff + your report
```

Service units (all should stay inactive for this job):

```
meridian-daemon.service
meridian-discord.service
meridian-watch-wallets.service
meridian-dashboard.service
meridian-health-watchdog.service
meridian-metlex.service
```

User: `meridianbot` owns most of `/opt/meridian`. Prefer `sudo -u meridianbot` for node CLI if perms require. Some logs historically root-owned → fix ownership only if you touch logs.

---

## 5. Backup commands (do first)

```bash
TS=$(date +%Y%m%d_%H%M%S)
BK=/root/shared-telegram/backups/meridian-rr-v1-$TS
mkdir -p "$BK"
cp -a /opt/meridian/user-config.json "$BK/"
cp -a /opt/meridian/state.json "$BK/" 2>/dev/null || true
cp -a /opt/meridian/notes/CURRENT.md "$BK/" 2>/dev/null || true
cp -a /opt/meridian/presets "$BK/presets" 2>/dev/null || true
# confirm daemon still off
systemctl is-active meridian-daemon meridian-discord meridian-watch-wallets
echo "backup=$BK"
```

---

## 6. Baseline R:R proposal (starting point — not dogma)

Hermes recommendation before audit. **Change if closed-trade audit says otherwise.**

| Knob | Current | Target band |
|------|---------|-------------|
| takeProfitPct | 4 | **6–8** |
| stopLossPct | -8 | **-5 to -6** |
| maxLossPct | -12 | **-8 to -10** |
| trailingTriggerPct | 2 | **3** |
| trailingDropPct | 1 | 1 |
| minAgeBeforeTakeProfit | 10 | **15–20** |
| outOfRangeWaitMinutes | 10 | **15** (or keep 10 if fee-exit logic stronger) |
| athEntryGateEnabled | false | **true** |
| solRegimeGateEnabled | true | true |
| sprayModeEnabled | true | **false** |
| dailyLossLimitUsd | 28 | **15–20** |
| dryRun | false | **true** |
| deployAmountSol | 0.5 | 0.5 |
| maxPositions | 1 | 1 |
| bidAsk young downside 90% | aggressive | consider **70–75** if losses are wide OOR |
| minBinsBelow | 70 | 70–90 after audit |
| autoStrategy | ON | ON; prefer spot high-fee if bid_ask bleeding |

Math intent: stop requiring >66% WR just to break even on 4/-8.

Also set clearly in CURRENT.md:

```
min SOL to resume live later: ≥ 0.8–1.0 SOL (0.5 deploy + 0.3 gas + buffer)
```

---

## 7. Suggested work order

1. Backup (§5)
2. Read: `CLAUDE.md`, `notes/CURRENT.md`, `user-config.json`, `presets/*.json`, `scripts/apply-preset.js`
3. Audit closed outcomes → short markdown table (exit class × shape × avg pnl)
4. Write `presets/garda-rr-v1.json`
5. Dry-run apply: `node scripts/apply-preset.js garda-rr-v1 --dry-run` (if flag exists; else print planned diff)
6. Apply for real; force `dryRun: true` even if preset forgets it
7. Rewrite `notes/CURRENT.md` (phase `garda-rr-v1`, dry-run, daemon OFF)
8. Append task done to `notes/HANDOFF.md` / BRIDGE pending clear for this item
9. Verify:
   ```bash
   systemctl is-active meridian-daemon   # must be inactive
   # dump critical knobs without secrets
   node -e 'const u=require("/opt/meridian/user-config.json");
   console.log({
     dryRun:u.dryRun,
     tp:u.takeProfitPct, sl:u.stopLossPct, maxLoss:u.maxLossPct,
     ath:u.athEntryGateEnabled, spray:u.sprayModeEnabled,
     deploy:u.deployAmountSol, maxPos:u.maxPositions,
     preset:u._presetApplied||u.preset
   })'
   ```
10. Optional: one dry screen if safe (no spend)
11. Report files (§2.9)

---

## 8. Definition of done

- [ ] Backup exists under `/root/shared-telegram/backups/meridian-rr-v1-*`
- [ ] New preset file committed **to disk** (git commit optional)
- [ ] `user-config.json` reflects new R:R + dryRun true + ATH on + spray off
- [ ] `notes/CURRENT.md` no longer claims Evil Panda live as current phase
- [ ] No meridian systemd unit newly started
- [ ] Report with before/after table + audit summary + residual risks
- [ ] Explicit “NOT live — needs owner topup + dry-run cycles + start command”

---

## 9. Owner language / style

- Indonesian informal OK in report summary for owner
- Tech terms English OK
- No JP/anime fluff
- Tables with clear numbers
- Be decisive: pick numbers, document why

---

## 10. How owner / Hermes will dispatch you

**Option A — Claude Code CLI (preferred if available on VPS):**
```bash
cd /opt/meridian
claude -p "$(cat /root/shared-telegram/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md)"
# or interactive:
claude
# then: baca dan kerjakan /root/shared-telegram/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md
```

**Option B — Claude Telegram bridge** (`claude-telegram.service`):  
Owner pastes:  
`Baca HANDOFF /root/shared-telegram/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md dan gas A1. Daemon tetap OFF.`

**Option C — Claude session already open on VPS:**  
`Read and execute /root/shared-telegram/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md end-to-end.`

Also mirrored for Meridian notes:

```
/opt/meridian/notes/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md
```

---

## 11. Residual risks Claude should mention in report

- Sample size 19 closes = weak stats; redesign is hypothesis not proven edge
- dryRun false today = footgun if someone starts daemon by habit
- 0 SOL wallet = cannot validate live fill quality
- LLM screening still stochastic even with better R:R
- Helius/RPC flakiness can bias dry-run results

---

## 12. Hermes contact

If blocked (perms, apply-preset bug, missing schema): leave note in  
`/root/shared-telegram/REPORT_CLAUDE_MERIDIAN_RR_V1.md` with exact error + path.  
Do not invent SOL topup or start services.

**Handoff complete. Claude owns A1 until report lands.**
