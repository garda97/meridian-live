/**
 * Regression test for the GMGN ban watcher's probe classification (no network).
 *
 * The watcher previously probed the wrong host with the wrong header and no
 * client_id, so every response was a 401 — and because an auth failure was
 * folded into "still banned", the ban state stayed banned indefinitely no
 * matter what the API actually said. Auth failures must stay distinguishable
 * from bans, or a misconfigured watchdog silently reports a fault that isn't
 * there and hides the one that is.
 *
 * Run: node test/test-gmgn-ban-watcher.js
 */

import { classifyProbe } from "../scripts/gmgn_ban_watcher.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The bug: a 401 must never read as a ban.
assert(classifyProbe(401, '{"code":401,"error":"AUTH_INVALID"}') === "auth",
  "401 must classify as auth, not banned");
assert(classifyProbe(403, "forbidden") === "auth",
  "403 must classify as auth, not banned");

// A real ban, whatever status carries it.
assert(classifyProbe(429, "IP is temporarily banned due to repeated rate limit violations") === "banned",
  "ban message must classify as banned");
assert(classifyProbe(200, "temporarily banned") === "banned",
  "a ban message must win over a 200 status");
assert(classifyProbe(429, "rate limit exceeded") === "banned",
  "rate-limit wording must classify as banned");

// Healthy response.
assert(classifyProbe(200, '{"code":0,"data":{"address":"So111"}}') === "free",
  "200 with data must classify as free");

// A live payload contains fields like top_10_holder_rate — substring matching
// on "rate" alone would misread a healthy response as a ban.
assert(
  classifyProbe(200, '{"code":0,"data":{"top_10_holder_rate":"0.0917","burn_ratio":"1"}}') === "free",
  "holder_rate/burn_ratio fields must not trip the ban matcher",
);

// Anything else is unknown, and the caller leaves state alone.
assert(classifyProbe(500, "server error") === "unknown", "500 must classify as unknown");
assert(classifyProbe(0, "") === "unknown", "no status must classify as unknown");

console.log("  gmgn-ban-watcher: auth vs banned vs free vs unknown OK");
console.log("test-gmgn-ban-watcher: OK");
