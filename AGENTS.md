# AGENTS.md — Meridian Trio

Panduan trio: **Hermes (otak)** · **Grok (eksekutor)** · **Claude (ace card)**

## Integrasi agent

```
notes/HERMES.md        ← otak utama
notes/GROK.md          ← eksekutor
notes/BRIDGE.md        ← status sinkron (auto)
notes/HANDOFF.md       ← task queue
notes/CURRENT.md       ← fase project
CLAUDE.md              ← engineering manual Meridian
```

| Agent | File | Peran |
|-------|------|-------|
| Hermes | `notes/HERMES.md` | Otak — analisis pool, routing keputusan |
| Grok | `notes/GROK.md` | Eksekutor — setup, debug, deploy |
| Claude | `notes/CLAUDE_AGENT.md` + `CLAUDE.md` | Ace card — refactor/analisis on-demand |

## Alur kerja

```
Owner → Hermes (decide) → Grok (execute) → Hermes (report)
                              ↓
                         Claude (on-demand, ace card)
```

## Sync bridge

```bash
python3 scripts/agent_sync.py status
python3 scripts/hermes_bridge.py connect
python3 scripts/hermes_bridge.py dispatch --assignee grok --summary "..." --tasks "..."
```

## Meridian CLI (Claude Code slash commands)

Dari folder `/root/meridian`, Claude Code punya slash commands built-in:

- `/screen` — full screening cycle
- `/manage` — review & manage positions
- `/candidates` — top pool candidates
- `/positions` — open positions + PnL

## Mode awal

**DRY_RUN** — belajar Meteora tanpa transaksi on-chain. Lihat `notes/CURRENT.md`.