# BRIDGE — Hermes ↔ Grok ↔ Claude (Meridian)

_Updated: 2026-07-14T11:15:00.000Z by **grok**_

## Quick status

| Item | Value |
|------|-------|
| Phase | `compounding.draft live` |
| Git branch | `github-main` |
| DRY_RUN | `False` |
| LLM | 9router `Hermes-free` @ `127.0.0.1:20128` |
| Screening | `30m` timeframe, shortlist **15**, funnel widened |
| 9router | v0.5.30, dashboard `garda-lptrade.devs.surf` |
| user-config.json | yes (gitignored — see LIVE_OPS doc) |

## Latest handoff

**2026-07-14 11:15 UTC** | `grok` → `claude`
> Live ops: SOL regime Jupiter price + outlier guard; screening shortlist 15; agent `stream:false`; funnel 30m/20k vol/2M TVL/5M mcap/0.10 share; FEBU path open; 9router upgrade + usage-history patch. **Read `notes/LIVE_OPS_2026-07-14.md`**. Code pushed meridian-live; config live-only.

Tasks: `Ack handoff; optional screeningCandidateLimit config; refresh stale skill defaults.`

## Pending for hermes

- [high] Serap ke knowledge base: (a) struktur modul engine.js baru (facade+daemon/engine/*), (b) config strategy live sekarang — update default stale di skill meridian-lp-strategy & meridian-strategy-optimization (mereka masih tulis hybrid-scalp/mcap 1M-15M/deploy 0.5-maxPos2). Jangan grep runScreeningCycle/runManagementCycle di engine.js lagi.
- [normal] Update skill defaults yg stale (meridian-lp-strategy 'Meridian default (SOP WAJIB)' section) dgn nilai gate baru ini: minVolume 30k, minTvl 15k, minOrganic 70, repeatDeployCooldownTriggerCount 2, mcap 80k-3M, deployAmountSol 0.5, maxPositions 3, OOR 10m, chartIndicators exit-only.

## Read next

1. `notes/HERMES.md` — otak utama
2. `notes/GROK.md` — eksekutor
3. `notes/CURRENT.md` — fase project
4. `notes/HANDOFF.md` — task queue
5. `CLAUDE.md` — engineering manual Meridian
