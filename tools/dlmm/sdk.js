/**
 * DLMM SDK plumbing: lazy Meteora SDK loader, wallet/connection init,
 * Jito-aware transaction submission, and the pool/pool-metadata caches.
 * Everything on-chain in tools/dlmm/* goes through this module.
 */
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction as sendAndConfirmTransaction_original,
} from "@solana/web3.js";
import bs58 from "bs58";
import { sendJitoBundle } from "../jito-helper.js";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { getRpcConnection } from "../../utils/rpc-connection.js";

/** True when a submitted tx missed its last-valid block height window. */
export function isSignatureExpiredError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("block height exceeded")
    || msg.includes("signature expired")
    || msg.includes("blockhash not found")
    || (msg.includes("expired") && msg.includes("signature"))
  );
}

/** Refresh legacy Transaction blockhash immediately before send (Meteora chunk txs share one stale hash). */
export async function refreshLegacyTransactionBlockhash(connection, transaction, feePayer) {
  if (!(transaction instanceof Transaction)) return false;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = feePayer;
  return true;
}

// Jito wrapper: route transactions through Jito if enabled, fallback to standard RPC
export async function sendAndConfirmTransaction(connection, transaction, signers, options = {}) {
  if (config.jito?.enabled) {
    try {
      log("jito", "Attempting Jito bundle submission for this transaction...");
      const bundleId = await sendJitoBundle(connection, transaction, signers, log);
      log("jito_success", `Transaction routed through Jito bundle: ${bundleId}`);
      return bundleId;
    } catch (jitoErr) {
      log("jito_warn", `Jito submission failed (${jitoErr.message}), falling back to standard RPC`);
    }
  }

  const maxRetries = options.maxRetries ?? 3;
  const feePayer = signers[0]?.publicKey;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (feePayer) {
        await refreshLegacyTransactionBlockhash(connection, transaction, feePayer);
      }
      return await sendAndConfirmTransaction_original(connection, transaction, signers, {
        commitment: "confirmed",
        ...options,
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1 && isSignatureExpiredError(err)) {
        log("tx_retry", `Blockhash expired — refresh and retry (${attempt + 2}/${maxRetries})`);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("sendAndConfirmTransaction failed");
}

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;

export async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _wallet = null;

export function getConnection() {
  return getRpcConnection();
}

export function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

export function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

export async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

/** Drop one pool from the cache so the next getPool loads fresh on-chain state. */
export function evictPool(poolAddress) {
  poolCache.delete(String(poolAddress));
}

// unref: these cache sweeps must not keep one-shot processes (cli.js, tests) alive
setInterval(() => poolCache.clear(), 5 * 60 * 1000).unref();
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000).unref();

export async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}
