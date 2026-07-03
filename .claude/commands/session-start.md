---
description: Ritual awal sesi — bridge, state live, materi LP Meteora, checklist peran Claude
---
Run the Meridian session startup ritual. Use the Bash tool for all commands **sequentially** (never background, never parallel).

**Step 0 — Read the ritual doc:**
```
head -80 notes/SESSION_START.md
```

**Step 1 — Bridge & live state (SESSION_START Langkah 0):**
```
cd /root/meridian
python3 scripts/agent_sync.py status
head -60 notes/HANDOFF.md
head -40 notes/BRIDGE.md
grep -E '"dryRun"|"athEntryGateEnabled"|"solRegimeGateEnabled"|"deployAmountSol"' user-config.json
node cli.js balance
node cli.js positions
tail -c 4000 decision-log.json
systemctl is-active meridian-daemon meridian-discord 2>/dev/null || true
```

**Step 2 — LP learning material (SESSION_START Langkah 1):**
```
tail -200 notes/METEORA_LP.md
LATEST=$(ls -t notes/x-scrape/*.md 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then head -100 "$LATEST"; else python3 scripts/x_scrape_lp.py; fi
```

**Step 3 — Role context:**
```
head -60 notes/CLAUDE_AGENT.md
head -50 CLAUDE.md
```

**Step 4 — Check for open Claude tasks:**
```
grep -A8 'assignee.*claude\|**Assignee:** claude' notes/HANDOFF.md | head -40 || true
```

**Step 5 — Report to user:**

Summarise in Indonesian:
1. `dryRun` mode (from grep — do NOT assume from old notes)
2. Wallet SOL + open positions count
3. Daemon + discord service status
4. Last 2–3 decisions from decision-log (SCREENER/MANAGER)
5. One insight from METEORA_LP or x-scrape (Printboard, strategy thread, etc.)
6. Any open handoff tasks assigned to Claude

If any service is down or handoff tasks exist for Claude, state what you will do next (investigate vs handoff back to Hermes).

**Rules:** Never change user-config.json. Never assume DRY_RUN=true — always verify from Step 1 grep.