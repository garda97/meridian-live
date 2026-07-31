# CURRENT — Meridian project state

## Phase

**garda-rr-v1 (evaluation / dry-run)** — applied 2026-07-26 by Claude per Hermes handoff A1.

- Preset: `presets/garda-rr-v1.json`
- `dryRun: true` (forced)
- Daemon / discord / watch-wallets: **OFF** (do not start without owner)
- Wallet SOL: **0.0** — live deploy impossible until topup ≥ 0.8–1.0 SOL

Evil Panda strict (2026-07-04) and compounding.draft live claims are **obsolete**.

## Live R:R (garda-rr-v1)

| Knob | Value |
|------|------:|
| takeProfitPct | 7 |
| stopLossPct | -6 |
| maxLossPct | -9 |
| trailingTrigger / drop | 2 / 1.5 |
| minAgeBeforeTP | 15m |
| OOR wait | 15m |
| athEntryGate | ON |
| solRegimeGate | ON (−3%/1h) |
| sprayMode | OFF |
| copyTrade | OFF |
| filterAutotune / autoRecovery / darwin | OFF |
| deployAmountSol / maxPositions | 0.5 / 1 |
| dailyLossLimitUsd | 18 |
| strategy base | spot (autoStrategy still ON) |
| defaultBinsBelow / maxBins | 90 / 140 |

## Thesis (Claude audit)

Negative expectancy dominated by **few tail rugs/dumps**, not the old TP band. Redesign: tighter entry gates + suppress tails + let fee-hold/trailing work; TP raised to act as spike cap.

Full writeup: `notes/RR_V1_REDESIGN.md` (if present) + `/root/shared-telegram/REPORT_CLAUDE_MERIDIAN_RR_V1.md`

## Startup ritual

1. Read this file + `notes/SESSION_START.md`
2. Confirm `dryRun: true` and daemon inactive
3. Only after owner topup + dry-run cycles: flip dryRun and start daemon **explicitly**

## Owner next

1. Review report / preset notes
2. Topup wallet when ready
3. Dry-run N cycles
4. Explicit command to go live

_Updated: 2026-07-26 05:38 UTC — Hermes closeout after Claude A1 apply_
