#!/usr/bin/env node
// GMGN ban watcher: probe GMGN API directly (bypassing bot budget cache) to detect
// if the IP ban is lifted. Notifies owner via Telegram when freed. Runs every 30 min.
//
// NOTE: this does NOT use getGmgnTokenSecurity (which is budget-capped). It does a raw
// fetch so it never consumes the bot's daily GMGN quota.

import { readFileSync, writeFileSync, existsSync } from "fs";

const STATE_FILE = "/opt/meridian/notes/_gmgn_ban_state.json";
const TEST_MINT = "5asSNpLpxzZpkbqZkeuT3tCPPqWtZBQivbbrQHMcpump";
// Read GMGN key from .env (daemon loads it; here we parse .env directly)
function loadGmgnKey() {
  try {
    const env = readFileSync("/opt/meridian/.env", "utf8");
    const m = env.match(/^GMGN_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { banned: true, since: null, freedAt: null }; }
}
function writeState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function probeBanned() {
  const key = loadGmgnKey();
  if (!key) return true; // can't test -> assume still issue
  const url = `https://api.gmgn.ai/v1/token/security?chain=sol&address=${TEST_MINT}`;
  try {
    const res = await fetch(url, {
      headers: { "gmgn-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    if (res.status === 200 && !/temporarily banned/i.test(body)) return false; // freed
    if (/temporarily banned/i.test(body)) return true; // still banned
    // other error (401 etc) -> treat as unknown, don't flip state aggressively
    return true;
  } catch {
    return true;
  }
}

(async () => {
  let state = readState();
  const banned = await probeBanned();
  const now = new Date().toISOString();

  if (state.banned && !banned) {
    const msg =
      `✅ GMGN ban SUDAH LEPAS (${now})\n` +
      `Bot bisa pakai CPO + audit normal lagi.\n` +
      `Budget guard aktif: max 18 security + 3 holders/hari (gak ke-ban lagi).`;
    console.log(msg); // cron delivers stdout
    writeState({ banned: false, since: state.since, freedAt: now });
    return;
  }
  if (!state.banned && banned) {
    writeState({ banned: true, since: now, freedAt: state.freedAt });
  } else if (state.banned && banned && !state.since) {
    writeState({ banned: true, since: now, freedAt: state.freedAt });
  }
  // Still banned -> silent watchdog
  console.log(`GMGN masih banned @ ${now} — menunggu.`);
})();
