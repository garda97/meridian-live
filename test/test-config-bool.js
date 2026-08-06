/**
 * Unit tests for boolConfig (P2b, SPOT_LOSS_ANALYSIS.md): user-config boolean
 * flags used to be read as `u.xFlag ?? default` / `u.xFlag !== false`, which
 * silently mis-evaluates string values ("0"/"false" are truthy in JS, and a
 * string never strictly equals a boolean literal). No network.
 * Run: node test/test-config-bool.js
 */

import fs from "fs";
import { execFileSync } from "child_process";
import { boolConfig, REPO_ROOT, repoPath } from "../config.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testUnsetFallsThroughToDefault() {
  assert(boolConfig(undefined, true) === true, "undefined must fall through to default (true)");
  assert(boolConfig(undefined, false) === false, "undefined must fall through to default (false)");
  assert(boolConfig(null, true) === true, "null must fall through to default (true)");
  console.log("  unset (undefined/null): falls through to default OK");
}

function testRealBooleansPassThrough() {
  assert(boolConfig(true, false) === true, "boolean true must stay true regardless of default");
  assert(boolConfig(false, true) === false, "boolean false must stay false regardless of default");
  console.log("  real booleans: pass through unchanged OK");
}

function testNumbers() {
  assert(boolConfig(1, false) === true, "number 1 must be true");
  assert(boolConfig(0, true) === false, "number 0 must be false");
  console.log("  numbers: 1/0 coerce correctly OK");
}

// The actual bug this fixes: string "0"/"false" used to be truthy (?? only
// catches null/undefined) and !== false is always true for a string operand.
function testStringCoercionBugFix() {
  assert(boolConfig("0", true) === false, 'string "0" must coerce to false (was truthy under `?? default`)');
  assert(boolConfig("false", true) === false, 'string "false" must coerce to false (was true under `!== false`)');
  assert(boolConfig("no", true) === false, 'string "no" must coerce to false');
  assert(boolConfig("off", true) === false, 'string "off" must coerce to false');
  assert(boolConfig("", true) === false, "empty string must coerce to false");
  assert(boolConfig("1", false) === true, 'string "1" must coerce to true');
  assert(boolConfig("true", false) === true, 'string "true" must coerce to true');
  assert(boolConfig("yes", false) === true, 'string "yes" must coerce to true');
  assert(boolConfig("on", false) === true, 'string "on" must coerce to true');
  assert(boolConfig("  FALSE  ", true) === false, "whitespace/case must be normalized before matching");
  console.log("  string coercion: \"0\"/\"false\"/\"no\"/\"off\" -> false, \"1\"/\"true\"/\"yes\"/\"on\" -> true, case/whitespace-insensitive OK");
}

function testUnrecognizedFailsSafeToDefault() {
  assert(boolConfig("maybe", true) === true, "unrecognized string must fail safe to default (true)");
  assert(boolConfig("maybe", false) === false, "unrecognized string must fail safe to default (false)");
  assert(boolConfig({}, true) === true, "unrecognized type (object) must fail safe to default");
  console.log("  unrecognized values: fail safe to default (no blind Boolean() cast) OK");
}

// DRY_RUN is a safety gate: the stricter of `.env` DRY_RUN and user-config
// dryRun must win. The old `process.env.DRY_RUN ||= String(u.dryRun)` only
// filled an *unset* DRY_RUN, so `.env` DRY_RUN=false beat `dryRun: true` and
// ran LIVE against owner intent (2026-08-06). config.js applies this once at
// import, so each case needs a fresh process.
function testDryRunStricterSourceWins() {
  const userDryRun = fs.existsSync(repoPath("user-config.json"))
    ? JSON.parse(fs.readFileSync(repoPath("user-config.json"), "utf8")).dryRun
    : undefined;
  const fromUser = String(boolConfig(userDryRun, false));

  const effective = (envValue) => {
    const env = { ...process.env };
    delete env.DRY_RUN;
    if (envValue !== undefined) env.DRY_RUN = envValue;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'import "./config.js"; process.stdout.write("<<"+process.env.DRY_RUN+">>");'],
      { cwd: REPO_ROOT, env, encoding: "utf8" },
    );
    return out.match(/<<(.*)>>/)[1];
  };

  assert(effective("true") === "true", "env DRY_RUN=true must force dry-run whatever user-config says");
  // The regression itself: a live-looking .env must not override a dry-run user-config.
  assert(effective("false") === fromUser,
    `env DRY_RUN=false must not beat user-config dryRun=${userDryRun} (expected ${fromUser})`);
  assert(effective(undefined) === fromUser,
    `unset env DRY_RUN must take user-config dryRun=${userDryRun} (expected ${fromUser})`);
  console.log(`  DRY_RUN precedence: stricter source wins (user-config dryRun=${userDryRun}) OK`);
}

testUnsetFallsThroughToDefault();
testRealBooleansPassThrough();
testNumbers();
testStringCoercionBugFix();
testUnrecognizedFailsSafeToDefault();
testDryRunStricterSourceWins();
console.log("test-config-bool: OK");
