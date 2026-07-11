/**
 * fetch() with a hard timeout via AbortController. Plain fetch() has no
 * default timeout — a hung connection (server accepts the TCP handshake but
 * never responds) waits forever, which previously stalled whole screening
 * cycles on a single unresponsive external API call (GMGN, Jupiter DATAPI).
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap any promise (e.g. an SDK RPC call that has no built-in timeout) so it
 * rejects after `timeoutMs` instead of hanging forever. A hung on-chain RPC
 * read (getProgramAccounts on a slow Helius endpoint) otherwise stalls the
 * whole management cycle — the try/catch fallback only catches errors, not
 * hangs, so without this the position poller can wedge until the watchdog
 * force-resets it minutes later. On timeout the dangling promise is left to
 * settle unheard (a raw promise can't be cancelled); the caller unblocks.
 */
export function withTimeout(promise, timeoutMs, label = "operation") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
