/**
 * Regression test for the GMGN request pacer (no network).
 *
 * The pacer used to read a "last request" stamp, sleep, then write the stamp
 * after the await. Concurrent callers therefore all observed the same value,
 * slept the same amount and fired together — the delay collapsed exactly when
 * it mattered. Screening reaches GMGN through getTokenInfo, so the parallel
 * enrich loop (screening-cycle.js) now drives this path.
 *
 * Run: node test/test-gmgn-pacer.js
 */

import { paceGmgnRequest } from "../tools/gmgn.js";
import { config } from "../config.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const DELAY = 40;
config.gmgn.requestDelayMs = DELAY;

// Concurrent callers must still be spaced. This is the case the old pacer failed:
// all five would resolve at roughly the same instant.
{
  const t0 = Date.now();
  const starts = await Promise.all(
    Array.from({ length: 5 }, async () => {
      await paceGmgnRequest();
      return Date.now() - t0;
    }),
  );
  starts.sort((a, b) => a - b);

  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    assert(
      gap >= DELAY * 0.7,
      `concurrent callers must stay spaced: gap ${gap}ms between request ${i} and ${i + 1} (delay ${DELAY}ms)`,
    );
  }
  const span = starts[starts.length - 1] - starts[0];
  assert(span >= DELAY * 3.4, `5 paced calls must span ~4 delays, got ${span}ms`);
}

// Sequential callers that already waited out the delay must not sleep again.
{
  await paceGmgnRequest();
  await new Promise((r) => setTimeout(r, DELAY * 2));
  const t0 = Date.now();
  await paceGmgnRequest();
  const waited = Date.now() - t0;
  assert(waited < DELAY * 0.5, `an idle pacer must not delay, waited ${waited}ms`);
}

// Delay of 0 disables pacing entirely.
{
  config.gmgn.requestDelayMs = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 10 }, () => paceGmgnRequest()));
  const elapsed = Date.now() - t0;
  assert(elapsed < 20, `requestDelayMs=0 must not pace, took ${elapsed}ms`);
}

console.log("  gmgn-pacer: concurrent spacing/idle-passthrough/disabled OK");
console.log("test-gmgn-pacer: OK");
