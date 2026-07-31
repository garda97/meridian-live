# BRIDGE — Hermes ↔ Grok ↔ Claude (Meridian)

_Updated: 2026-07-17T14:15:59.758326+00:00 by **agent_sync**_

## Quick status

| Item | Value |
|------|-------|
| Phase | `Evil Panda strict live` |
| Git branch | `github-main` |
| Uncommitted files | 59 |
| Last commit | 14748b9 fix(rebalance): untracked-position bug + unbounded downside_pct range (11 hours ago) |
| DRY_RUN | `False` |
| user-config.json | yes |
| .env | yes |
| Recent decisions | 0 |

## Latest handoff

**2026-07-17 13:56 UTC** | `grok` → `claude`
> Owner request: review readiness of meridian-rh (Robinhood Uniswap LP bot) at /opt/meridian-rh. Ensure no errors/misses before any live deploy. Daemon is DRY_RUN=true, LLM wired, GMGN+analyze/screen-lp SOP added. Do NOT start Meridian Solana (owner stop still open).

Tasks: `READINESS REVIEW — /opt/meridian-rh (NOT /opt/meridian Solana)`

## Pending for grok

- [high] Review 7 file uncommitted (config.js, lessons.js, pool-memory.js, state.js, tools/dlmm/deploy.js, tools/dlmm/liquidity.js, tools/strategy-router.js) + user-config.example.json — semua udah LIVE di daemon (restart bersih, 13 test suite existing pass + logic sanity-check manual buat bagian yang gak ke-cover test), tapi belum di-commit/push. Putusin commit ke github-main + push origin/main kalau owner OK. Monitor 1-2 hari: apakah bidAskFeeTvlMin/severeLoss gate kena trigger false-positive di kondisi live yang gak kena-cover 154 sample trade historis.
- [high] JANGAN start/restart meridian-daemon, meridian-watch-wallets, atau nyalain lagi early-bird-scanner cron sampai ada perintah eksplisit dari owner. Kalau kamu abis apply config change dan biasanya auto-restart daemon buat apply — tahan dulu, cek handoff/owner command dulu sebelum restart.

## Pending for claude

- [P1] READINESS REVIEW — /opt/meridian-rh (NOT /opt/meridian Solana)

## Read next

1. `notes/HERMES.md` — otak utama
2. `notes/GROK.md` — eksekutor
3. `notes/CURRENT.md` — fase project
4. `notes/HANDOFF.md` — task queue
5. `CLAUDE.md` — engineering manual Meridian


### 2026-07-26 Hermes → Claude
Owner chose **A1**: Meridian Solana R:R redesign + clean preset. Full brief: `notes/HANDOFF_CLAUDE_MERIDIAN_RR_V1.md`. Daemon stays OFF.
