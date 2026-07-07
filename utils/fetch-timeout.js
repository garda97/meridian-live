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
