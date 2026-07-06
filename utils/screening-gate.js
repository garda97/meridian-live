/**
 * Guards for screening / new-deploy triggers.
 * maxPositions <= 0 = owner pause (no new positions, existing still managed).
 */

import { config } from "../config.js";
import { isWithinDeployWindow } from "./deploy-window.js";

/** True when owner has paused new deploys (maxPositions 0 or negative). */
export function isScreeningPaused(cfg = config) {
  const max = Number(cfg.risk?.maxPositions);
  return Number.isFinite(max) && max <= 0;
}

/**
 * Whether a new deploy slot exists (distinct from pause — maxPositions 0 is pause, not "full").
 */
export function hasDeployCapacity(openCount, cfg = config) {
  const max = Number(cfg.risk?.maxPositions);
  if (!Number.isFinite(max) || max <= 0) return false;
  return Number(openCount) < max;
}

/**
 * Combined gate: should we run screening / allow deploy at all?
 * Returns { allowed, reason }.
 */
export function checkScreeningDeployGate({ openCount = 0, hour = new Date().getHours(), cfg = config } = {}) {
  if (isScreeningPaused(cfg)) {
    return { allowed: false, reason: "screening_paused (maxPositions=0)" };
  }
  if (!hasDeployCapacity(openCount, cfg)) {
    return {
      allowed: false,
      reason: `max_positions_reached (${openCount}/${cfg.risk.maxPositions})`,
    };
  }
  const deployWindow = isWithinDeployWindow(hour, {
    afterHour: cfg.schedule?.noDeployAfterHour,
    beforeHour: cfg.schedule?.noDeployBeforeHour,
  });
  if (!deployWindow.allowed) {
    return { allowed: false, reason: `time_gate: ${deployWindow.reason}` };
  }
  return { allowed: true, reason: "ok" };
}

/** Management / opportunity paths: may we trigger a screening cycle? */
export function canTriggerScreening(cfg = config) {
  if (isScreeningPaused(cfg)) {
    return { ok: false, reason: "screening_paused (maxPositions=0)" };
  }
  const deployWindow = isWithinDeployWindow(new Date().getHours(), {
    afterHour: cfg.schedule?.noDeployAfterHour,
    beforeHour: cfg.schedule?.noDeployBeforeHour,
  });
  if (!deployWindow.allowed) {
    return { ok: false, reason: `time_gate: ${deployWindow.reason}` };
  }
  return { ok: true, reason: "ok" };
}