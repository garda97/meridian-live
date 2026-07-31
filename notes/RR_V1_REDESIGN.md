# RR_V1 REDESIGN — Meridian Solana risk:reward audit + rationale

**Job:** `meridian-rr-v1-a1` (handoff `/root/shared-telegram/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md`)
**Date:** 2026-07-26 · **Phase:** `garda-rr-v1` — **evaluation / dry-run, NOT live**
**Preset:** `presets/garda-rr-v1.json` (applied `2026-07-26T05:32:55Z`, previous `compounding.draft`)
**Backup:** `/root/shared-telegram/backups/meridian-rr-v1-20260726_132500/`

> **Read this first:** §J documents a **P0 defect** — `dryRun: true` in `user-config.json` is
> currently **inert**. `.env` sets `DRY_RUN=false` and wins. Do not start the daemon until §J is fixed.

---

## Executive summary (ID)

Ekspektansi negatif Meridian **bukan** karena band TP/SL-nya kekecilan. Dari **162 close**:

- **7 trade (4.3%)** menyumbang **−255.11%**.
- **155 trade sisanya** menyumbang **+40.22%** → rata-rata **+0.259%/trade** (positif).
- TP cuma fired **4×** dan SL **3×** dari 162 close (**4.3%** dari semua exit) — jadi mengutak-atik
  angka TP/SL saja secara statistik hampir tidak menyentuh mayoritas trade.

Artinya masalahnya **tail risk / kualitas entry**, bukan exit band. Makanya redesign ini:

1. **Suppress tail** — perketat entry gate (TVL, top10, bot, bundler, umur token, fee, pump) + ATH gate ON.
2. **Geser exit mix** ke kelas exit yang memang menghasilkan — `TRAILING_TP` (+2.32%) dan
   `CHART_EXIT` (+0.55%) — dan jauhi churn fee-nol (`OOR_TIMEOUT` −0.070%, fee $0.004).
3. **Naikkan konsentrasi bin** — ini lever fee terbesar yang ketemu (bin sempit = **35× fee capture**).
4. **Matikan self-modification** (darwin/autotune/autoRecovery) selama window evaluasi.

Sample n=162 dalam 17 hari = **kecil dan satu rezim pasar**. Ini **hipotesis**, bukan edge terbukti.

---

## Method & definitions

| Term | Definition |
|---|---|
| Source | `lessons.json` → `performance[]`, n=162, 2026-07-02..07-18. Cross-check `state.json.closedOutcomes` n=19 (§I). |
| **Tail** | `pnl_pct <= -9%`. Chosen from a natural break in the loss distribution: losses run −12.28%, **−9.50%**, then jump to −1.99% — a 7.5pp gap. It is also exactly the new `maxLossPct` backstop, so "tail" reads as *"a loss the breakers should have caught."* |
| **ex-tail** | Same cohort with tails removed. Separates *"is the strategy sound?"* from *"did we get rugged?"* |
| Exit class | Derived from `close_reason` prefix (8 classes, all 162 records classified, no `OTHER`). |
| Reproduce | `python3 scripts/rr_v1_audit.py` (committed alongside this doc). |

---

## A. Book-level baseline

Source: `lessons.json` -> `performance[]`, n=162 closes, 2026-07-02 .. 2026-07-18.

| Metric | Value |
|---|---:|
| Closes | 162 |
| Wins / Losses | 83 / 79 |
| Win rate | 51.2% |
| Sum PnL | -214.89% |
| Mean PnL / trade | -1.326% |
| Median PnL / trade | +0.010% |
| Worst / Best | -83.40% / +5.48% |
| Tail losses (<= -9%) | 7 (4.3% of book) |
| Sum PnL **ex-tail** | +40.22% |
| Mean PnL **ex-tail** | +0.259% |
| Avg fees earned / trade | $0.127 |
| Avg hold | 37 min |

**The whole expectancy hole is 7 trades.** They sum -255.11%; the other 155 sum +40.22%.

## B. Exit class x PnL

| Exit class | n | % of book | Win% | Mean PnL | Median | Mean **ex-tail** | Tails | Avg fees $ | Avg hold m | Avg in-range m |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| LOW_YIELD | 51 | 31.5% | 51% | -1.625% | +0.030% | +0.011% | 1 | 0.015 | 49 | 49 |
| CHART_EXIT | 26 | 16.0% | 73% | -0.457% | +0.475% | +0.547% | 1 | 0.284 | 37 | 37 |
| OOR_TIMEOUT | 25 | 15.4% | 24% | -2.363% | -0.050% | -0.070% | 1 | 0.004 | 17 | 5 |
| PUMPED_ABOVE | 22 | 13.6% | 55% | -1.375% | +0.015% | +0.146% | 1 | 0.043 | 16 | 12 |
| AGENT_DECISION | 22 | 13.6% | 45% | -1.485% | +0.000% | +0.047% | 1 | 0.036 | 25 | 25 |
| TRAILING_TP | 9 | 5.6% | 78% | +2.318% | +2.370% | +2.318% | 0 | 0.692 | 85 | 85 |
| TAKE_PROFIT | 4 | 2.5% | 50% | +0.558% | +0.050% | +0.558% | 0 | 0.221 | 44 | 44 |
| STOP_LOSS | 3 | 1.9% | 33% | -7.077% | -9.500% | +0.550% | 2 | 1.137 | 83 | 83 |

## C. Exit class x shape (strategy)

| Exit class | bid_ask n / mean / ex-tail | spot n / mean / ex-tail | curve n / mean / ex-tail |
|---|---|---|---|
| LOW_YIELD | 43 / -0.02% / -0.02% | 7 / -11.59% / +0.37% | 1 / -0.66% / -0.66% |
| CHART_EXIT | 18 / -1.08% / +0.36% | 7 / +0.96% / +0.96% | 1 / +0.87% / +0.87% |
| OOR_TIMEOUT | 25 / -2.36% / -0.07% | — | — |
| PUMPED_ABOVE | 20 / -1.64% / +0.03% | 2 / +1.25% / +1.25% | — |
| AGENT_DECISION | 17 / -1.90% / +0.09% | 3 / -0.15% / -0.15% | 2 / +0.01% / +0.01% |
| TRAILING_TP | 3 / +1.79% / +1.79% | 6 / +2.58% / +2.58% | — |
| TAKE_PROFIT | 3 / -0.63% / -0.63% | 1 / +4.12% / +4.12% | — |
| STOP_LOSS | — | 3 / -7.08% / +0.55% | — |

Strategy totals:

| Strategy | n | Win% | Mean | Mean ex-tail | Tails | Tail rate | Avg fees $ | Avg bins_above |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| bid_ask | 129 | 48% | -1.093% | +0.071% | 4 | 3.1% | 0.014 | 20 |
| spot | 29 | 66% | -2.554% | +1.197% | 3 | 10.3% | 0.644 | 36 |
| curve | 4 | 50% | +0.055% | +0.055% | 0 | 0.0% | 0.026 | 51 |

## D. Range shape: bins_above (upside cover)

| bins_above | n | Win% | Mean | Mean ex-tail | Avg fees $ | OOR-class share* | Avg range-eff |
|---|--:|--:|--:|--:|--:|--:|--:|
| 0 (single-sided) | 91 | 46% | -1.630% | +0.018% | 0.013 | 49% | 61% |
| 1-30 | 14 | 64% | -5.304% | +1.554% | 0.725 | 7% | 100% |
| >30 | 57 | 56% | +0.135% | +0.357% | 0.162 | 2% | 100% |

\* OOR-class share = closed via `OOR_TIMEOUT` or `PUMPED_ABOVE` (price left the range).

## E. Range shape: bins_below (fee concentration)

| bins_below | n | Win% | Mean | Mean ex-tail | Avg fees $ | Avg hold m | Avg range-eff |
|---|--:|--:|--:|--:|--:|--:|--:|
| <70 (tight) | 30 | 53% | -0.117% | +0.652% | 0.488 | 50 | 93% |
| 70-140 | 49 | 55% | -1.990% | +0.244% | 0.097 | 31 | 72% |
| >140 (smeared) | 83 | 48% | -1.372% | +0.131% | 0.014 | 36 | 75% |

## F. Hold-time bucket

| Hold | n | Win% | Mean | Median | Mean ex-tail | Tails | Avg fees $ |
|---|--:|--:|--:|--:|--:|--:|--:|
| <15 min | 47 | 40% | -2.439% | +0.000% | +0.037% | 3 | 0.008 |
| 15-30 min | 26 | 46% | +0.136% | +0.000% | +0.136% | 0 | 0.037 |
| 30-60 min | 57 | 58% | -2.048% | +0.050% | +0.181% | 3 | 0.128 |
| 60-90 min | 23 | 52% | +0.131% | +0.058% | +0.131% | 0 | 0.069 |
| >=90 min | 9 | 78% | +1.107% | +3.680% | +2.780% | 1 | 1.150 |

## G. Tail losses (the actual problem)

| # | Pool | Strategy | PnL | Hold m | In-range m | bins below/above | Exit class | Entry TVL $ | Fees $ |
|--:|---|---|--:|--:|--:|---|---|--:|--:|
| 1 | maxxing-SOL | spot | -83.40% | 45 | 45 | 83/27 | LOW_YIELD | 23,689 | 0.000 |
| 2 | unc-SOL | bid_ask | -57.41% | 6 | 4 | 200/0 | OOR_TIMEOUT | 25,791 | 0.000 |
| 3 | yep-SOL | bid_ask | -33.65% | 40 | 40 | 209/0 | AGENT_DECISION | 0 | 0.144 |
| 4 | Trump Coin-SOL | bid_ask | -33.32% | 2 | 1 | 200/0 | PUMPED_ABOVE | 16,487 | 0.000 |
| 5 | SOLdiers-SOL | bid_ask | -25.55% | 0 | 0 | 140/0 | CHART_EXIT | 10,012 | 0.000 |
| 6 | FABLE-SOL | spot | -12.28% | 137 | 137 | 55/55 | STOP_LOSS | 24,115 | 2.218 |
| 7 | SEMAN-SOL | spot | -9.50% | 38 | 38 | 48/16 | STOP_LOSS | 40,287 | 1.143 |

Of 7 tails, **3 closed within 10 minutes** — these are entry-quality failures (dump/rug), not exit-rule failures. No stop-loss setting saves a -57% move in 0 minutes.

| Tail entry-gate signal | Tail cohort | Book |
|---|--:|--:|
| Median fee/TVL ratio | 0.921 | 0.628 |
| Avg entry TVL $ | 20,054 | 47,400 |
| Avg entry holders | 4,771 | 6,967 |
| Avg organic score | 66 | 71 |
| Avg volatility | 2.93 | 3.19 |
| Avg minutes held | 38 | 37 |
| Avg fees earned $ | 0.501 | 0.127 |

## H. Data-quality caveats found during the audit

- `pnl_pct` vs recomputed `(final-initial)/initial`: **13/162** records disagree by >1pp. PnL fields are not fully trustworthy; treat all means as directional.
- **17/162 (10%)** closes earned **exactly $0.00 fees** — pure churn, no LP income at all.
- `state.json.closedOutcomes` (n=19) contains obviously corrupt values, e.g. `"Trailing TP: peak 7507.25%"` — percentage fields there are computed off a different base. Used only for cross-check, not for the numbers above.
- Position size varied 0.13/0.16/0.17/0.19/0.2/0.3... SOL across the sample, so PnL% is comparable but USD is not.
- n=162 is a small, single-regime sample (17 days). Everything here is a **hypothesis**, not a proven edge.

## I. Cross-check: `state.json.closedOutcomes` (n=19)

| Exit class | n | Wins | Mean PnL (sane rows) |
|---|--:|--:|--:|
| LOW_YIELD | 6 | 3 | -0.18% |
| OOR_TIMEOUT | 5 | 1 | -0.13% |
| CHART_EXIT | 4 | 3 | -6.02% |
| TRAILING_TP | 1 | 0 | -0.11% |
| PUMPED_ABOVE | 1 | 0 | -0.02% |
| OTHER:rebalance failed after withdra | 1 | 0 | +0.00% |
| AGENT_DECISION | 1 | 1 | +0.06% |

Sane subset: n=19, wins=8, mean -1.36%. Direction agrees with the lessons.json book (negative expectancy, driven by a small number of large losses).


---

## J. P0 DEFECT — `dryRun: true` is currently INERT

**Severity: P0.** The single most important finding of this job. The handoff's core safety
requirement ("Force safety: `dryRun: true`") is **satisfied in `user-config.json` but not in effect.**

### Mechanism

```
/opt/meridian/.env            DRY_RUN=false
                                   |
envcrypt.js:127  dotenv.config({ override: true })   -> process.env.DRY_RUN = "false"
                                   |
config.js:69     process.env.DRY_RUN ||= String(u.dryRun)
                 //  "false" is a non-empty STRING  ->  TRUTHY in JS
                 //  ||= therefore NEVER fires; user-config is discarded
                                   v
                 EFFECTIVE MODE = LIVE
```

### Proof (executed 2026-07-26, no secrets read)

```
after envcrypt (.env loaded) : DRY_RUN = "false"
after config.js (user-config): DRY_RUN = "false"
user-config.json dryRun      : true
>>> EFFECTIVE MODE: *** LIVE *** (user-config dryRun IGNORED)
```

`envcrypt.js:119-128` is explicitly one-directional by design — an *explicit* `DRY_RUN=true`
in the caller environment is preserved and never downgraded. That guard is what makes
`node cli.js screen --dry-run` genuinely safe (cli.js:14 sets it before any tool import).
But it only protects the **env-var** path. It does **nothing** for the `user-config.json` path,
which is the path the handoff, the preset, and `CURRENT.md` all rely on.

### Why nothing has blown up yet — two ACCIDENTAL interlocks

| Interlock | State | Reliability |
|---|---|---|
| Wallet balance | **0.0 SOL** | Disappears the moment the owner tops up |
| `.env` perms vs service user | `.env` is `root:root 0600`; `meridian-daemon.service` runs `User=meridianbot` → daemon crashes `EACCES` at `envcrypt.js:20` before it can trade | Disappears if anyone "fixes" the permissions |

Neither is a designed safety control. Both are accidents. **The system is one `chown` plus one
topup away from live-trading a config that was never reviewed for live.**

### Owner fix (one line, not applied — out of handoff scope, owner decision)

```bash
cp -a /opt/meridian/.env /root/shared-telegram/backups/env-$(date +%Y%m%d_%H%M%S).bak
sed -i 's/^DRY_RUN=false/DRY_RUN=true/' /opt/meridian/.env
# re-verify:
cd /opt/meridian && node --input-type=module -e '
await import("/opt/meridian/envcrypt.js"); await import("/opt/meridian/config.js");
console.log("EFFECTIVE DRY_RUN =", process.env.DRY_RUN);'
```

### Recommended root-cause patch (code change — needs owner OK)

`config.js:69` should let user-config force dry-run *on*, while never letting it force live:

```js
// dry-run wins in both directions; live never sneaks in
if (u.dryRun === true) process.env.DRY_RUN = "true";
else process.env.DRY_RUN ||= String(u.dryRun);
```

---

## K. Knob-by-knob rationale (before → after)

Every row traces to a table above. "Evidence" cites the section.

### Exit / R:R band

| Knob | Before | After | Evidence | Rationale |
|---|--:|--:|---|---|
| `takeProfitPct` | 4 | **7** | §B, §F | Counter-intuitive but data-driven. TP fired only **4/162** because trailing (arms at +2%) harvests winners first. The `>=90min` bucket has median **+3.68%** / ex-tail **+2.78%** — the 4% cap was clipping the only bucket that pays. TP is now a **spike cap**, not the primary harvest. |
| `stopLossPct` | −8 | **−6** | §A, §G | Median absolute move is ~0.01%, so −6% is ~600× typical noise — it will not fire on bin oscillation. The 2 SL fires closed at −12.28% / −9.50% under an older **−20%** SL, i.e. the emergency backstop was doing the stop's job. |
| `maxLossPct` | −12 | **−9** | §G | Kept ~1.5× the stop so rule 0 only matters when rule 1 is bypassed. |
| `trailingTriggerPct` | 2 | **2 (KEPT)** | §B | **Deliberate deviation from the handoff's suggested 3.** `TRAILING_TP` is the single best exit class: n=9, mean **+2.32%**, **78% win rate**, 85min avg hold, **$0.692** avg fees ≈ **5.5× the book average**. Arming early is *what creates that class*. With a median trade of ~0.00%, a trigger of 3 would rarely arm it at all. |
| `trailingDropPct` | 1 | **1.5** | §F | The `>=90min` bucket shows we were cutting winners early. Costs ~0.5% extra giveback per trailing exit — cheap for the runner it preserves. |
| `minAgeBeforeTakeProfit` | 10 | **15** | §F, §H | `<15min` is the worst bucket (mean **−2.44%**, 40% WR, 3 of 7 tails) and first-tick PnL is unreliable (§H). Don't book phantom profit. |
| `outOfRangeWaitMinutes` | 10 | **15** | §B | `OOR_TIMEOUT` is the **only exit class negative ex-tail** (−0.070%), 24% WR over 25 closes, at **$0.004** avg fees — near-pure churn. Give price a chance to re-enter. |
| `rebalanceMinOorMinutes` | 20 | **10** | §B | **Was dead config.** Rebalance at 20m could never fire ahead of a 10m OOR close. Now a rebalance is *attempted* before the 15m close. **This is the one genuine hypothesis knob** — the rebalance path has a known failure mode (`rebalance failed after withdraw`, seen once in §I). **WATCH IN DRY-RUN.** |

### Range shape

| Knob | Before | After | Evidence | Rationale |
|---|--:|--:|---|---|
| `strategy` base | bid_ask | **spot** | §C, §D | **91/162 closes had `bins_above=0`**; 49% of those exited OOR/pumped-above at **$0.013** avg fees, mean −1.63%. With `bins_above>30`: OOR only **2%**, **12×** the fees, ex-tail **+0.357%**. Per `notes/HANDOFF.md` a single-sided SOL `bid_ask` is **hard-constrained by the SDK to `bins_above=0`** (deploy.js throws otherwise) — so `spot` is the only config lever that buys upside cover. `autoStrategy` stays ON and can still route to bid_ask/curve. |
| — | — | ⚠ | §C | **spot carries a higher tail RATE than bid_ask (3/29 = 10.3% vs 4/129 = 3.1%).** That is precisely why the entry gates below are tightened *at the same time*. **Do not adopt the spot bias without the gates.** |
| `maxBinsBelow` / `autoStrategyMaxBins` | 166 | **140** | §E | **Biggest fee lever found.** bins_below `<70` → ex-tail **+0.652%** and **$0.488** avg fees; `70-140` → +0.244% / $0.097; `>140` → +0.131% / **$0.014** (**35× less fee capture**). |
| `defaultBinsBelow` | 110 | **90** | §E | Same. Also lifts avg range-efficiency (93% tight vs 75% smeared). |
| `minBinsBelow` | 70 | **70 (kept)** | handoff | Downside-safety floor per handoff (hard floor `MIN_SAFE_BINS_BELOW=35` in config.js). |
| `bidAskDownsidePctYoung` | 90 | **72** | §D | Handoff band 70–75. Does **not** create bins above (SDK constraint) — it concentrates the below-range so fee density near the active bin is higher instead of smeared across a 90% price drop. |
| `bidAskDownsidePctMature` | 65 | **60** | §D | Same. |

### Entry gates — tail suppression

All implicated in the 7 tails (§G). Tail cohort vs book: entry TVL **$20,054 vs $47,400**,
holders **4,771 vs 6,967**, organic score **66 vs 71**.

| Knob | Before | After |
|---|--:|--:|
| `athEntryGateEnabled` | false | **true** (handoff requirement) |
| `minTvl` | 6,000 | **20,000** |
| `maxTop10Pct` | 50 | **32** |
| `rugcheckTop10MaxPct` | 100 *(= effectively disabled)* | **35** |
| `maxBotHoldersPct` | 35 | **25** |
| `maxBundlerTop100Pct` | 25 | **20** |
| `minTokenAgeHours` | 4 | **12** |
| `minTokenFeesSol` | 8 | **12** |
| `autoStrategyMaxPumpPct1h` | 15 | **12** |
| `autoStrategyMaxOorRisk` | 50 | **40** |
| `security.concentrationParadoxOverrideEnabled` | true | **false** |

> `concentrationParadoxOverrideEnabled` lets smart-money presence override concentration limits.
> While we are explicitly tightening `maxTop10Pct` to suppress concentration-driven rugs,
> leaving that override on would undercut the entire change.

### Breakers & evaluation hygiene

| Knob | Before | After | Rationale |
|---|--:|--:|---|
| `severeLossPct` | 10 | **8** | 72h cooldown + 50% size cap now engage just past the new −6% stop / −9% backstop band, instead of well beyond it. |
| `lossRedeployCooldownHours` | 8 | **12** | Slower re-entry after a severe loss. |
| `dailyLossLimitUsd` | 28 | **18** | Handoff band 15–20. At ~$75/SOL a 0.5 SOL position ≈ $37, so a −6% stop ≈ −$2.2 → ~8 stops before the day halts. |
| `sprayModeEnabled` | true | **false** | Handoff requirement. |
| `darwinEnabled` | true | **false** | Signal weights re-evolving every 5 closes would confound evaluation of this preset. |
| `filterAutotuneEnabled` / `autoRecovery` | — | **false** | No self-modification during the evaluation window. |
| `copyTrade.enabled` | false | **false** | Handoff: hard no. |
| `deployAmountSol` / `maxDeployAmount` / `maxPositions` | 0.5 / 0.5 / 1 | **unchanged** | Handoff forbids raising size. Do **not** scale up before real dry-run evidence. |

### Deliberately NOT changed

| Knob | Value | Why |
|---|--:|---|
| `minAgeBeforeYieldCheck` | 60 | `LOW_YIELD` is the largest exit class (51) but is expectancy-**neutral** ex-tail (+0.011%) — it is correctly culling dead pools and recycling the single position slot. **Also: `daemon/engine/close-rules.js` rule 5 HARDCODES the age gate to `>= 60` and ignores this key**, so changing it would silently do nothing (see §L). |
| `minFeePerTvl24h` | 2.5 | Same reasoning. |
| `minFeeActiveTvlRatio` | 0.1 | Tightening risks starving the screener to zero candidates. Revisit after dry-run candidate flow is confirmed. |
| `partialTpEnabled` | false | A $37 position leaves dust. |
| `noDeployAfterHour` | null | No time-of-day signal in the data. |

---

## L. Follow-ups / known issues

| # | Issue | Action |
|--:|---|---|
| 1 | **§J — `dryRun` inert.** `.env DRY_RUN=false` beats user-config. | **P0.** Owner applies the one-line `.env` fix, ideally plus the `config.js:69` patch. |
| 2 | `.env` is `root:root 0600` but `meridian-daemon.service` runs `User=meridianbot` → daemon **cannot start at all** (`EACCES` at `envcrypt.js:20`). | Real config drift. Fix perms **only together with #1**, never before — #2 is currently the thing preventing #1 from mattering. |
| 3 | `close-rules.js` rule 5 hardcodes `>= 60` and ignores `minAgeBeforeYieldCheck`. | Dead knob. Either wire it to config or delete the key so it stops implying control it doesn't have. |
| 4 | `rebalanceMinOorMinutes 20 → 10` is the one untested hypothesis; rebalance has a known `rebalance failed after withdraw` failure mode. | **Watch every rebalance in dry-run.** Revert to 20 if the withdraw path fails. |
| 5 | 13/162 records have `pnl_pct` disagreeing >1pp with `(final−initial)/initial`; `closedOutcomes` has corrupt values (peak `7507.25%`). | PnL accounting needs its own audit before any of these means are trusted at face value. |
| 6 | 17/162 (10%) closes earned **exactly $0.00** fees. | Confirm whether that is genuine zero-volume or a fee-claim bug. |

---

## M. Verification performed (2026-07-26)

| Check | Result |
|---|---|
| `_presetApplied.name` | `garda-rr-v1` (prev `compounding.draft`) ✅ |
| All 42 audited knobs in `user-config.json` | match preset ✅ |
| `copyTrade.enabled` | `false` ✅ |
| `systemctl is-active` × 6 meridian units | **all `inactive`** ✅ |
| Dry-run screen (`DRY_RUN=true node cli.js screen --dry-run`) | exit 0, **no deploy, no spend** — `"Tidak ada kandidat"`, gates rejected all candidates (volume / organic score) ✅ |
| `state.json`, `lessons.json` after dry-run | byte-identical to pre-run snapshot ✅ |
| Root-owned files created by the run | `decision-log.json`, `sol-regime-snapshots.json`, `logs/agent-2026-07-26.log` → **chowned back to `meridianbot`** ✅ |
| **Effective** `DRY_RUN` | **`"false"` — ✗ see §J** |

**Status: NOT LIVE.** Going live requires, in order: (1) fix §J, (2) owner topup ≥ 0.8–1.0 SOL,
(3) dry-run cycles with the daemon started **explicitly**, (4) only then flip to live.
