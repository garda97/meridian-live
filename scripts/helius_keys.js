#!/usr/bin/env node
/**
 * Helius key rotator CLI for Meridian.
 *
 * Usage:
 *   node scripts/helius_keys.js status
 *   node scripts/helius_keys.js validate
 *   node scripts/helius_keys.js import-backup
 *   node scripts/helius_keys.js add KEY1 KEY2 ...
 *   node scripts/helius_keys.js rotate
 */
import { loadEnv } from "../envcrypt.js";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getHeliusKeys,
  getRotatorStatus,
  importKeysFromBackup,
  saveHeliusKeys,
  rotateHeliusKey,
  heliusFetch,
  reloadHeliusKeys,
} from "../utils/helius-rotator.js";

const meridianDir = path.join(os.homedir(), ".meridian");
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  loadEnv({ envPath, override: false });
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function validateKey(key, wallet = "AHidMyeVfAfTyqZJuQdbojJXbBKArBtJR8yok4G2G3sY") {
  const hint = `${key.slice(0, 8)}…`;
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getBalance",
    params: [wallet],
  });
  try {
    const rpcRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const rpcData = await rpcRes.json();
    const rpcOk = rpcRes.ok && rpcData?.result?.value !== undefined;
    let walletOk = false;
    try {
      const wRes = await fetch(
        `https://api.helius.xyz/v1/wallet/${wallet}/balances?api-key=${key}`,
      );
      walletOk = wRes.ok;
    } catch {
      walletOk = false;
    }
    return {
      key: hint,
      rpc: rpcOk ? "ok" : `http_${rpcRes.status}`,
      wallet_api: walletOk ? "ok" : "denied",
      lamports: rpcData?.result?.value ?? null,
    };
  } catch (err) {
    return { key: hint, rpc: "err", wallet_api: "err", error: err.message };
  }
}

async function main() {
  switch (cmd) {
    case "status": {
      reloadHeliusKeys();
      console.log(JSON.stringify(getRotatorStatus(), null, 2));
      break;
    }
    case "validate": {
      const keys = getHeliusKeys();
      const results = [];
      for (const key of keys) {
        results.push(await validateKey(key));
      }
      const ok = results.filter((r) => r.rpc === "ok").length;
      console.log(JSON.stringify({ total: keys.length, rpc_ok: ok, results }, null, 2));
      break;
    }
    case "import-backup": {
      const keys = importKeysFromBackup();
      console.log(JSON.stringify({ imported: keys.length, status: getRotatorStatus() }, null, 2));
      break;
    }
    case "add": {
      if (!args.length) {
        console.error("Usage: node scripts/helius_keys.js add KEY1 [KEY2 ...]");
        process.exit(1);
      }
      const existing = fs.existsSync(path.join(meridianDir, "helius-keys.json"))
        ? getHeliusKeys()
        : [];
      const merged = [...existing, ...args];
      const keys = saveHeliusKeys(merged, "cli_add");
      console.log(JSON.stringify({ total: keys.length, status: getRotatorStatus() }, null, 2));
      break;
    }
    case "rotate": {
      const next = rotateHeliusKey("manual_cli");
      console.log(JSON.stringify({ rotated_to: `${next.slice(0, 8)}…`, status: getRotatorStatus() }, null, 2));
      break;
    }
    case "test-fetch": {
      const wallet = args[0] || "AHidMyeVfAfTyqZJuQdbojJXbBKArBtJR8yok4G2G3sY";
      const res = await heliusFetch(
        (key) => `https://api.helius.xyz/v1/wallet/${wallet}/balances?api-key=${key}`,
      );
      const data = await res.json();
      console.log(JSON.stringify({ ok: true, keys: getHeliusKeys().length, balances: data.balances?.length ?? 0, status: getRotatorStatus() }, null, 2));
      break;
    }
    default:
      console.error(`Usage: node scripts/helius_keys.js <status|validate|import-backup|add|rotate|test-fetch>`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});