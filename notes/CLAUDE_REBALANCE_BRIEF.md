# Claude Brief — Auto Re-Analyze + Rebalance (POWER MODE)

_Updated: 2026-07-04 | Author: Grok | Daemon: **STOP before implement**_

## Konteks live

| Item | Value |
|------|-------|
| Wallet | ~1.38 SOL |
| Positions | 0 (post SEMAN deploy tool-name fix) |
| Latest commit | `d5f1466` (Compat tool sanitize) |
| `autoStrategyEnabled` | true — entry analysis sudah jalan |
| `outOfRangeWaitMinutes` | 30 → saat ini OOR = **CLOSE**, bukan rebalance |
| `minVolumeToRebalance` | 1000 — **config ada, TIDAK dipakai di kode** |
| `rebalance_count` | field di state.json — **tidak pernah di-increment** |
| `addLiquidity` / `withdrawLiquidity` | **cli.js import dari dlmm.js tapi fungsi BELUM ADA** |

**Owner request:** "yang paling powerful" — full auto re-analyze kondisi koin saat posisi terbuka + reposition tanpa nunggu close manual.

**Referensi:**
- `tools/strategy-router.js` — classifyMarketView, buildDeployPlan, computeOorRisk (ENTRY)
- `.claude/commands/manage.md` — single_sided_reseed, fee_compounding patterns
- `strategy-library.js` — default strategy definitions
- `notes/METEORA_LP.md` §Zap In / Rebalance — DCA in/out tanpa tutup LP
- FABLE lesson — pump OOR atas karena bid_ask 0% upside → rebalance harus convert ke spot

---

## Goal

Bot harus bisa **re-analisa kondisi koin setiap management tick** dan **geser/re-seed posisi** otomatis — bukan cuma hold/close.

```
OPEN POSITION
    ↓
fetch pool metrics + chart 15m (reuse strategy-router)
    ↓
classifyMarketView (live)
    ↓
buildRebalancePlan (NEW — mirror buildDeployPlan tapi aware posisi existing)
    ↓
shouldRebalance (NEW — pure, testable)
    ↓
rebalancePosition() on-chain OR fall through ke close rules
```

**Prioritas aksi saat OOR:**
1. Rebalance (jika gate pass) — **SEBELUM** rule 4 close
2. Close (existing SL/trailing/chart/OOR 30m)

---

## Arsitektur (POWER MODE)

### PR-R1 — `tools/position-router.js` (NEW)

Pure decision engine. Reuse exports dari `strategy-router.js` where possible — **jangan duplikasi matrix**.

```js
export function buildRebalancePlan({ pool, tokenInfo, position, signal, currentStrategy })
export function shouldRebalance({ plan, position, positionData, mgmtConfig, tracked })
export async function resolveRebalancePlanForPosition({ pool, position, tokenInfo })
```

**Input position-aware:**
- `active_bin`, `lower_bin`, `upper_bin`, `in_range`, `minutes_out_of_range`
- `pnl_pct`, `fee_per_tvl_24h`, `unclaimed_fees_usd`
- `strategy` at deploy vs recommended strategy
- OOR direction: upside (`active_bin > upper_bin`) vs downside (`active_bin < lower_bin`)

**Output plan:**
```js
{
  action: "hold" | "rebalance" | "close",
  market_view, view_reason,
  rebalance_type: "shift_up" | "shift_down" | "widen_spot" | "convert_to_spot" | "reseed_below",
  strategy, bins_below, bins_above, deposit_side,
  oor_risk, upside_cover_pct,
  reason, notes[]
}
```

**Decision matrix (POWER — implement semua):**

| Kondisi | OOR | market_view | Aksi |
|---------|-----|-------------|------|
| Pump lanjut, harga di atas range, PnL > 0, volume OK | upside | pump | `shift_up` / `widen_spot` — spot balanced, tambah upside cover (FABLE fix mid-flight) |
| Dump ke bawah range, volume ≥ minVolumeToRebalance | downside | breakdown/retracement | `reseed_below` — bid_ask SOL-below wide, fib bins |
| Dump ke bawah, volume mati | downside | any | **close** (token dead) |
| Sideways, in-range tapi strategy drift (was bid_ask, now sideways) | in | sideways | `convert_to_spot` — 75/25 tanpa close account |
| Breakdown ST bearish, PnL > -8% | any | breakdown | `reseed_below` wide OR close jika sudah max rebalance |
| Flat low vol, in-range | in | flat | hold (curve disabled) |
| PnL ≤ stopLoss proximity (-8% soft) | any | any | **close** — jangan rebalance into knife |
| oor_risk re-plan > maxOorRisk | any | any | **close** — same gate as entry |

**Reuse:**
- `classifyMarketView`, `computeOorRisk`, `volatilityScaledBins`, `inferFibBins`
- `applyPumpUpsideCoverGate` logic untuk re-plan

### PR-R2 — `tools/dlmm.js` — on-chain rebalance (NEW)

Implement fungsi yang **cli.js sudah expect** tapi belum ada:

```js
export async function withdrawLiquidity({ position_address, pool_address, bps, claim_fees })
export async function addLiquidity({ position_address, pool_address, amount_x, amount_y, strategy, bins_below, bins_above, single_sided_x })
export async function rebalancePosition({ position_address, plan, reason })
```

**`rebalancePosition` flow (same position account — jangan close+redeploy baru):**
1. `pool.refetchStates()` + fresh `active_bin` (P0 lesson 0x1774)
2. Claim fees if unclaimed > $0.50 (murah, realize earnings)
3. `removeLiquidity` 100% (`shouldClaimAndClose: false`) — position account stays
4. `addLiquidityByStrategy` / `addLiquidityByStrategyChunkable` at NEW range from plan
5. Retry ladder `planBinSlippageRetry` on 0x1774 (reuse existing pure function)
6. Update state: `rebalance_count++`, `last_rebalance_at`, `strategy`, `bin_range`, reset `out_of_range_since`, `peak_pnl_pct` optional keep
7. `appendDecision` type=`rebalance`, metrics: `rebalance_type`, `oor_risk`, `market_view`, `bins_used`

**Wide range:** if total bins > 69, use existing wide-path chunkable logic from deploy.

**Wallet constraint:** SOL-only wallet — `amount_x=0`, deposit via `amount_y` unless reseed needs token from wallet (skip token-only reseed if wallet has 0 token; log reason).

### PR-R3 — Wiring `index.js` management + PnL poller

**Management cycle** (`runManagementCycle`):
- After exit checks, BEFORE `getDeterministicCloseRule` rule 4 OOR close:
  - If `config.management.autoRebalanceEnabled` (default **true**):
    - `resolveRebalancePlanForPosition` per open position
    - `shouldRebalance` → action `REBALANCE`
- `executeManagementActions`: handle `REBALANCE` mechanically (no LLM) like CLOSE/CLAIM
- Priority order per position:
  1. Hard exit (SL/trailing/chart) — unchanged
  2. **REBALANCE** (new)
  3. Instruction → LLM
  4. Deterministic close rules
  5. Claim
  6. STAY

**PnL poller (3s):**
- OOR detected ≥ `rebalanceMinOorMinutes` (default **5**) → attempt rebalance BEFORE waiting full 30m close
- One rebalance per tick (like partial TP)
- `registerExitSignal` unchanged — rebalance does NOT compete with confirmed exit

### PR-R4 — Config + CONFIG_MAP

New keys (`config.js` + `user-config.example.json` + `tools/executor.js` CONFIG_MAP):

| Key | Default | Notes |
|-----|---------|-------|
| `autoRebalanceEnabled` | `true` | Master switch |
| `rebalanceMinOorMinutes` | `5` | Min OOR before rebalance attempt |
| `rebalanceMaxPerPosition` | `3` | After 3 → fall through to close |
| `rebalanceCooldownMinutes` | `15` | Between rebalances same position |
| `rebalanceMinPnlPct` | `-8` | Below this → close not rebalance |
| `minVolumeToRebalance` | `1000` | **WIRE existing key** — pool volume_window |
| `rebalanceOnStrategyDrift` | `true` | In-range convert bid_ask→spot |

**JANGAN ubah `user-config.json`** — Grok apply setelah review.

### PR-R5 — State + observability

`state.js`:
```js
recordRebalance(position_address, { plan, tx_hashes })
// fields: rebalance_count, last_rebalance_at, market_view_at_deploy, market_view_last
```

`decision-log.json`:
- `type: "rebalance"`
- `metrics.rebalance_type`, `rebalance_count`, `oor_risk`, `market_view`, `oor_direction`

Telegram (optional): notify on rebalance if `rebalanceNotify` default false.

### PR-R6 — Executor tool

`tools/definitions.js` + `tools/executor.js`:
```js
rebalance_position({ position_address, reason? })
// calls resolveRebalancePlan + rebalancePosition; for manual/agent use
```

### PR-R7 — Tests (mandatory)

`test/test-rebalance.js` (NEW):
- `shouldRebalance`: upside pump + volume → shift_up
- downside + dead volume → close not rebalance
- max rebalance_count → close
- cooldown active → hold
- pnl below rebalanceMinPnlPct → close
- strategy drift sideways → convert_to_spot
- oor_risk too high → close

`test/test-rebalance-plan.js` or section in strategy-matrix:
- buildRebalancePlan mirrors entry matrix for same inputs

Regression: all existing suites pass.

---

## Constraints (HARD)

1. **JANGAN** ubah `user-config.json`
2. **JANGAN** start/restart daemon — Grok handles after review
3. **JANGAN** longgarkan security screening filters
4. **JANGAN** break existing exit path (SL/trailing/partial TP/chart exit)
5. Rebalance **fail-open to close** — if on-chain rebalance fails 3x, log + let OOR close rule handle
6. DRY_RUN must work for all new functions
7. Atomic writes for state (use existing `atomicWriteFileSync`)

---

## Acceptance criteria

- [ ] OOR downside + volume alive → auto reseed (not wait 30m close)
- [ ] OOR upside + pump view → widen/spot shift (FABLE pattern prevented retroactively)
- [ ] In-range strategy drift → convert without close
- [ ] `minVolumeToRebalance` actually gates rebalance
- [ ] `rebalance_count` increments, max 3 then close
- [ ] decision-log has rebalance entries with full metrics
- [ ] cli.js `withdraw-liquidity` / `add-liquidity` work
- [ ] 10+ new unit tests pass + full `npm run test:syntax`
- [ ] Handoff back to Grok: verdict SAFE/FIX + enable steps

---

## Out of scope (defer)

- Multi-layer composite rebalance (strategy-library multi_layer)
- Token-only reseed when wallet holds 0 base token
- LLM-driven rebalance decisions (all deterministic)
- GIMI integration

---

## Verify before handoff

```bash
node test/test-rebalance.js
node test/test-strategy-matrix.js
node test/test-partial-tp.js
npm run test:syntax
node --check tools/position-router.js tools/dlmm.js index.js state.js
```