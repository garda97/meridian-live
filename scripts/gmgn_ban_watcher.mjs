#!/usr/bin/env node
// GMGN ban watcher: probe GMGN API directly (bypassing bot budget cache) to detect
// if the IP ban is lifted. Notifies owner via Telegram when freed.
//
// NOTE: this does NOT use getGmgnTokenSecurity (which is budget-capped). It does a raw
// fetch so it never consumes the bot's daily GMGN quota.
//
// The probe must mirror tools/gmgn.js's request contract exactly — host, header
// name, and the timestamp/client_id params the API rejects requests without.
// An earlier version probed a different host with a different header and no
// client_id, so every probe returned 401; since an auth failure was folded into
// "still banned", the state file stayed banned indefinitely regardless of
// reality. Auth failures are now reported as configuration errors and never
// change the ban state.

import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { readBanState, writeBanState } from "../utils/gmgn-ban-state.js";
// Imported for its side effect: envcrypt calls loadEnv() at module load and
// decrypts the envrypt-managed values into process.env. Calling loadEnv() again
// here would run the decryption a second time over already-plaintext values.
import "../envcrypt.js";

const TEST_MINT = "5asSNpLpxzZpkbqZkeuT3tCPPqWtZBQivbbrQHMcpump";
const API_BASE = "https://openapi.gmgn.ai";

// GMGN_API_KEY ends in _KEY, so envcrypt stores it encrypted. Parsing .env by
// hand yields the ciphertext, which the API rejects — load it the way the
// daemon does instead.
function loadGmgnKey() {
  return process.env.GMGN_API_KEY || null;
}

const readState = readBanState;
const writeState = writeBanState;

/**
 * Classify one probe response. Kept separate and exported so the branch that
 * used to be wrong — an auth failure being folded into "still banned" — is
 * testable without credentials or network.
 *
 * @returns {"free"|"banned"|"auth"|"unknown"}
 */
export function classifyProbe(status, body = "") {
  const text = String(body);
  if (/temporarily banned/i.test(text) || /rate limit/i.test(text)) return "banned";
  if (status === 401 || status === 403) return "auth";
  if (status === 200) return "free";
  return "unknown";
}

/** @returns {"free"|"banned"|"auth"|"unknown"} */
async function probe() {
  const key = loadGmgnKey();
  if (!key) return "auth";

  const url = new URL(`${API_BASE}/v1/token/security`);
  url.searchParams.set("chain", "sol");
  url.searchParams.set("address", TEST_MINT);
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("client_id", randomUUID());

  try {
    const res = await fetch(url, {
      headers: { "X-APIKEY": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    return classifyProbe(res.status, await res.text());
  } catch {
    return "unknown";
  }
}

async function main() {
  const state = readState();

  // The probe spends the same GMGN daily quota the bot does — a raw fetch skips
  // the in-process counter, not the account limit. Polling on a timer would
  // consume the quota this watchdog exists to protect, so it stays idle unless
  // tools/gmgn.js has recorded a ban. During a ban the bot cannot spend quota
  // anyway, which is exactly when a probe is free to make.
  if (!state.banned) {
    console.log(`GMGN normal — tidak ada ban tercatat, probe dilewati (${new Date().toISOString()}).`);
    return;
  }

  const result = await probe();
  const now = new Date().toISOString();

  if (result === "auth") {
    // Loud and state-preserving: a broken probe must never look like a ban.
    console.log(
      `⚠️ GMGN ban watcher tidak bisa autentikasi (${now}).\n` +
      "Probe gagal karena API key, bukan karena ban. Ban state dibiarkan apa adanya.\n" +
      "Cek GMGN_API_KEY di .env (nilainya terenkripsi envrypt — jangan dibaca mentah).",
    );
    return;
  }

  if (result === "unknown") {
    console.log(`GMGN ban watcher: hasil probe tidak jelas @ ${now} — state dibiarkan.`);
    return;
  }

  const banned = result === "banned";

  if (state.banned && !banned) {
    console.log(
      `✅ GMGN ban SUDAH LEPAS (${now})\n` +
      "Bot bisa pakai CPO + audit normal lagi.\n" +
      "Budget guard tetap aktif (lihat GMGN_DAILY_CAP di tools/gmgn.js).",
    );
    writeState({ banned: false, since: state.since, freedAt: now });
    return;
  }
  if (!state.banned && banned) {
    console.log(`🚨 GMGN ke-ban lagi @ ${now}`);
    writeState({ banned: true, since: now, freedAt: state.freedAt });
    return;
  }
  if (state.banned && banned && !state.since) {
    writeState({ banned: true, since: now, freedAt: state.freedAt });
  }
  console.log(banned ? `GMGN masih banned @ ${now} — menunggu.` : `GMGN normal @ ${now}.`);
}

// Only probe when run directly — importing this module (e.g. from a test) must
// not fire a live request or rewrite the ban state.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
