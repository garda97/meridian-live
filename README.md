# Meridian

**Autonomous DLMM liquidity agent for Solana.**

Screen high-quality [Meteora](https://meteora.ag) pools → deploy capital → rebalance in-range → exit with discipline. Every closed position becomes structured memory for the next cycle.

<p align="center">
  <a href="https://github.com/garda97/meridian-live/stargazers"><img src="https://img.shields.io/github/stars/garda97/meridian-live?style=for-the-badge&logo=github" alt="Stars" /></a>
  <a href="https://github.com/garda97/meridian-live/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-see_repo-blue?style=for-the-badge" alt="License" /></a>
  <img src="https://img.shields.io/badge/solana-mainnet-14F195?style=for-the-badge&logo=solana&logoColor=white" alt="Solana" />
  <img src="https://img.shields.io/badge/meteora-DLMM-7C3AED?style=for-the-badge" alt="Meteora DLMM" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 18+" />
</p>

<p align="center">
  <a href="https://agentmeridian.xyz">Website</a> ·
  <a href="https://t.me/agentmeridian">Telegram</a> ·
  <a href="https://x.com/meridian_agent">X</a> ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

---

## Why Meridian

Most LP bots are dumb cron scripts. Meridian is a **ReAct agent loop**: each cycle loads live chain + market state, reasons with an LLM, calls tools, and writes a decision log you can audit later.

| | Screening | Management |
|---|---|---|
| **Cadence** | ~every 20 min (configurable) | ~every 10 min + 3s PnL poller |
| **Job** | Find & open the best pool | Rebalance, claim fees, exit |
| **Brain** | Risk filters + LLM ranking | OOR matrix, TP/SL, trailing |

```
                    ┌──────────────────┐
   Meteora API  ──► │  Screening Agent │ ──► deploy (optional)
   GMGN / rugcheck  └────────┬─────────┘
                             │ decision-log.json
   on-chain DLMM   ──► ┌─────▼──────────┐
   PnL / wallet    ──► │ Management     │ ──► rebalance / close
   Jupiter quotes  ──► └────────────────┘
                             │
                      Telegram · Dashboard · CLI
```

**Upstream:** production fork of [yunus-0x/meridian](https://github.com/yunus-0x/meridian) · **this tree:** [garda97/meridian-live](https://github.com/garda97/meridian-live)

---

## Features

- **Pool screening** — Meteora discovery + LPAgent merge, GMGN audit, rugcheck gate, fee/TVL · organic · holders · mcap · bin-step filters
- **Position management** — auto-rebalance (spot / bid-ask), claim fees, partial TP, trailing stop, stop-loss, severe-loss caps
- **Learning loop** — closed-outcome history, lessons, per-pool memory & cooldowns, optional HiveMind
- **Signals** — optional Discord listener (LP call bots) still passes full screening
- **Control plane** — Telegram agent chat, FastAPI ops dashboard, CLI (`node cli.js …`)
- **Safety** — `DRY_RUN` by default path, AES-256-GCM env encryption, secrets never committed

---

## Quick start

### Requirements

- Node.js **18+**
- Solana wallet (base58 secret) + RPC ([Helius](https://helius.xyz) recommended)
- LLM key via [OpenRouter](https://openrouter.ai) (or any OpenAI-compatible base URL)
- Optional: Telegram bot, Jupiter API key, Discord user token for signal listener

### Install

```bash
git clone https://github.com/garda97/meridian-live.git meridian
cd meridian
npm install
npm run setup          # interactive wizard → .env + user-config.json
npm run dev            # dry-run, no on-chain txs
# npm start            # LIVE — real capital
```

### Environment (never commit)

Copy from [`.env.example`](./.env.example). Minimum:

```env
WALLET_PRIVATE_KEY=          # base58
RPC_URL=                     # Helius or other mainnet RPC
OPENROUTER_API_KEY=          # or set LLM_BASE_URL + LLM_API_KEY
HELIUS_API_KEY=              # wallet / enhanced APIs
JUPITER_API_KEY=             # optional — swap API
TELEGRAM_BOT_TOKEN=          # optional
TELEGRAM_CHAT_ID=            # optional
DRY_RUN=true
```

Strategy knobs live in `user-config.json` (from `user-config.example.json`) — risk preset, deploy size, intervals, exit rules. **Private keys and API keys belong only in `.env`.**

Encrypt secrets at rest (optional):

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

---

## Run on a VPS (PM2)

```bash
npm install
npm run pm2:start      # ecosystem.config.cjs — do NOT pm2 start index.js
pm2 save
npm run pm2:logs
```

After config or code changes:

```bash
git pull && npm install && npm run pm2:restart && pm2 save
```

---

## Ops dashboard

Local monitoring UI — daemon status, wallet, positions, decision log, logs.

```bash
pip install fastapi uvicorn   # once
npm run dashboard             # http://127.0.0.1:8765
```

Optional remote bind (put TLS + auth in front):

```bash
export MERIDIAN_DASHBOARD_SECRET=your-long-random-key
export MERIDIAN_DASHBOARD_HOST=0.0.0.0
npm run dashboard
# http://host:8765/?key=your-long-random-key
```

---

## CLI

```bash
node cli.js screen      # one screening cycle
node cli.js manage      # one management cycle
node cli.js deploy      # manual deploy helpers
node cli.js --help
```

Useful npm scripts: `helius:status`, `preset:list`, `preset:evil-panda:dry`, `test:syntax`.

---

## Architecture (short)

| Layer | Role |
|---|---|
| `index.js` / `daemon/*` | Process entry, cron cycles, management engine |
| `agent.js` + harness | ReAct loop, tool registry, cycle reports |
| `tools/*` | DLMM, wallet, Jupiter, screening, signals |
| `config.js` + `user-config.json` | Defaults + operator overrides |
| `decision-log.json` | Append-only rationale (runtime, gitignored) |
| `web/dashboard` | FastAPI ops UI |

**Data plane:** `@meteora-ag/dlmm` · Meteora PnL API · screening APIs · Jupiter · Helius

---

## Security

This repository is **public**. Treat it as source-only:

| Do | Don't |
|---|---|
| Keep keys in `.env` / encrypted `.envrypt` | Commit `.env`, `user-config.json`, wallet dumps |
| Rotate any key that ever touched git history | Hardcode API keys in `tools/*.js` |
| Run `DRY_RUN=true` until filters look sane | Expose dashboard without auth / TLS |
| Use a **burner** wallet for experiments | Paste Discord user tokens into issues/PRs |

`.gitignore` blocks env files, config backups, runtime state, and local tokens. If you fork, re-scan before going public.

---

## Documentation

| Path | Contents |
|---|---|
| [`CHANGELOG.md`](./CHANGELOG.md) | Release notes |
| [`notes/`](./notes/) | Strategy notes, handoffs, runbooks (fork ops) |
| [`user-config.example.json`](./user-config.example.json) | Full config shape |
| [`.env.example`](./.env.example) | Env template |

---

## Disclaimer

Meridian is experimental trading software. Liquidity provision on Solana can lose principal quickly (impermanent loss, rugs, failed txs, RPC issues). **You are solely responsible for keys, capital, and compliance.** Nothing here is financial advice.

---

<p align="center">
  <sub>Built for operators who want agents that explain their trades — not black-box farms.</sub>
</p>
