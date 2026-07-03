/**
 * Unit tests for the time-of-day deploy gate (pure function, no network).
 * Run: node test/test-deploy-window.js
 */

import { isWithinDeployWindow } from "../utils/deploy-window.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Both off → always allowed
assert(isWithinDeployWindow(3, {}).allowed, "no gate must allow");
assert(isWithinDeployWindow(3, { afterHour: null, beforeHour: null }).allowed, "nulls must allow");

// afterHour only: block from 18:00 onward
assert(isWithinDeployWindow(17, { afterHour: 18 }).allowed, "17h must pass afterHour 18");
assert(!isWithinDeployWindow(18, { afterHour: 18 }).allowed, "18h must block at afterHour 18");
assert(!isWithinDeployWindow(23, { afterHour: 18 }).allowed, "23h must block at afterHour 18");
assert(isWithinDeployWindow(0, { afterHour: 18 }).allowed, "0h must pass afterHour-only gate");

// beforeHour only: block before 09:00
assert(!isWithinDeployWindow(8, { beforeHour: 9 }).allowed, "8h must block before 9");
assert(isWithinDeployWindow(9, { beforeHour: 9 }).allowed, "9h must pass beforeHour 9");

// Overnight block: after 22 + before 6
const overnight = { afterHour: 22, beforeHour: 6 };
assert(!isWithinDeployWindow(23, overnight).allowed, "23h must block overnight");
assert(!isWithinDeployWindow(2, overnight).allowed, "2h must block overnight");
assert(isWithinDeployWindow(12, overnight).allowed, "12h must pass overnight gate");

// Garbage hour fails open
assert(isWithinDeployWindow(NaN, { afterHour: 18 }).allowed, "NaN hour must fail open");
assert(isWithinDeployWindow(99, { afterHour: 18 }).allowed, "out-of-range hour must fail open");

console.log("  deploy-window: off/after/before/overnight/fail-open OK");
console.log("test-deploy-window: OK");
