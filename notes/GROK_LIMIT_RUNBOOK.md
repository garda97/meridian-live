# Runbook — Saat Grok Limit / Offline

_Updated: 2026-07-04 | Author: Grok | Untuk: Hermes + Claude + Owner_

Grok = eksekutor infra (fix, commit, restart, review). **Limit Grok ≠ bot mati.**
`meridian-daemon` jalan independen di VPS via systemd.

---

## Yang tetap jalan tanpa Grok

| Komponen | Butuh Grok? |
|----------|-------------|
| `meridian-daemon` (screening 20m, management 10m) | Tidak |
| PnL poller 3s (trailing, partial TP, rebalance, SL) | Tidak |
| LLM SCREENER/MANAGER via 9router + Hermes-free | Tidak |
| On-chain deploy / close / rebalance | Tidak |

```bash
systemctl is-active meridian-daemon   # harus: active
journalctl -u meridian-daemon -n 20 --no-pager
```

---

## Peta delegasi

| Kebutuhan | Siapa | Cara |
|-----------|-------|------|
| Monitor posisi, keputusan trading, report owner | **Hermes** | SESSION_START + decision-log |
| Fix bug, PR, test, refactor | **Claude** | HANDOFF assignee `claude` |
| Emergency stop / restart daemon | **Owner** (SSH) | Perintah di bawah |
| Review diff + commit + restart post-Claude | **Owner** atau tunggu Grok | `git diff`, `git commit`, `systemctl restart` |

---

## Hermes — checklist saat Grok limit

### Tiap sesi (WAJIB)
```bash
cd /root/meridian
grep '"dryRun"' user-config.json
node cli.js balance
node cli.js positions
tail -30 decision-log.json
systemctl is-active meridian-daemon
journalctl -u meridian-daemon -n 15 --no-pager | grep -E 'ERROR|rebalance|deploy|close'
```

### Tugas Hermes menggantikan Grok
1. **Monitor & report** — posisi, PnL, screening skip/deploy, gate (sol_regime, daily_loss)
2. **Dispatch Claude** — tulis entry di `notes/HANDOFF.md` (format di bawah) untuk bug/fix
3. **JANGAN** ubah `user-config.json` threshold tanpa owner OK
4. **JANGAN** commit kode — delegasi ke Claude
5. **Boleh** restart daemon jika crash: `sudo systemctl restart meridian-daemon`

### Red flags → dispatch Claude P1
- Tool `Unknown tool` di screening
- Rebalance `FAILED` (bukan `SKIPPED`) setelah withdraw
- Posisi hilang on-chain tapi state masih open >5m
- Daemon crash loop (`systemctl status` failed)

### Handoff ke Claude (copy format)
```markdown
## YYYY-MM-DD HH:MM UTC | hermes → claude

**Summary:** [satu baris masalah]

**Tasks:** KONTEKS LIVE: [wallet, posisi, commit terakhir]. IMPLEMENT: [spesifik]. CONSTRAINT: JANGAN ubah user-config.json tanpa owner; JANGAN start daemon kalau diminta stop; npm test pass. Handoff balik ke hermes/grok.

**Assignee:** claude
**Priority:** P1
**Status:** open
```

---

## Claude — checklist saat Grok limit

### Sebelum coding
```bash
cd /root/meridian
head -80 notes/HANDOFF.md
grep '"dryRun"' user-config.json
git log -3 --oneline
node test/test-rebalance.js && node test/test-strategy-matrix.js   # regression cepat
```

### Tugas Claude menggantikan Grok
1. **Implement** task dari HANDOFF (assignee `claude`)
2. **Test** — `npm run test:syntax` + suite terkait
3. **Handoff balik** — verdict SAFE/FIX + diff summary + cara enable
4. **JANGAN** restart daemon kecuali HANDOFF bilang boleh
5. **JANGAN** ubah `user-config.json` — tulis rekomendasi config di handoff

### Setelah Claude selesai (Grok belum ada)
Owner atau Hermes bisa deploy manual:
```bash
cd /root/meridian
git diff --stat
git add <files>
git commit -m "feat: ..."
sudo systemctl restart meridian-daemon
systemctl is-active meridian-daemon
```

### Backlog terbuka (prioritas saat Grok limit)
| Item | Priority | Catatan |
|------|----------|---------|
| `test-management-priority.js` | P2 | Claude usul — integrasi 5 lapis exit vs rebalance |
| `rebalanceNotify` Telegram | P2 | Gap #3 dari laporan kurikulum |
| Gap P0 migrate SOL + RPC delay | **DONE** | commit `f2e2d0d` |

---

## Owner — emergency tanpa AI

```bash
# Cek
cd /root/meridian && node cli.js positions && node cli.js balance

# Stop bot (aman)
sudo systemctl stop meridian-daemon

# Start bot
sudo systemctl start meridian-daemon

# Matikan rebalance sementara
node cli.js config set autoRebalanceEnabled false
sudo systemctl restart meridian-daemon

# Matikan deploy baru (daily loss sudah ada — atau stop daemon)
node cli.js config set dailyLossLimitUsd 0   # OFF = null di config, cek docs
```

---

## State live (snapshot 2026-07-04)

| Item | Nilai |
|------|-------|
| Commit terakhir | `f2e2d0d` (rebalance + P0 safety) |
| Mode | LIVE `dryRun: false` |
| Wallet | ~1.39 SOL |
| Rebalance | ON (default config.js) |
| dailyLossLimit | $4 |
| filterAutotune | OFF |
| LLM | Hermes-free via 9router |

---

## Trio — ingat peran

```
Hermes  → otak operasional (monitor, dispatch, report)
Grok    → infra + review + commit  ← OFF saat limit
Claude  → engineering (PR, test)
Daemon  → eksekusi 24/7 (independen)
```