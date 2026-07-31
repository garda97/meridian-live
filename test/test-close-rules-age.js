import assert from "node:assert/strict";

// close-rules is not exported from daemon — inline the age-gated RULE_3 logic for regression.
function rule3WouldFire(position, managementConfig, configManagement) {
  const minAge = managementConfig.minAgeBeforeOorClose ?? configManagement.minAgeBeforeOorClose ?? 5;
  const age = position.age_minutes ?? 0;
  if (age < minAge) return false;
  return (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + (managementConfig.outOfRangeBinsToClose ?? 10)
  );
}

const cfg = { minAgeBeforeOorClose: 5, outOfRangeBinsToClose: 10 };
const fresh = { age_minutes: 2, active_bin: -490, upper_bin: -500 };
const aged = { age_minutes: 6, active_bin: -490, upper_bin: -500 };

assert.equal(rule3WouldFire(fresh, cfg, cfg), false, "fresh deploy must not RULE_3 close");
assert.equal(rule3WouldFire(aged, cfg, cfg), false, "only 10 bins above upper, need >10");
assert.equal(rule3WouldFire({ ...aged, active_bin: -480 }, cfg, cfg), true, "aged + pumped far above");

console.log("test-close-rules-age: OK");