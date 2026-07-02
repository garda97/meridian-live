===== MERIDIAN DLMM MONITORING SETUP COMPLETE =====

TASK: Monitor Meridian DLMM positions & send Telegram alerts
STATUS: ✓ OPERATIONAL

COMPONENTS INSTALLED:
1. /root/meridian/scripts/run_monitor.py
   - Main monitoring engine
   - Detects material changes in OPEN positions
   - Logs alerts to notes/MONITOR.md
   - Sends Telegram alerts if configured

2. /root/meridian/monitor_cron_setup.sh
   - Cron wrapper script
   - Executes every 5 minutes (recommended)
   - Maintains /tmp/meridian_monitor.log

3. /tmp/meridian_monitor_state.json
   - Persistent state tracking
   - Compares current vs previous snapshots
   - Detects deltas for alerting

MONITORED METRICS:
✓ PnL changes (threshold: >0.5%)
✓ Out-of-range transitions (auto-rebalance flag)
✓ Fee accumulation (threshold: >$5 USD)
✓ Trailing stop activation
✓ Pending exit signals
✓ Position closures (with PnL)

LOGGING:
✓ All alerts logged to: /root/meridian/notes/MONITOR.md
✓ Cron output to: /tmp/meridian_monitor.log (last 1000 lines)

TELEGRAM INTEGRATION:
- Alert format: [POOL-NAME] metric value | status
- Requires: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env
- Auto-sent when threshold triggered
- Gracefully skips if not configured

CRON SETUP:
To enable automatic monitoring every 5 minutes, add to crontab:
  */5 * * * * /root/meridian/monitor_cron_setup.sh

CURRENT STATE:
- Open positions: 3 (RTM-SOL, traindog-SOL, world-SOL)
- Closed positions: 4 (world-SOL, NYAN-SOL, FROGBULL-SOL, PEACE-SOL)
- Last monitored: 2026-07-02T12:06:52Z

TEST RUN RESULT:
- Comparison: Previous state vs Current state
- Alert(s): Detected PEACE-SOL closure (PnL: 5.02%)
- Status: LOGGED + SAVED to /tmp/meridian_monitor_state.json

NEXT STEPS:
1. Verify TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID in /root/meridian/.env
2. Run: crontab -e
3. Add: */5 * * * * /root/meridian/monitor_cron_setup.sh
4. Save and exit
5. Verify: crontab -l

MANUAL TEST:
  cd /root/meridian && python3 scripts/run_monitor.py

MONITORING FLOW:
1. cron triggers every 5 minutes
2. run_monitor.py loads current state from state.json
3. Compares with previous snapshot from /tmp/meridian_monitor_state.json
4. Detects material changes (PnL, OOR, fees, stops)
5. Logs each alert to /root/meridian/notes/MONITOR.md with timestamp
6. Sends Telegram alert if configured
7. Saves new snapshot for next comparison
8. Returns exit code 0 (cron logs handled)

ALERT EXAMPLES:
- [RTM-SOL] PnL +3.2% (peak 3.5%)
- [world-SOL] OUT OF RANGE - rebalance needed
- [RTM-SOL] Fees +$12.50 accumulated
- [RTM-SOL] Trailing stop ACTIVATED
- [PEACE-SOL] CLOSED | PnL: 5.02%
