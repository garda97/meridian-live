/**
 * Unit tests for bounded-concurrency mapLimit (no network).
 * Run: node test/test-map-limit.js
 */

import { mapLimit, settledValues } from "../utils/map-limit.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Results stay index-aligned even when tasks finish out of order.
{
  const items = [50, 10, 30, 5, 40, 1];
  const out = await mapLimit(items, 3, async (n) => {
    await sleep(n);
    return n * 2;
  });
  assert(out.length === items.length, "length must match input");
  assert(out.every((r) => r.status === "fulfilled"), "all must be fulfilled");
  assert(
    settledValues(out).join(",") === items.map((n) => n * 2).join(","),
    "results must be index-aligned with input, not completion order",
  );
}

// Concurrency never exceeds the limit, and is actually used.
{
  let active = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(15);
    active -= 1;
  });
  assert(peak <= 4, `peak concurrency ${peak} must not exceed limit 4`);
  assert(peak === 4, `peak concurrency ${peak} must actually reach limit 4`);
}

// A rejecting task must not abort its neighbours.
{
  const out = await mapLimit([1, 2, 3, 4], 2, async (n) => {
    if (n % 2 === 0) throw new Error(`boom ${n}`);
    return n;
  });
  assert(out[0].status === "fulfilled" && out[0].value === 1, "odd items must resolve");
  assert(out[1].status === "rejected", "even items must be captured as rejected");
  assert(out[1].reason.message === "boom 2", "rejection reason must be preserved");
  assert(out[2].status === "fulfilled" && out[2].value === 3, "later items must still run");
  assert(
    settledValues(out, "x").join(",") === "1,x,3,x",
    "settledValues must substitute the fallback",
  );
}

// Synchronous throws are captured too.
{
  const out = await mapLimit([1], 1, () => { throw new Error("sync"); });
  assert(out[0].status === "rejected", "sync throw must be captured, not propagated");
}

// Bounded concurrency must beat serial on the same workload.
{
  const items = Array.from({ length: 12 }, () => 30);
  const started = Date.now();
  await mapLimit(items, 6, async (ms) => sleep(ms));
  const elapsed = Date.now() - started;
  assert(elapsed < 12 * 30 * 0.6, `12x30ms at limit 6 took ${elapsed}ms — not parallel`);
}

// spacingMs paces task starts independently of concurrency.
{
  const starts = [];
  await mapLimit(Array.from({ length: 5 }, (_, i) => i), 5, async () => {
    starts.push(Date.now());
    await sleep(1);
  }, { spacingMs: 20 });
  const span = starts[starts.length - 1] - starts[0];
  // 5 tasks at 20ms spacing => ~80ms between first and last start.
  assert(span >= 70, `spacing not applied: first->last start span was ${span}ms`);
}

// Degenerate inputs.
{
  assert((await mapLimit([], 5, async () => 1)).length === 0, "empty input must return []");
  assert((await mapLimit(null, 5, async () => 1)).length === 0, "null input must return []");

  let peak = 0;
  let active = 0;
  const track = async () => {
    active += 1; peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
  };
  await mapLimit([1, 2, 3], 0, track);
  assert(peak === 1, `limit 0 must clamp to 1, saw ${peak}`);

  peak = 0;
  await mapLimit([1, 2, 3], NaN, track);
  assert(peak === 1, `NaN limit must clamp to 1, saw ${peak}`);

  peak = 0;
  await mapLimit([1, 2, 3], 99, track);
  assert(peak === 3, `limit above length must clamp to length, saw ${peak}`);
}

// Non-array iterables.
{
  const out = await mapLimit(new Set([1, 2, 3]), 2, async (n) => n + 1);
  assert(settledValues(out).join(",") === "2,3,4", "must accept any iterable");
}

console.log("  map-limit: order/concurrency/rejection/spacing/clamping/iterable OK");
console.log("test-map-limit: OK");
