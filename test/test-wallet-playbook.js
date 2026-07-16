import assert from "node:assert/strict";
import {
  classifyMcapBucket,
  classifyPumpBucket,
  classifyVolBucket,
  buildRegimeKey,
  formatRegimeLabel,
} from "../utils/wallet-playbook.js";

assert.equal(classifyMcapBucket(150_000), "micro");
assert.equal(classifyMcapBucket(800_000), "small");
assert.equal(classifyPumpBucket(25), "pump");
assert.equal(classifyPumpBucket(-15), "dump");
assert.equal(classifyVolBucket(80_000), "high");

const key = buildRegimeKey({
  mcap_bucket: "small",
  pump_bucket: "flat",
  vol_bucket: "high",
});
assert.equal(key, "mcap_small|pump_flat|vol_high");
assert.equal(formatRegimeLabel(key), "small / flat / high");

console.log("test-wallet-playbook: OK");