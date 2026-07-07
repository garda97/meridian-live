/**
 * Unit tests for boolConfig (P2b, SPOT_LOSS_ANALYSIS.md): user-config boolean
 * flags used to be read as `u.xFlag ?? default` / `u.xFlag !== false`, which
 * silently mis-evaluates string values ("0"/"false" are truthy in JS, and a
 * string never strictly equals a boolean literal). No network.
 * Run: node test/test-config-bool.js
 */

import { boolConfig } from "../config.js";

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

testUnsetFallsThroughToDefault();
testRealBooleansPassThrough();
testNumbers();
testStringCoercionBugFix();
testUnrecognizedFailsSafeToDefault();
console.log("test-config-bool: OK");
