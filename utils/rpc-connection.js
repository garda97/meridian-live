import { Connection } from "@solana/web3.js";
import {
  buildHeliusRpcUrl,
  getCurrentHeliusKey,
  getHeliusKeys,
  rotateHeliusKey,
  shouldRotateHeliusError,
  markHeliusSuccess,
} from "./helius-rotator.js";
import { log } from "../logger.js";

let _connection = null;
let _connectionKey = null;

export function invalidateRpcConnection() {
  _connection = null;
  _connectionKey = null;
}

export function getRpcConnection() {
  const key = getCurrentHeliusKey();
  if (_connection && _connectionKey === key) return _connection;
  _connectionKey = key;
  _connection = new Connection(buildHeliusRpcUrl(key), "confirmed");
  return _connection;
}

export async function withHeliusRpcRetry(fn, { maxAttempts } = {}) {
  const keys = getHeliusKeys();
  const attempts = maxAttempts ?? keys.length;
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    const key = getCurrentHeliusKey();
    try {
      const result = await fn(getRpcConnection(), key);
      markHeliusSuccess(key);
      return result;
    } catch (err) {
      lastError = err;
      if (shouldRotateHeliusError(err)) {
        rotateHeliusKey(err.message);
        invalidateRpcConnection();
        log("helius_rpc_retry", `rotate after RPC error: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("RPC failed after Helius key rotation");
}