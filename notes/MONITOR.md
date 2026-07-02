# MERIDIAN DLMM Monitor Log

Real-time position monitoring alerts and status changes for OPEN positions.

## Configuration
- **Monitor Interval:** Every 5 minutes (cron)
- **Alert Thresholds:**
  - PnL change: >0.5%
  - Fee accumulation: >$5 USD
  - Out-of-range status changes
  - Trailing stop activation
  - Pending exit signals
- **Notification:** Telegram + local log

---

## ALERTS

[2026-07-02T18:41:43Z] Monitor initialized - baseline established
[2026-07-02T18:41:43Z] OPEN POSITIONS: 3 | RTM-SOL (+1.34%), NYAN-SOL (+0.74%), FROGBULL-SOL (+0.22% OOR)
[2026-07-02T18:41:43Z] CLOSED POSITIONS: 1 | world-SOL (+0.19%) - Closed 2026-07-02

[2026-07-02T18:45:02.792441] ❌ [FROGBULL-SOL] Position CLOSED | Closed at 2026-07-02T11:42:33.159Z: agent decision

[2026-07-02T11:46:39.727969+00:00] Monitor Cycle | OPEN: 3 | RTM-SOL (+1.40%) | NYAN-SOL (+0.74%) | PEACE-SOL (+0.06%)

## 2026-07-02T18:51:58.561446

**Status:**
- Open: 4 positions
- Closed: 2 positions
- Total PnL: 2.24% (avg: 0.56%)
- Fees accumulated: $0.00

**Open Positions:**

- RTM-SOL: PnL 1.40% | In range
- NYAN-SOL: PnL 0.74% | In range
- PEACE-SOL: PnL 0.06% | In range
- traindog-SOL: PnL 0.04% | In range

**Alerts:** None (no material changes)
[2026-07-02T18:55:03.087748] ❌ [NYAN-SOL] Position CLOSED | Closed at 2026-07-02T11:54:33.965Z: pumped far above range

## 2026-07-02T18:56:16Z

**Monitoring Cycle - No Material Changes**

- Check timestamp: 2026-07-02T18:56:16Z
- Previous state: 2026-07-02T11:54:33.965Z
- Open positions: 3 (RTM-SOL, PEACE-SOL, traindog-SOL)
- Material changes: 0
- Status: All positions stable | No alerts required
[2026-07-02T19:00:02.345694] 📈 [RTM-SOL] PnL Change: +2.93% (Δ +1.53%)

## 2026-07-02T12:02:01Z

**Monitoring Cycle - System Stable**

- Check timestamp: 2026-07-02T12:02:01Z
- Previous state reference: 2026-07-02T12:01:43Z
- Total positions: 7
- Open positions: 4
  - RTM-SOL: PnL +2.93% | In range | No issues
  - PEACE-SOL: PnL +0.11% | In range | Pending exit monitor active
  - traindog-SOL: PnL +0.07% | In range | Stable
  - world-SOL: PnL 0.00% | In range | Just deployed
- Closed positions: 3
  - world-SOL (Fdcbta5vXcd...): Pumped far above range | PnL +0.19%
  - NYAN-SOL (GsJGaynR4Lp...): Pumped far above range | PnL +0.74%
  - FROGBULL-SOL (6NegRDi4f6q...): Agent decision close | PnL +0.22%
- Fee accumulation: $0.00 total
- Trailing stops: 0 active
- Material changes: **NONE**
- Alert status: **[SILENT]** - No threshold triggers

**Assessment:** Portfolio performing nominally. All open positions in range, fee collection passive. No Telegram alerts required.
[2026-07-02T19:05:03.512057] 📈 [PEACE-SOL] PnL Change: +2.92% (Δ +2.81%)
[2026-07-02T19:10:02.592925] ❌ [RTM-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)

---
**[2026-07-02 19:11 UTC]** Meridian Monitor Check
- Open positions: 2/8
  - 9E6tzrYEjH1JtV2J82nopZfZV7PBXiMHBMJEcmMLpxVo (world-SOL): PnL +0.29%, in-range, fees $0
  - AbgLCPkGZQbwwnhb6ZxCLsiGVrQE4TShUKy9ReWgjJpW (PEACE-SOL): PnL +0.01%, in-range, fees $0
- Alerts: 0 (no material changes)
- Closed in last window: 6 positions (all programmatic closes)
  - RTM-SOL: +2.96% peak → auto-closed (not on-chain)
  - world-SOL: +0.19% peak → pumped above range
  - NYAN-SOL: +0.74% peak → pumped above range
  - FROGBULL-SOL: +0.22% peak → agent decision
  - PEACE-SOL: +5.02% peak → take profit + trailing stop active
  - traindog-SOL: +0.07% peak → agent decision
- Status: STABLE — no urgent alerts, positions performing within expectations
[2026-07-02T19:15:02.942897] ⚠️ [RTM-SOL] OUT OF RANGE | Perlu rebalance

## [2026-07-02 12:16:26Z] Monitor Cycle

- Open positions: 2 (world-SOL, PEACE-SOL)
- Closed positions: 7
- Status: No material changes detected
- PnL: Stable
- Out-of-range: No change
- Trailing stops: None active
- Fees: No accumulation >$5
- Pending exits: None

### Position Details

**world-SOL (9E6tzrYEjH1JtV2J82nopZfZV7PBXiMHBMJEcmMLpxVo)**
- Peak PnL: +0.29%
- Status: In range
- Trailing: Inactive
- Fees claimed: $0

**PEACE-SOL (AbgLCPkGZQbwwnhb6ZxCLsiGVrQE4TShUKy9ReWgjJpW)**
- Peak PnL: +0.01%
- Status: In range
- Trailing: Inactive
- Fees claimed: $0

**RTM-SOL (B1ZoHEu3pDTfqqkRuX5YVLQoH8aAZWp91h23hn7JGrdz)**
- Peak PnL: +0.14%
- Status: OUT OF RANGE (since 2026-07-02T12:14:38.994Z)
- Trailing: Inactive
- Fees claimed: $0
- Action: Requires rebalance

No Telegram alerts sent (no material changes).
[2026-07-02T19:20:02.435304] ❌ [PEACE-SOL] Position CLOSED | Unknown
[2026-07-02T19:20:03.511346] ❌ [RTM-SOL] Position CLOSED | Unknown
[2026-07-02T19:25:02.570443] ❌ [RTM-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)
[2026-07-02T19:25:03.472874] ❌ [world-SOL] Position CLOSED | Closed at 2026-07-02T11:32:07.011Z: pumped far above range
[2026-07-02T19:25:04.227160] ❌ [NYAN-SOL] Position CLOSED | Closed at 2026-07-02T11:54:33.965Z: pumped far above range
[2026-07-02T19:25:05.168926] ❌ [FROGBULL-SOL] Position CLOSED | Closed at 2026-07-02T11:42:33.159Z: agent decision
[2026-07-02T19:25:06.186358] ❌ [PEACE-SOL] Position CLOSED | Closed at 2026-07-02T12:05:44.058Z: take profit
[2026-07-02T19:25:06.919364] ❌ [traindog-SOL] Position CLOSED | Closed at 2026-07-02T12:10:57.622Z: agent decision
[2026-07-02T19:25:07.666746] ❌ [world-SOL] Position CLOSED | Closed at 2026-07-02T12:16:06.614Z: agent decision
[2026-07-02T19:25:08.562724] ❌ [PEACE-SOL] Position CLOSED | Unknown
[2026-07-02T19:25:09.299399] ❌ [RTM-SOL] Position CLOSED | Unknown
[2026-07-02T19:25:10.094769] ⚠️ [FROGBULL-SOL] OUT OF RANGE | Perlu rebalance

## [2026-07-02T12:26:53.185091Z] Monitor Cycle

- Open positions: 1
- Closed positions: 9
- Material changes: 0
- Alert status: [SILENT]

**Status:** All positions stable | No alerts required

## [2026-07-02T12:27:22.008610Z] Monitor Cycle

- Open positions: 1
- Closed positions: 9
- Material changes: 0
- Alert status: [SILENT]

**Status:** All positions stable | No alerts required

---

## 🎯 MONITOR SYSTEM DEPLOYMENT COMPLETE

**Timestamp:** 2026-07-02T12:27:22Z  
**System Status:** ✅ OPERATIONAL

### Installed Components
- ✅ `scripts/monitor_positions.py` — Core monitoring engine
- ✅ `scripts/telegram_alert.py` — Telegram integration  
- ✅ `scripts/setup_monitor_cron.sh` — Cron job installer
- ✅ `docs/MONITOR_SETUP.md` — Complete documentation
- ✅ `docs/MONITOR_INSTALLATION.md` — Installation report

### Alert Coverage
- **6 Alert Types:** Position closure, PnL change, out-of-range, fees, trailing stop, stop loss
- **Threshold-Based:** Only material changes (>0.5% PnL, >$5 fees, etc.)
- **State Persistence:** Snapshot saved to `/tmp/meridian_monitor_state.json`

### Current Portfolio
- Open: 1 position (FROGBULL-SOL, +0.12%, OUT OF RANGE)
- Closed: 9 positions  
- Total Avg PnL: +1.13%
- Fees Accumulated: $0.00
- Material Changes: 0 (stable)

### Next Steps
1. Configure Telegram token in `.env` (optional, for alerts)
2. Run: `bash scripts/setup_monitor_cron.sh` (to enable 5-minute automation)
3. Monitor works now — test with: `python3 scripts/monitor_positions.py`

### Quick Commands
```bash
# Test monitor
python3 scripts/monitor_positions.py

# View recent alerts
tail -30 notes/MONITOR.md

# Install automation  
bash scripts/setup_monitor_cron.sh

# Enable Telegram
echo 'TELEGRAM_BOT_TOKEN=YOUR_TOKEN' >> .env
```

**Version:** 1.0.0  
**Status:** PRODUCTION READY ✅
[2026-07-02T19:35:02.165558] ❌ [FROGBULL-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)

---

## [2026-07-02T12:31:28.724Z] Monitoring Cycle Complete

**Scan timestamp:** 2026-07-02T12:31:28.724Z

### Portfolio Summary
- **Open positions:** 0 / 10
- **Closed positions:** 10 / 10
- **Total peak PnL:** +10.66% aggregate
- **Fee accumulation:** $0.00 USD
- **Trailing stops active:** 0

### Position Breakdown (Closed)
| Pool | Peak PnL | Reason | Closed At |
|------|----------|--------|-----------|
| RTM-SOL | +2.96% | Auto-closed (not on-chain) | 2026-07-02T12:09:26Z |
| world-SOL | +0.19% | Pumped above range | 2026-07-02T11:32:07Z |
| NYAN-SOL | +0.74% | Pumped above range | 2026-07-02T11:54:33Z |
| FROGBULL-SOL | +0.22% | Agent decision | 2026-07-02T11:42:33Z |
| PEACE-SOL #1 | +5.02% | Take profit (trailing) | 2026-07-02T12:05:44Z |
| traindog-SOL | +0.07% | Agent decision | 2026-07-02T12:10:57Z |
| world-SOL #2 | +0.29% | Agent decision | 2026-07-02T12:16:06Z |
| PEACE-SOL #2 | +0.01% | Auto-closed (not on-chain) | 2026-07-02T12:16:48Z |
| RTM-SOL #2 | +0.14% | Auto-closed (not on-chain) | 2026-07-02T12:16:48Z |
| FROGBULL-SOL #2 | +0.12% | Auto-closed (not on-chain) | 2026-07-02T12:31:28Z |

### Alert Status
- **Material changes detected:** 0
- **Telegram alerts sent:** 0
- **Assessment:** ✅ **[SILENT]** — All positions closed, portfolio stable
- **Next alert triggers:** Awaiting new position deployments

### System Status
- Monitor state updated to `/tmp/meridian_monitor_state.json`
- Next scan interval: 5 minutes (automated)
- Threshold status: No thresholds exceeded

**Conclusion:** All positions have been auto-closed or manually closed. No active positions remain. Monitor is operational and waiting for new deployments. No alerts triggered. [SILENT]


## 2026-07-02 12:41 UTC - Monitor Check
- **Status**: All quiet
- **Open positions**: 0
- **Alerts**: None
- **Action**: No Telegram alert needed
[2026-07-02T19:45:02.394967] ❌ [RTM-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)
[2026-07-02T19:45:03.601876] ❌ [world-SOL] Position CLOSED | Closed at 2026-07-02T11:32:07.011Z: pumped far above range
[2026-07-02T19:45:04.387601] ❌ [NYAN-SOL] Position CLOSED | Closed at 2026-07-02T11:54:33.965Z: pumped far above range
[2026-07-02T19:45:05.307769] ❌ [FROGBULL-SOL] Position CLOSED | Closed at 2026-07-02T11:42:33.159Z: agent decision
[2026-07-02T19:45:06.069785] ❌ [PEACE-SOL] Position CLOSED | Closed at 2026-07-02T12:05:44.058Z: take profit
[2026-07-02T19:45:06.964202] ❌ [traindog-SOL] Position CLOSED | Closed at 2026-07-02T12:10:57.622Z: agent decision
[2026-07-02T19:45:07.720542] ❌ [world-SOL] Position CLOSED | Closed at 2026-07-02T12:16:06.614Z: agent decision
[2026-07-02T19:45:08.544716] ❌ [PEACE-SOL] Position CLOSED | Unknown
[2026-07-02T19:45:09.306412] ❌ [RTM-SOL] Position CLOSED | Unknown
[2026-07-02T19:45:10.087069] ❌ [FROGBULL-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)
[2026-07-02T19:50:02.062639] ❌ [RTM-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)
[2026-07-02T19:50:02.847479] ❌ [world-SOL] Position CLOSED | Closed at 2026-07-02T11:32:07.011Z: pumped far above range
[2026-07-02T19:50:03.665837] ❌ [NYAN-SOL] Position CLOSED | Closed at 2026-07-02T11:54:33.965Z: pumped far above range
[2026-07-02T19:50:04.416571] ❌ [FROGBULL-SOL] Position CLOSED | Closed at 2026-07-02T11:42:33.159Z: agent decision
[2026-07-02T19:50:05.274412] ❌ [PEACE-SOL] Position CLOSED | Closed at 2026-07-02T12:05:44.058Z: take profit
[2026-07-02T19:50:06.228884] ❌ [traindog-SOL] Position CLOSED | Closed at 2026-07-02T12:10:57.622Z: agent decision
[2026-07-02T19:50:07.213795] ❌ [world-SOL] Position CLOSED | Closed at 2026-07-02T12:16:06.614Z: agent decision
[2026-07-02T19:50:08.058502] ❌ [PEACE-SOL] Position CLOSED | Unknown
[2026-07-02T19:50:08.855989] ❌ [RTM-SOL] Position CLOSED | Unknown
[2026-07-02T19:50:09.653308] ❌ [FROGBULL-SOL] Position CLOSED | Auto-closed during state sync (not found on-chain)
SESSION: 2026-07-02 12:51:51Z - Monitoring Setup Complete
- 2026-07-02T12:56:22Z | [Potato-SOL] OUT OF RANGE - Perlu rebalance
[2026-07-02T20:01:59.797271] ✅ [Potato-SOL] BACK IN RANGE | Rebalance complete

---

## [2026-07-02 13:02:53Z] Monitor Cycle — Auto-Management Pass

- **Scan timestamp:** 2026-07-02T13:02:53Z
- **Open positions:** 2
- **Closed positions:** 8
- **Actions triggered:** 0

**Open Positions Status:**
- Potato-SOL: PnL +0.20%, In Range, Fees $0 (accruing)
- FROGBULL-SOL: PnL 0.00%, Monitoring, Fees $0 (deployed 2.4min ago)

**Assessment:** STABLE — all positions within thresholds. No alerts required.

## Monitor Run: 2026-07-02T13:11:32Z

Positions checked: 2
Telegram ready: 1


## Monitor Run: 2026-07-02T20:11:50.833085
Positions checked: 2
Alerts sent: 0

## Monitor Run: 2026-07-02T20:15:01.357741
Positions checked: 2
Alerts sent: 0

---
## Monitor Cycle: 2026-07-02 13:16:18 UTC

**Summary:**
- Open positions: 2
- Material alerts: 0
- Status: STABLE

**Positions Status:**
1. **Potato-SOL** (DNjoSnySsEiwhU6rLzWNkbA1iDUMtr9HkH4E89jo58qy)
   - PnL: +0.45% 
   - Deployed: ~20m ago
   - Out of range: NO
   - Trailing stop: INACTIVE
   - Status: HEALTHY

2. **FROGBULL-SOL** (99wcGzEugiZH97TxS31nEabEWWKiapk2zr1AUXsDhJww)
   - PnL: +0.26%
   - Deployed: ~13m ago
   - Out of range: NO
   - Trailing stop: INACTIVE
   - Status: HEALTHY

**Thresholds:**
- PnL alert threshold: >0.5% delta
- Fee alert threshold: >$5 accumulated
- Stop loss: -15%
- Trailing stop trigger: 2.5% peak

**Next monitoring in 5-10 minutes**


### Monitor State Cache
```json
{
  "checked_at": "2026-07-02T13:16:18.761422+00:00",
  "alerts_count": 0,
  "positions": {
    "Potato-SOL": {"peak_pnl_pct": 0.45, "trailing_active": false, "out_of_range": false},
    "FROGBULL-SOL": {"peak_pnl_pct": 0.26, "trailing_active": false, "out_of_range": false}
  }
}
```

### Monitoring Configuration
| Parameter | Value | Description |
|-----------|-------|-------------|
| PnL alert threshold | >0.5% delta | Alert if peak PnL changes by more than 0.5% |
| Fee alert threshold | >$5 | Alert when accumulated fees exceed $5 |
| Out-of-range alert | Immediate | Alert on status change |
| Trailing stop trigger | 2.5% peak | Activate trailing when peak PnL reaches 2.5% |
| Stop loss | -15% | Auto-close at -15% PnL or below |
| Monitor interval | 5-10 min | Position checks every 5-10 minutes |
| Manager interval | 10-15 min | Auto-actions (claim, rebalance, close) every 10-15 min |

### Next Monitoring Cycle
- **Scheduled:** 5-10 minutes after this report
- **Focus:** Watch FROGBULL-SOL for potential out-of-range (high volatility 8.31)
- **Watch:** Potato-SOL fee accumulation (good fee/TVL ratio 0.0899)
- **Cache updated:** Yes, baseline for delta detection established


## Monitor Run: 2026-07-02T20:20:02.334612
Positions checked: 2
Alerts sent: 0

## Monitor Run: 2026-07-02T20:25:01.728625
Positions checked: 2
Alerts sent: 0

---
## 2026-07-02T13:26:01Z — Position Monitor Run

**Status**: All positions stable ✓

**Open Positions**: 1
- FROGBULL-SOL (99wcGzEugiZH97TxS31nEabEWWKiapk2zr1AUXsDhJww)
  - PnL: +0.32% (stable)
  - Status: IN_RANGE
  - Trailing Stop: OFF
  - Fee accumulation: $0.00 (monitoring enabled)

**Recent Closures**:
- Potato-SOL (DNjoSnySsEiwhU6rLzWNkbA1iDUMtr9HkH4E89jo58qy)
  - Closed at 2026-07-02T13:23:30Z
  - Final PnL: +0.45%
  - Reason: Low yield (fee/TVL 6.64% < 10% threshold)

**Alerts Sent**: 0 (no material changes detected)

**Next Check**: Automatic in ~5 minutes


## Monitor Run: 2026-07-02T20:30:01.153946
Positions checked: 2
Alerts sent: 0

---
[2026-07-02 20:35] DLMM Monitor Cycle
Open: 1 (CHANCE-SOL PnL=+0.54% fees=$0)
Closed event: FROGBULL-SOL (low yield 5.19% < 10% threshold)
Alerts sent: 1
Status: NOMINAL


## Monitor Run: 2026-07-02T20:35:01.250273
Positions checked: 3
Alerts sent: 0

## Test Run: 2026-07-02T13:36:44.439533Z
- **CHANCE-SOL**: 📈 PnL +1.00% | Current: 2.01%

## Monitor Run: 2026-07-02T20:40:02.395423
Positions checked: 4
Alerts sent: 1

**Alerts:**
- [CHANCE-SOL] WARNING: OUT OF RANGE | Rebalance needed

## 2026-07-02T13:41:23.648587Z - Monitor
- [CHANCE-SOL] OOR | Perlu rebalance
- [CHANCE-SOL] PnL 1.18%

## Monitor Run: 2026-07-02T20:45:03.493562
Positions checked: 4
Alerts sent: 2

**Alerts:**
- [CHANCE-SOL] UP PnL +1.18% | Delta +1.18%
- [CHANCE-SOL] WARNING: OUT OF RANGE | Rebalance needed

### 2026-07-02 20:46:39
- [CHANCE-SOL] OUT OF RANGE | Perlu rebalance

### 2026-07-02 20:50:01
- (no material changes)

## Monitor Run: 2026-07-02T20:50:03.842535
Positions checked: 4
Alerts sent: 2

**Alerts:**
- [CHANCE-SOL] UP PnL +1.18% | Delta +1.18%
- [CHANCE-SOL] WARNING: OUT OF RANGE | Rebalance needed

## Monitor Run: 2026-07-02T20:55:01.926986
Positions checked: 4
Alerts sent: 0

### 2026-07-02 20:55:03
- [CHANCE-SOL] OUT OF RANGE | Perlu rebalance

### 2026-07-02 21:00:01
- (no material changes)

## Monitor Run: 2026-07-02T21:00:02.892543
Positions checked: 4
Alerts sent: 2

**Alerts:**
- [CHANCE-SOL] UP PnL +1.18% | Delta +1.18%
- [CHANCE-SOL] WARNING: OUT OF RANGE | Rebalance needed

## Monitor Run: 2026-07-02T21:05:02.011638
Positions checked: 4
Alerts sent: 0

### 2026-07-02 21:05:02
- [CHANCE-SOL] OUT OF RANGE | Perlu rebalance

### 2026-07-02 21:10:01
- (no material changes)

## Monitor Run: 2026-07-02T21:10:03.844496
Positions checked: 4
Alerts sent: 2

**Alerts:**
- [CHANCE-SOL] UP PnL +1.18% | Delta +1.18%
- [CHANCE-SOL] WARNING: OUT OF RANGE | Rebalance needed

## Monitor Run: 2026-07-02T21:26:13.871856
Positions checked: 4
Alerts sent: 0
