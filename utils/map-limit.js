/**
 * Bounded-concurrency async map — one place to set how wide any fan-out runs.
 *
 * Screening had four different fan-out policies (serial + sleep(150) in the
 * enrich loop, serial in the GMGN loop, unbounded Promise.all in
 * resolveDeployPlansForCandidates, unbounded Promise.allSettled for
 * getActiveBin). Serial loops pay 15x the slowest API call for work that has no
 * ordering dependency; unbounded ones burst the whole batch at the provider.
 *
 * Semantics:
 *   - Results are index-aligned with the input. Callers index candidate arrays
 *     positionally (screening-cycle.js builds blocks by `i`), so order is not
 *     negotiable.
 *   - Never rejects. Returns Promise.allSettled shape so one bad token can't
 *     abort a whole screening cycle.
 *   - `spacingMs` throttles the rate tasks *start* at, which is what the old
 *     sleep(150) was really doing. Concurrency caps in-flight requests; spacing
 *     caps requests per second. A token-bucket API limiter cares about the
 *     latter, so they are separate knobs.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Iterable} items
 * @param {number} limit      Max tasks in flight. Clamped to [1, items.length].
 * @param {(item: any, index: number) => Promise<any>} fn
 * @param {{ spacingMs?: number }} [options]
 * @returns {Promise<Array<{status: "fulfilled", value: any} | {status: "rejected", reason: any}>>}
 */
export async function mapLimit(items, limit, fn, { spacingMs = 0 } = {}) {
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const parsedLimit = Math.floor(Number(limit));
  const workers = Math.min(
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1,
    list.length,
  );
  const spacing = Number.isFinite(Number(spacingMs)) && spacingMs > 0 ? Number(spacingMs) : 0;

  let cursor = 0;
  // Shared launch clock. Claimed synchronously before awaiting, so two workers
  // can never be handed the same slot.
  let nextStart = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;

      if (spacing > 0) {
        const now = Date.now();
        const wait = Math.max(0, nextStart - now);
        nextStart = Math.max(now, nextStart) + spacing;
        if (wait > 0) await sleep(wait);
      }

      try {
        results[index] = { status: "fulfilled", value: await fn(list[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Unwrap mapLimit/allSettled results to plain values, substituting `fallback`
 * for anything that rejected — the `.catch(() => null)` shape most callers want.
 */
export function settledValues(results, fallback = null) {
  return results.map((r) => (r?.status === "fulfilled" ? r.value : fallback));
}
