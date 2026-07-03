/**
 * Time-of-day deploy gate (METEORA_LP.md "Emotions & Risk Management":
 * no new positions late at night). Hours are server-local (VPS runs WIB).
 *
 * Semantics:
 *   afterHour  = 18 → no new deploys from 18:00 onward
 *   beforeHour = 9  → no new deploys before 09:00
 *   Both set (e.g. after 22, before 6) compose into an overnight block.
 *   null/undefined = that side of the gate is off.
 */
export function isWithinDeployWindow(hour, { afterHour = null, beforeHour = null } = {}) {
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    return { allowed: true, reason: "invalid_hour_fail_open" };
  }
  const after = afterHour == null ? null : Number(afterHour);
  const before = beforeHour == null ? null : Number(beforeHour);

  if (after != null && Number.isFinite(after) && h >= after) {
    return { allowed: false, reason: `hour ${h} >= noDeployAfterHour ${after}` };
  }
  if (before != null && Number.isFinite(before) && h < before) {
    return { allowed: false, reason: `hour ${h} < noDeployBeforeHour ${before}` };
  }
  return { allowed: true, reason: "ok" };
}
