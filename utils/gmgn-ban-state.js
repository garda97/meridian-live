/**
 * Shared read/write for the GMGN ban state file.
 *
 * Two processes touch this: tools/gmgn.js marks a ban the moment the API
 * reports one, and scripts/gmgn_ban_watcher.mjs clears it once a probe confirms
 * recovery. Keeping the shape in one place stops the writer and the reader
 * drifting apart.
 *
 * Why the watcher needs this at all: its probe spends the same GMGN daily quota
 * the bot does — a raw fetch skips the in-process counter, not the account's
 * limit. Polling on a timer would consume the quota it exists to protect, so
 * the watcher only probes while this file says a ban is active. That makes it
 * free during normal operation and useful exactly when it matters.
 */
import fs from "fs";
import path from "path";
import { repoPath } from "../repo-root.js";

const STATE_FILE = repoPath(path.join("notes", "_gmgn_ban_state.json"));

const DEFAULT_STATE = { banned: false, since: null, freedAt: null };

export function readBanState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeBanState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false; // state tracking must never break a live API path
  }
}

/**
 * Called from the API path the instant GMGN reports a ban. Idempotent: an
 * already-banned state keeps its original `since` so the watcher can report how
 * long the ban has run.
 */
export function markBanned(now = new Date().toISOString()) {
  const state = readBanState();
  if (state.banned) return state;
  const next = { banned: true, since: now, freedAt: state.freedAt ?? null };
  writeBanState(next);
  return next;
}

export function markFreed(now = new Date().toISOString()) {
  const state = readBanState();
  const next = { banned: false, since: state.since ?? null, freedAt: now };
  writeBanState(next);
  return next;
}

export { STATE_FILE };
