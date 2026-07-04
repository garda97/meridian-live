# Changelog

All notable changes to this fork (`meridian-live`) are documented here.

## [Unreleased] — 2026-07-04

### Added
- **Gap 2 (Minimal Estimated Share Pct)**: Filter opt-in untuk menghindari pool dengan `estimated_share_pct` di bawah threshold. Default `null` (OFF).
  - Parameter: `minEstimatedSharePct` (default `null`).
- **Gap 3 (Exit Rule 3-Kondisi)**: Exit rule opt-in untuk menutup posisi jika salah satu dari tiga kondisi terpenuhi:
  1. PnL ≥ `takeProfitPct` (trailing TP).
  2. PnL ≤ `stopLossPct` (hard SL).
  3. OOR ≥ `outOfRangeWaitMinutes` (OOR timeout).
  - Parameter: `exitRule3ConditionsEnabled` (default `false`).
- **Gap 1 (TGE Play)**: Override konservatif untuk pool TGE (bins_below=35, bins_above=0, max_hold_hours=8). Default OFF.
  - Parameter: `tgePlayEnabled` (default `false`), `tgeMaxHoldHours` (default `8`).
- **Ops dashboard** — FastAPI web UI (`npm run dashboard`) with live daemon status, wallet, positions, decision log, screening thresholds, and agent logs
- **`rugcheckTop10MaxPct`** — configurable rugcheck.xyz top-10 holder cap (CLI: `node cli.js config set rugcheckTop10MaxPct 65`)
- **Hermes config tuning guide** — `notes/HERMES_CONFIG_TUNING.md` for safe parameter changes within tolerance bands
- **Grok limit runbook** — `notes/GROK_LIMIT_RUNBOOK.md` for multi-agent handoff when Grok is offline
- **Auto-rebalance (POWER MODE)** — strategy drift, OOR upside/downside matrix, migrate path for wide ranges
- **Partial take-profit** — opt-in DCA-out at configurable trigger (`partialTpEnabled`)
- **Win redeploy cooldown** — block same-pool redeploy after clean in-range trailing TP wins
- **External close handler** — record PnL when position closed manually on-chain
- **SOL regime gate** — skip new deploys when SOL 1h dump exceeds threshold
- **Volatile pump guard** — upside cover gate + pool-memory recall for OOR wins
- **Evil Panda exit stub** — RSI + Bollinger + supertrend chart exit layer (opt-in)
- **GMGN holder ratios** — fresh wallet / bundler concentration in screening
- **Filter autotune profit lock** — floors prevent eroding below profit-preset line

### Changed
- Rebalance migrate path: pre-flight SOL gate + RPC settle delay before reclaim
- Agent loop: fuzzy-match `Compat*` tool names from LLM artifacts
- Discord listener + Telegram logging improvements

### Removed
- GIMI integration (scripts, handlers, cron) — refocus on Meteora DLMM core

## [Earlier] — 2026-07-02 / 07-03

- Trailing TP tuning (4% trigger / 1.5% drop)
- ATH entry gate (opt-in)
- `minTokenFeesSol` Evil Panda floor (30 SOL default in code, configurable)
- Claude rebalance brief + test suites (`test-rebalance`, `test-strategy-matrix`, `test-partial-tp`)
- Helius RPC key rotator (21-key pool)
- Bridge sync (`scripts/agent_sync.py`) for Hermes ↔ Grok ↔ Claude