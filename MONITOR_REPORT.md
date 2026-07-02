# Meridian DLMM Position Monitor Report
**Generated:** 2026-07-02T20:11:50Z

## Status Summary
- **Monitoring Script:** ACTIVE ✓
- **Telegram Integration:** CONFIGURED ✓
- **Monitor Interval:** Hourly (cron)
- **Alert Threshold:** >0.5% PnL change, OOR status change, fees >$5, trailing stop, stop loss

## Open Positions Status

### 1. Potato-SOL (DNjoSnySsEiwhU6rLzWNkbA1iDUMtr9HkH4E89jo58qy)
- **Deployed:** 2026-07-02T12:53:18.983Z (18 min ago)
- **Peak PnL:** +0.40%
- **Status:** IN RANGE ✓
- **Trailing Stop:** Inactive
- **Fees Accrued:** $0.00 (monitoring)
- **Volatility:** 2.88%
- **Organic Score:** 76/100
- **Entry:** SOL 0.30 | MCap $920k | TVL $66k

### 2. FROGBULL-SOL (99wcGzEugiZH97TxS31nEabEWWKiapk2zr1AUXsDhJww)
- **Deployed:** 2026-07-02T13:00:27.045Z (11 min ago)
- **Peak PnL:** +0.26%
- **Status:** IN RANGE ✓
- **Trailing Stop:** Inactive
- **Fees Accrued:** $0.00 (monitoring)
- **Volatility:** 8.31% (higher)
- **Organic Score:** 85/100
- **Entry:** SOL 0.30 | MCap $1.96M | TVL $27.5k

## Monitoring Capabilities

The monitor tracks:

1. **PnL Changes** — Alert if >0.5% delta detected
2. **Out-of-Range Status** — Alert on status flip (IN/OUT)
3. **Fee Accumulation** — Alert when fees >$5 and accumulating
4. **Trailing Stop Activation** — Alert on TS triggered
5. **Stop Loss Hits** — Alert on liquidation/SL triggered

## Alert History (Last 24h)
- **Total Alerts Sent:** 0
- **Last Check:** 2026-07-02T20:11:50Z
- **Result:** No material changes detected (all positions stable)

## Configuration

**Telegram:**
- Chat ID: Configured ✓
- Bot Token: Configured ✓
- Test Delivery: Ready

**Monitor Script:**
- Location: `/root/meridian/scripts/monitor_dlmm.py`
- State Tracking: `/tmp/meridian_monitor_state.json`
- Log File: `/root/meridian/notes/MONITOR.md`

## Alert Format Examples

```
[Potato-SOL] UP PnL +2.50% | Delta +1.20%
[FROGBULL-SOL] WARNING: OUT OF RANGE | Rebalance needed
[RTM-SOL] FEES: +$12.45 | Total $18.00
[world-SOL] TRAILING STOP: Activated
[PEACE-SOL] CRITICAL: STOP LOSS HIT (-15.0%) | AUTO CLOSED
```

## Next Steps

1. Monitor will run on hourly cron schedule
2. Any material change will trigger Telegram alert
3. All alerts logged to `notes/MONITOR.md`
4. PnL tracking continues in real-time

---
Monitor Status: **ACTIVE & MONITORING** ✓
