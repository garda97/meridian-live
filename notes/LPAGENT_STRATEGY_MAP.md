# LP Agent + Meteora strategy map (research 2026-07-10)

Sources: docs.lpagent.io (features, tutorials, copy-lp best practices), Meteora DLMM docs (Spot/Curve/BidAsk), on-chain sample wallet 5Rc6Ngq…

## Shape primer (Meteora DLMM)

| Shape | Distribution | Best when | Risk |
|-------|--------------|-----------|------|
| **Spot** | Uniform across range | Sideways / uncertain direction | Balanced IL + fees |
| **Curve** | Mass near active (middle) | Mean-reverting, price sticky | High fee if stays; dies if moves |
| **BidAsk** | Mass at **edges** (inverse curve) | Expecting oscillation / two-way flow | Needs rebalance if one-way trend |

**One-sided SOL BidAsk (below price)** = “safest meme farm” style: mostly SOL, harvest sell-flow, less bag risk.

LP Agent API strategies: `Spot` | `Curve` | `BidAsk` (+ zap-in from SOL).

---

## Strategy by market regime

### 1) High-vol meme / trench (pump.fun meta)
**Goal:** fee velocity > IL, short hold  
**Shape:** BidAsk, SOL-only below (or thin above)  
**Range:** tight–medium (≈60–100 bins @ step 80–125)  
**Hold:** minutes–tens of minutes (LP Agent gacor wallets ~3–20m; Meridian safe floor 20–30m)  
**Exit:** LOW_YIELD, OOR, hard max hold, dust SL  
**Entry filters:** quote=SOL, mcap band, organic ≥50, fee/TVL hot **and** still printing  
**Meridian now:** bid_ask + SAFE bins 50/80/100 + yieldAge 30 — align  
**Avoid:** 200-bin park, fee=0 hold 45m+

### 2) One-way dump / breakdown
**Goal:** stay in SOL, catch bounce fees if any  
**Shape:** BidAsk max below; bins_above=0  
**Range:** wider than scalp (≈100 bins) so reseed less often  
**Exit:** if fully OOR long / IL gap / regime still dump  
**Meridian:** autoStrategy already reseed_below on supertrend break — **don’t thrash <5–10m after open**

### 3) One-way pump / FOMO
**Goal:** don’t chase IL into moonbag  
**Shape:** prefer skip or BidAsk very thin; if enter, more below for fade  
**Gate:** maxPumpPct1h (Meridian has this)  
**Exit:** OOR upside / trailing if any token side  
**Avoid:** Curve/Spot centered = eats IL on continuation

### 4) Sideways / mid-cap grind
**Goal:** consistent fee, fewer rebalances  
**Shape:** **Spot** balanced or slightly SOL-heavy  
**Range:** wider (docs: ~30–70 bins each side for tutorial Spot; Meridian can allowSpot later)  
**Hold:** hours–day  
**Compound:** claim fee → re-deposit when uncollected ≥ threshold (LP Agent compound bot: default $1 fee, Spot re-deposit)  
**Meridian:** autoStrategyAllowSpot=false now — enable only with tight OOR risk

### 5) Stable / low-vol (SOL-stable, high liquidity)
**Goal:** capital efficiency without meme chaos  
**Shape:** Curve or tight Spot  
**Range:** tight, rebalance on OOR  
**Size:** can be larger fraction  
**Not Meridian primary** (meta is meme)

### 6) Phoenix / post-crash re-pump
**Goal:** early floor LP if SM re-enters  
**Shape:** BidAsk below after capitulation; widen if vol still high  
**Filters:** CPO if concentration high but SM clean; age + narrative  
**Risk:** dead cat — small size, short max hold

### 7) Copy-LP style (LP Agent product)
**Not pure mirror for Meridian** (owner = signalling only)  
LP Agent best practices if ever used:
- Min mcap ~3–5M, Jupiter organic ≥50  
- Source avg hold **>20m** (avoid pure snipers)  
- SL **~15%**, start 1–5% capital  
- Own TP/SL can fire **before** leader closes  

---

## LP Agent product toolkit (what they optimize)

| Tool | Use |
|------|-----|
| AI suggestions | Risk level + token/pool prompt → range, size, fee tier, rebalance triggers |
| Auto-rebalance | OOR → zap-out SOL → zap-in re-centered (check 60s; gas 0.01–0.03 SOL) |
| Dynamic bin range | vol high → wider; stable → tighter (tutorial: binStep>5 → 20 else 50) |
| TP / SL / trailing | Multi-level TP, trailing SL, TWAP/oracle/DEX triggers |
| Auto-compound | Claim fees → reinvest; min threshold + gas-aware |
| Copy LP | % size, max amount, own TP/SL |
| PnL method | T1→T2 (in-position only); real wallet PnL needs T0/T3 swaps |

Fee: **8% of claimed fees** only (no open/close LP Agent fee).

---

## Map → Meridian knobs

| Regime | Meridian action |
|--------|-----------------|
| Trench high fee | bid_ask SOL, bins ≤100, yieldAge 30, maxPos 2, size 0.5 |
| Breakdown | reseed_below OK with cooldown after open |
| Pump chase | keep maxPumpPct1h; prefer skip |
| Sideways | future: allowSpot high fee/TVL only |
| Dead fee | LOW_YIELD — already |
| Copy wallets | signalling discovery only, own gates |

## Phase-2 ideas (not applied)
1. Regime classifier → pick Spot vs BidAsk  
2. Rebalance cooldown 5–10m post-open  
3. Fee-velocity entry (not only 24h fee/TVL)  
4. Compound cycle when unclaimed > $X  
5. Optional max-hold 20–30m on degen pools only
