# Dust-token limit-order fallback — research notes

**Date:** 2026-07-09
**Status:** Design research only — NOT wired into `executor.js`. Do not enable without a devnet/small-size live test first.

## Problem

`swapBaseToSolWithRetry()` (`tools/executor.js:698`) gives up after `autoSwapRetryAttempts` (default 3) if Jupiter has no route for an illiquid base token left over from closing an OOR pump.fun-style position. It logs `"base token left unsold"` and the dust sits in the wallet permanently (recurring failure mode, see `[[meridian-project]]` memory / decision-log entries).

## Why the SDK bump (1.9.4 → 1.9.11) doesn't fully fix this

Version 1.9.8 added native DLMM limit orders (`placeLimitOrder`, `cancelLimitOrder`, `closeLimitOrderIfEmpty`) — these place a sell order directly into the same DLMM pool the position was in, bypassing Jupiter routing entirely. This is the most direct fix available for the dust problem, since the pool that just held our LP position is guaranteed to exist (Jupiter's lack of a route is usually a *routing/liquidity-aggregation* gap, not proof the pool itself has zero liquidity).

**However**, this is a genuinely new, low-level, real-money-moving API surface, and I could not verify a working end-to-end usage example anywhere public (checked `MeteoraAg/dlmm-sdk` repo — no `ts-client/src/examples/*limit*`, no test fixtures under `cli/` for it in JS form; checked docs.meteora.ag and web search — no code sample, only prose describing the feature). Rolling untested transaction-building code into a bot with live capital is not something to do on a guess.

## What's confirmed from reading the SDK source directly (`ts-client/src/dlmm/index.ts:8073-8225`)

```ts
public async placeLimitOrder({
  owner, payer, sender, limitOrder, params,
}: {
  owner: PublicKey; payer: PublicKey; sender: PublicKey;
  limitOrder: PublicKey;                                   // account for the order — NOT confirmed whether PDA or fresh Keypair
  params: Omit<PlaceLimitOrderParams, "padding">;           // { isAskSide, bins: [{id, amount}], relativeBin? }
}): Promise<Transaction>
```

- `params.bins[].id` — bin id, relative to current active bin if `relativeBin` is set, else absolute.
- `params.isAskSide` — true = selling tokenX (our dust) for tokenY; matches our use case (dumping base token for SOL) if tokenX is the base/meme token in that pool's pair ordering — **needs per-pool verification, tokenX/Y ordering isn't fixed to base/SOL**.
- SDK auto-creates bin arrays and the bitmap extension if needed (`createBinArraysIfNeeded`).
- `cancelLimitOrder` and `closeLimitOrderIfEmpty` exist for unwinding an order that didn't fill.

## Open questions before this can be implemented safely

1. Is `limitOrder` a PDA derivable from `(lbPair, owner, nonce)`, or a throwaway `Keypair.generate()` account the caller must fund and track in our own state? Determines whether we need a new `dustLimitOrder_<mint>` entry in `state.json` to remember it across daemon restarts (so we can cancel/reclaim if unfilled).
2. Which side (`tokenX`/`tokenY`) our dust mint sits on per-pool — needs a `pool.tokenX.mint === baseMint` check per position before setting `isAskSide`.
2. Pricing: what bin/price to place the order at — presumably at or slightly above the current active bin (best current bid), but that needs a real strategy decision (accept partial fills over time vs. never fill).
4. Timeout/cancellation policy: if unfilled after N hours, cancel and reclaim rent, or leave it open indefinitely?

## Recommended next step (not done in this session)

Before wiring into `executor.js`, do a small isolated spike against a real dust position on a testnet/small-size pool: call `getLimitOrder`/`getLimitOrderByUserAndLbPair` (read-only, already in the SDK, `index.ts:2393-2490`) against a known pool to confirm the `limitOrder` key shape by observing an order placed manually via Meteora's own UI (if they've shipped a UI for it) — that sidesteps guessing the PDA derivation.

If wired in later, gate it behind a new opt-in config flag (matching existing pattern of `tvlDilutionExit`/`tgeOverride` style opt-in gates) — e.g. `dustLimitOrderFallback: false` default off — and only trigger it from `swapBaseToSolWithRetry()` after Jupiter retries are exhausted, passing through the pool address (already available at the `close_position` call site in `executor.js:823` as `result.pool` / `args.pool_address`).
