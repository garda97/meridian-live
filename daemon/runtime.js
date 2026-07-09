/**
 * Shared daemon runtime state — the small mutable surface that the engine
 * (cycles/cron/pollers), the Telegram handler, and the REPL all touch.
 * Everything here is process-local; nothing persists.
 */
import { config } from "../config.js";
import { describeLatestCandidatesId } from "../utils/telegram-id.js";

// ─── Cycle timers (countdown display + seeding on cron launch) ──
export const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

export function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

export function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ─── Interactive busy flag (REPL + Telegram free-form share one agent) ──
let _busy = false;

export function isInteractiveBusy() {
  return _busy;
}

export function setInteractiveBusy(value) {
  _busy = Boolean(value);
}

// ─── REPL prompt refresher (registered by the TTY block in index.js) ──
let _promptRefresher = null;

export function setPromptRefresher(fn) {
  _promptRefresher = typeof fn === "function" ? fn : null;
}

export function refreshPrompt() {
  _promptRefresher?.();
}

// ─── Conversation history (REPL + Telegram free-form chat) ──
export const sessionHistory = []; // persists conversation across turns
const MAX_HISTORY = 20;           // keep last 20 messages (10 exchanges)

export function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// ─── Latest screening candidates (/screen → /deploy N, REPL number-pick) ──
let _latestCandidates = [];
let _latestCandidatesAt = null;

export function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

export function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

export function describeLatestCandidates(limit = 5) {
  return describeLatestCandidatesId(_latestCandidates.slice(0, limit), _latestCandidatesAt);
}

// ─── Text helpers used across engine + UI ──

/** Strip <think>...</think> reasoning blocks that some models leak into output */
export function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}
