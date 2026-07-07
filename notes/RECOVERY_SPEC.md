# Recovery Strat — Implementation Spec (for Grok)

**Source:** @met_lparmy / @Heavymetalcook6 "Recovery Strat"
**Owner decision:** Integrate into daemon + flag `autoRecovery` (default OFF).
**Safety:** Must obey daemon guards (maxPositions, dailyLossLimitUsd, deploy window, repeatDeployCooldown).

## Config (DONE by Hermes)
- `config.management.autoRecovery: false` (default off, owner opt-in)
- `config.management.autoRecoveryBinsBelow: 100` (bins below original lower bound)

## Required daemon logic (Grok to implement in index.js management cycle)
Function `maybeAutoRecovery(positions, ctx)` called AFTER rebalance/close actions,
BEFORE screening trigger (around index.js:438 where `afterCount < maxPositions` gates screening):

1. If `!config.management.autoRecovery` → return (no-op).
2. Gather open positions with `out_of_range_since` set AND price below active bin range
   (i.e. OOR to the LOWER side — recovery only makes sense there).
3. For each candidate, validate guards:
   - `afterCount + recoveryCount < config.risk.maxPositions`
   - `!dailyLoss.blocked` (reuse `checkDailyLossGate` like screening does)
   - `isWithinDeployWindow(now, schedule)` true
   - token still alive: `entry_mcap > 0 && entry_tvl > 0` (not total rug)
   - `repeatDeployCooldown` not blocking same token (reuse existing cooldown check)
4. If guards pass → open recovery bid-ask position BELOW original range:
   - bin_range = [orig_min - autoRecoveryBinsBelow, orig_min]
   - strategy = bid_ask (same as original)
   - amount = config.management.deployAmountSol
   - Use SAME deploy path as screening (so it's tracked + guarded), NOT a raw RPC call.
5. Log via `appendDecision({type:'deploy', actor:'RECOVERY', ...})` + Telegram notify
   (reuse `notifyDeploy` / closeNotify-style alert).
6. Mark position so we don't re-propose (track recovery child in state.json, e.g.
   `p.recovery_of = parent_pid`).

## Key constraint
Recovery MUST go through the daemon's existing deploy flow (agent/LLM or
`executeTool('deploy_position', ...)` with proper context), NOT a standalone
RPC. This ensures maxPositions/dailyLoss/cooldown are all respected.

## Testing
- Enable `autoRecovery: true` in DRY_RUN mode first (`DRY_RUN=true`).
- Confirm: no deploy when no OOR positions; deploy attempt logged when OOR-below exists.
- Then live with `autoRecovery: false` (owner flips to true after review).

## Files
- config.js: autoRecovery + autoRecoveryBinsBelow (DONE)
- index.js: maybeAutoRecovery() (Grok)
- scripts/recovery_manager.py: manual fallback (DONE, dry-run proposal)
