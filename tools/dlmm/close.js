/**
 * closePosition: claim → remove liquidity → close account, verify the position
 * actually disappeared on-chain, then settle final PnL from the Meteora
 * closed-positions API (with race/sanity gates) and record performance +
 * decision for the learning loop. Relay (zap-out) path first when enabled,
 * local SDK path otherwise.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { getConnection, getWallet, getPool, getPoolMetadata, evictPool, sendAndConfirmTransaction } from "./sdk.js";
import { signAndSimulateRelayTransactions, normalizeExecutionSignatures } from "./tx-safety.js";
import { safeNum, getClosedPnlValue, getClosedPnlPct, classifyExitSignal } from "./rules.js";
import { invalidatePositionsCache, getCachedPositions } from "./positions-cache.js";
import { getMyPositions, lookupPoolForPosition } from "./positions.js";
import { getTrackedPosition, recordClose } from "../../state.js";
import { recordPerformance } from "../../lessons.js";
import { appendDecision } from "../../decision-log.js";
import { normalizeMint } from "../wallet.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "../agent-meridian.js";
import { getAndClearStagedSignals } from "../../signal-tracker.js";

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

function resolvePerformanceSignalSnapshot({ poolAddress, baseMint, tracked }) {
  const staged = config.darwin?.enabled
    ? getAndClearStagedSignals(poolAddress, baseMint)
    : null;
  const snapshot = {
    ...(staged || {}),
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot.base_mint == null) snapshot.base_mint = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked?.[field] != null) {
      snapshot[field] = tracked[field];
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
      const pool = await getPool(poolAddress);
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: 5000,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      invalidatePositionsCache();

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      // recordClose() for the untracked case fires here immediately (no PnL to
      // compute without a tracked entry). The tracked case defers the call
      // until pnlPct is fully settled below — see the note there.
      if (!tracked) {
        recordClose(position_address, reason || "agent decision");
      }

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlTrueUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 12; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlTrueUsd = safeNum(posEntry.pnlUsd);
                pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : pnlTrueUsd;
                pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                // Retry until Meteora API settles the withdrawal aggregation — otherwise
                // it reports a near-zero withdrawal right after close, producing a bogus
                // -80%+ PnL for positions that actually broke even (race condition).
                if (finalValueUsd > 0 && finalValueUsd >= initialUsd * 0.5) break;
              }
            }
            if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
          // Sanity gate: if API still reports an extreme loss but on-chain IL was ~0
          // (price barely moved) and the withdrawal did settle, trust the settled delta
          // instead of the possibly-stale pnlUsd field.
          const ilPct = tracked?.il_pct ?? 0;
          if (pnlPct < -50 && Math.abs(ilPct) < 5 && finalValueUsd > 0) {
            const settledPnlUsd = finalValueUsd - initialUsd + feesUsd;
            const settledPct = initialUsd > 0 ? (settledPnlUsd / initialUsd) * 100 : 0;
            log("close_warn", `PnL sanity override for ${position_address.slice(0,8)}: API pnlPct=${pnlPct.toFixed(2)} but IL≈0 (${ilPct}) + withdrawal settled (${finalValueUsd} vs ${initialUsd}) → using settled ${settledPct.toFixed(2)}%`);
            pnlUsd = config.management.solMode ? settledPnlUsd / (tracked?.sol_price || 0) : settledPnlUsd;
            pnlPct = settledPct;
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        // recordClose() deliberately deferred until here (2026-07-12 fix) —
        // see the matching comment on the local-SDK close path below for why.
        recordClose(position_address, reason || "agent decision", { pnl_pct: pnlPct });

        const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
        const signalSnapshot = resolvePerformanceSignalSnapshot({
          poolAddress,
          baseMint: closeBaseMint,
          tracked,
        });

        let exitMarket = {};
        try {
          const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
          const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
          const ep = exitDetail?.data?.[0];
          if (ep) {
            exitMarket = {
              exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
              exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
              exit_volume: parseFloat(ep?.volume) || null,
            };
          }
        } catch { /* non-blocking */ }

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: closeBaseMint,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility ?? null,
          il_pct: tracked.il_pct ?? null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          signal_snapshot: signalSnapshot,
          entry_mcap: tracked.entry_mcap ?? null,
          entry_tvl: tracked.entry_tvl ?? null,
          entry_volume: tracked.entry_volume ?? null,
          entry_holders: tracked.entry_holders ?? null,
          ...exitMarket,
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        // Auto-swap base token if configured
        let autoSwapResult = null;
        if (config.management.autoSwapAfterClose && closeBaseMint && closeBaseMint !== config.tokens.SOL) {
          log("close_auto_swap", `Auto-swapping ${closeBaseMint.slice(0, 8)}... → SOL`);
          try {
            const { swapToken } = await import("../wallet.js");
            // Get balance of base token (estimate from position size)
            const estimatedBaseAmount = 100; // Placeholder — actual amount determined by position
            autoSwapResult = await swapToken({
              input_mint: closeBaseMint,
              output_mint: config.tokens.SOL,
              amount: estimatedBaseAmount,
            });
            if (autoSwapResult?.success) {
              log("close_auto_swap", `✓ Auto-swapped ${closeBaseMint.slice(0, 8)}... TX: ${autoSwapResult.tx.slice(0, 20)}...`);
            }
          } catch (swapErr) {
            log("close_auto_swap_warn", `Auto-swap failed: ${swapErr.message}`);
          }
        }

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: closeBaseMint,
          strategy: tracked.strategy,
          fees_usd: feesUsd,
          deployed_usd: initialUsd,
          deployed_sol: tracked.amount_sol,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          auto_swapped: autoSwapResult?.success || false,
          auto_swap_tx: autoSwapResult?.tx || null,
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      };
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    evictPool(poolAddress);
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    invalidatePositionsCache();

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    // recordClose() for the untracked case fires here immediately (no PnL to
    // compute without a tracked entry). The tracked case defers the call
    // until pnlPct is fully settled below — see the note there.
    if (!tracked) {
      recordClose(position_address, reason || "agent decision");
    }

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is
        // settling (2026-07-12 incident: a position held 16s briefly showed
        // +973.74%). Trust legitimate stop-loss disasters on the downside;
        // reject obviously-unsettled outliers in EITHER direction otherwise —
        // no real concentrated-LP position swings this hard this fast.
        if (stopLossTriggered) return false;
        return pct <= -90 || pct >= 200;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlValue = config.management.solMode ? getClosedPnlValue(posEntry, true) : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} ${config.management.solMode ? "SOL" : "USD"} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD, deposited=${initialUsd.toFixed(2)} USD`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = getCachedPositions()?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      // recordClose() deliberately deferred until here (2026-07-12 fix): pnlPct
      // is now fully settled (API, or the cache fallback, or the 0-default worst
      // case) — passing it as an override means closedOutcomes[] always agrees
      // with what lessons.json/recordPerformance below record, instead of
      // potentially using a stale/phantom pos.pnl_pct live-tick value. The
      // in-flight close guard (markPositionClosing/_closingInFlight, set by
      // executor.js around the whole close_position tool call) already prevents
      // any external-close race during this window regardless of exactly when
      // within this function recordClose fires.
      recordClose(position_address, reason || "agent decision", { pnl_pct: pnlPct });

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      let exitMarket = {};
      try {
        const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
        const ep = exitDetail?.data?.[0];
        if (ep) {
          exitMarket = {
            exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
            exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
            exit_volume: parseFloat(ep?.volume) || null,
          };
        }
      } catch { /* non-blocking */ }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        il_pct: tracked.il_pct ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        ...exitMarket,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
          exit_signal_type: classifyExitSignal(reason),
          minutes_oor: minutesOOR,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        fees_usd: feesUsd,
        deployed_usd: initialUsd,
        deployed_sol: tracked.amount_sol,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}
