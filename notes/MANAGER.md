# MERIDIAN Auto-Management Log

Real-time position management — fee claims, rebalance recommendations, trailing stops, and stop-loss alerts.

**Last Auto-Management Cycle:** 2026-07-02T12:22:37Z

---

## 2026-07-02 12:22:37 UTC — Auto-Management Scan

### Open Positions: 3 of 10 max

**1. PEACE-SOL** (AbgLCPkGZQbwwnhb6ZxCLsiGVrQE4TShUKy9ReWgjJpW)
- Status: **IN RANGE** | PnL: -0.71% | Trailing: OFF
- Deployed: ~15 minutes ago
- Unclaimed Fees: $0.0099 | Claimed: $0 (below $5 threshold)
- Range: bins [-667, -598], active bin -599
- **Action:** HOLD — position stable in range, fees still accruing at baseline

**2. RTM-SOL** (B1ZoHEu3pDTfqqkRuX5YVLQoH8aAZWp91h23hn7JGrdz)
- Status: **IN RANGE** | PnL: -0.54% | Trailing: OFF
- Deployed: ~9 minutes ago
- Unclaimed Fees: $0.0015 | Claimed: $0 (below $5 threshold)
- Range: bins [-412, -346], active bin -348
- Fee/TVL 24h: 1.45%
- **Action:** HOLD — fresh deployment, no action yet

**3. FROGBULL-SOL** (DhJeJtB3qMfY944q2c8YYYtHXoTox9eiUbihQtnpRn9c)
- Status: **OUT OF RANGE** (just marked, 0 min duration) | PnL: +0.06% | Trailing: OFF
- Deployed: ~2 minutes ago
- Unclaimed Fees: $0.0003 | Claimed: $0 (below $5 threshold)
- Range: bins [-387, -318], active bin -317 (above range)
- Fee/TVL 24h: 0.9%
- **Action:** MONITOR — position is extremely young (2 min), just went OOR on active bin movement. Too early to close. Will rebalance if still OOR after 15 min wait

### Threshold Evaluation

| Check | Status | Details |
|-------|--------|---------|
| **Claim Fees** | ✓ PASS | Max unclaimed: $0.0099 (threshold: $5) |
| **Rebalance** | ⚠️ WATCH | FROGBULL-SOL OOR but age 0 min (wait 15 min before action) |
| **Trailing Stop** | ✓ PASS | Max PnL: -0.71% (trigger: +3%) |
| **Stop Loss** | ✓ PASS | Min PnL: -0.71% (threshold: -15%) |

### Summary

**Management Status:** `[AUTO] 3 positions monitored`

- **Total pending actions:** 0 (all within normal bounds)
- **Actions executed:** 0
- **Telegram alerts sent:** 0
- **OOR Monitor:** 1 position flagged for rebalance check in ~14 minutes

**Profile:** All positions healthy with fees accruing passively. FROGBULL-SOL requires rebalance decision after 15-min OOR window expires.

---

## Configuration Reference

```
minClaimAmount: $5 USD
outOfRangeWaitMinutes: 15
stopLossPct: -15%
trailingTriggerPct: +3%
trailingDropPct: 1.5%
autoSwapAfterClaim: true
managementIntervalMin: 10
```

**Next management cycle:** 2026-07-02T12:32:37Z (in 10 minutes)

## 2026-07-02 12:32:00 UTC — Auto-Management Scan (Cron)

### Position Status
- **Open positions:** 0 / 10
- **Closed positions:** 10
- **Last closed:** FROGBULL-SOL at 2026-07-02T12:31:28Z

### Action Items Evaluated
| Check | Status | Result |
|-------|--------|--------|
| **Claim Fees** | ✓ PASS | No open positions with pending fees |
| **Rebalance** | ✓ PASS | No out-of-range positions |
| **Trailing Stop** | ✓ PASS | No eligible positions |
| **Stop Loss** | ✓ PASS | No loss positions |

### Summary
**Management Status:** `[SILENT]` — No open positions, no actions pending.

All 10 positions closed. Pool deployment cycle appears complete. No Telegram alert required.

---

## 2026-07-02T12:54:44.368280+00:00Z — Auto-Management Scan

### Status

- Open positions: 1 of 10 max
- Actions pending: 0
- Alerts: 0

### Summary

No immediate actions needed. All positions stable.


---

## 2026-07-02T13:02:53Z — Auto-Management Scan (Cron)

### Position Status
- **Open positions:** 2 / 10 max
- **Last scan:** 2026-07-02T13:02:53Z

### Current Open Positions

**1. Potato-SOL** (DNjoSnySsEiwhU6rLzWNkbA1iDUMtr9HkH4E89jo58qy)
- Deployed: 9.6 minutes ago
- Peak PnL: +0.20%
- Fees claimed: $0.00 (below $5 threshold)
- Status: IN RANGE, fees accruing passively
- Action: HOLD — position healthy, fees still accumulating

**2. FROGBULL-SOL** (99wcGzEugiZH97TxS31nEabEWWKiapk2zr1AUXsDhJww)
- Deployed: 2.4 minutes ago
- Peak PnL: 0.00%
- Fees claimed: $0.00
- Status: MONITOR (position very young, 2.4min old)
- Action: HOLD — too early for any action, monitor for rebalance after 15min OOR window

### Action Items Evaluated

| Check | Status | Details |
|-------|--------|---------|
| **Claim Fees** | PASS | Max $0.00 claimed (threshold: $5) |
| **Rebalance** | MONITOR | FROGBULL-SOL just deployed, OOR age 0min (requires 30min wait) |
| **Trailing Stop** | PASS | Max PnL: +0.20% (trigger: +3%) |
| **Stop Loss** | PASS | Min PnL: 0.00% (threshold: -15%) |

### Summary

**Management Status:** `[AUTO]` Portfolio scan complete

- **Total open:** 2 positions
- **Actions executed:** 0
- **Pending alerts:** 0
- **Telegram notifications:** 0

All positions stable and healthy. Fees accruing passively within normal bounds. FROGBULL-SOL will be monitored for rebalance decision if out-of-range duration exceeds 30 minutes. No urgent interventions required.

**Next auto-management cycle:** ~10 minutes


## 2026-07-02T13:13:14Z — Auto-Management Cycle (Cron)

### Open Positions: 2 / 10 max

**1. Potato-SOL** (DNjoSnySsEiwhU6rLzWNkbA1iDUMtr9HkH4E89jo58qy)
- Age: 19.9 minutes
- Peak PnL: +0.42%
- Fees claimed: $0.00 (< $5 threshold)
- Status: IN RANGE | Healthy
- **Action:** HOLD

**2. FROGBULL-SOL** (99wcGzEugiZH97TxS31nEabEWWKiapk2zr1AUXsDhJww)
- Age: 12.8 minutes
- Peak PnL: +0.26%
- Fees claimed: $0.00 (< $5 threshold)
- Status: IN RANGE | Healthy
- **Action:** HOLD

### Threshold Evaluation

| Check | Status | Details |
|-------|--------|---------|
| **Claim Fees** | ✓ PASS | Max claimed: $0 (threshold: $5) |
| **Rebalance** | ✓ PASS | All positions in range |
| **Trailing Stop** | ✓ PASS | Max PnL: +0.42% (trigger: +3%) |
| **Stop Loss** | ✓ PASS | Min PnL: +0.26% (threshold: -15%) |

### Summary

**Management Status:** `[AUTO]` Portfolio scan complete

- **Total open:** 2 positions (all healthy)
- **Actions executed:** 0
- **Pending alerts:** 0
- **Telegram notifications:** 0

**Profile:** Both positions deployed recently and accruing fees passively. All metrics within normal bounds. No immediate interventions required. Continue monitoring.

**Next cycle:** ~10 minutes


## 2026-07-02T13:22:59Z - Auto-Management Cycle (Cron)

### Open Positions: 2 / 10 max

1. Potato-SOL | Age: 29m | PnL: +0.45% | Fees: $0.00 | IN RANGE
2. FROGBULL-SOL | Age: 22m | PnL: +0.26% | Fees: $0.00 | IN RANGE

### Actions Pending

None. All positions healthy.

### Summary

Status: [SILENT] - No actions pending
Open positions: 2
Alerts sent: 0


## 2026-07-02T13:33:40Z — Auto-Management Cycle (Cron)

### Position Status
- **Open positions:** 1 / 10 max
- **Last scan:** 2026-07-02T13:33:40Z

### Current Open Position

**CHANCE-SOL** (2ZgNzUidf8EewTuagzRm9S1cg96ha6VriuwX5esHAfF8)
- Deployed: 3 minutes ago
- Peak PnL: +0.78%
- Fees claimed: $0.00 (below $5 threshold)
- Status: IN RANGE, fees accruing passively
- Action: HOLD — position healthy, fees still accumulating

### Action Items Evaluated

| Check | Status | Details |
|-------|--------|---------|
| **Claim Fees** | ✓ PASS | $0.00 claimed (threshold: $5) |
| **Rebalance** | ✓ PASS | Position in range |
| **Trailing Stop** | ✓ PASS | Peak PnL: +0.78% (trigger: +3%) |
| **Stop Loss** | ✓ PASS | Peak PnL: +0.78% (threshold: -15%) |

### Summary

**Management Status:** `[SILENT]` — No actions pending

- **Total open:** 1 position (healthy)
- **Actions executed:** 0
- **Pending alerts:** 0
- **Telegram notifications:** 0

**Profile:** CHANCE-SOL deployed 3 minutes ago, in range, accruing fees passively. All metrics within normal bounds. No interventions required.

**Next auto-management cycle:** ~10 minutes

