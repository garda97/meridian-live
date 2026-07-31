# MEMORY_PROTECTED.md
# ⚠️ JANGAN diubah Hermes relay / auto-compaction.
# Edit: Claude Code (ace) atau owner. Archive penuh: /opt/meridian/notes/MEMORY_PROTECTED_FULL_20260709.md

---

## Hybrid scalp (LOCKED 2026-07-09 owner)
- /opt/meridian LIVE · maxPositions=2 · deploy=0.5 SOL
- bins: min 50 / default 100 / max 120 / autoMax 120
- T22 base OK iff quote=SOL; non-SOL quote filtered
- Jangan copy 3–5 SOL / hold 3m (wallet 5Rc6Ngq… style)
- Ref: notes/STRATEGY_HYBRID_SCALP.md

---

## CPO — Concentration Paradox Override
Top10 >35% boleh PASS jika SEMUA: dev=0, lp_burned, mint+freeze renounced, sm_count≥8, sm_inflow≥50% mcap.
SM density = sm_count/(mcap_discovery/1000); >0.5 = extreme. Fresh+axiom+no_paper_hands+tx<5 = early SM weight↑.
Skill: concentration-paradox-detector. (legacy path screening_g97; Meridian: user-config security.concentrationParadox*)

---

## Missed 134x 🐂🀄️ (2026-06-28) — false top10 reject
CA `EPD8jj7bVhNh3o7Wx1XZ39aaacSki8p2ABaN61yhUnBh` · $15.6K→134x.
Reject top10 46.9% = FALSE POSITIVE (dev clean, SM 13, buy $27K=173% mcap, density 0.83).
Lesson: CPO wajib. Report: notes archive / reports.

---

## ANSEM phoenix 485x (2026-06-28) — pattern
CA `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`.
Crash >99% → SM floor → KOL wave → new ATH. Blind window X ~69h = stealth accum.
Narrative name (ANSEM/@blknoiz06) = meta flag. Bot correctly skipped high mcap first print; phoenix = separate watch.
Legacy: phoenix_repump_monitor (screening_g97 decommission di Meridian — jangan auto-run).

---

## Serial SM (short) — 2+ overlap = P0 screen
9fpUmh3Tv3UCdeHLyq3o4QhkTBu5XAbEiKP9FtGaSndb
5bvKKEVpC6m8JAccHuw6Cb4PT4KETttv7Q9HNHWsQyyZ
93kgxYKex5wPyEkjH9P4KspLFAi3fdWBkw8vZce51pbp
CHaDm47iDzKGjmpTSHjtEvDURZEnFyBDvdUrEjCSVJjk
XppYcY1RZyDTLayChp87oyJtAE9azfTyfJTvv3YK45f
Hv6fAzEffrKYSzsMhy1xtb3MiBjb5TTaGfH7tZAkbuzk
8Kie3Pa5aKpFyyUJw9m5DtNBPjGFfksZDFcZnfuhcti6 (fresh diamond 🐂)

---

## Skills pointer
token-council · concentration-paradox-detector · meridian-session-startup · meridian-lp-strategy · exit-signal

---

## GMGN
Cross-process ratelimit `/tmp/gmgn_ip_ratelimit.state`. Always acquire slot before GMGN calls. Ban Watcher cron af4e173c647a.
