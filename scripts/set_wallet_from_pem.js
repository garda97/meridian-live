#!/usr/bin/env node
/**
 * Convert Ed25519 PEM private key → Meridian WALLET_PRIVATE_KEY (base58).
 * Usage:
 *   node scripts/set_wallet_from_pem.js /path/to/key.pem
 *   node scripts/set_wallet_from_pem.js --from-migrate-env
 */
import { createPrivateKey } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");

function loadPem(path) {
  let pem = readFileSync(path, "utf8").trim();
  if (!pem.includes("BEGIN")) {
    let v = pem;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    pem = v.replace(/\\n/g, "\n");
  }
  return pem;
}

function pemToBase58(pem) {
  const pk = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  const seed = Buffer.from(pk.export({ format: "jwk" }).d, "base64url");
  const kp = Keypair.fromSeed(seed);
  return { base58: bs58.encode(kp.secretKey), pubkey: kp.publicKey.toBase58() };
}

function updateEnv(base58) {
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith("WALLET_PRIVATE_KEY=")) {
      found = true;
      return `WALLET_PRIVATE_KEY=${base58}`;
    }
    return line;
  });
  if (!found) out.push(`WALLET_PRIVATE_KEY=${base58}`);
  writeFileSync(ENV_PATH, out.join("\n") + "\n", { mode: 0o600 });
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/set_wallet_from_pem.js <file.pem|--from-migrate-env>");
  process.exit(1);
}

const pemPath =
  arg === "--from-migrate-env"
    ? "/root/screening_g97_migrate_incoming/.env"
    : arg;

let pem;
if (pemPath.endsWith(".env")) {
  const env = readFileSync(pemPath, "utf8");
  const m = env.match(/^GMGN_PRIVATE_KEY=(.*)$/m);
  if (!m) throw new Error("GMGN_PRIVATE_KEY not found in .env");
  pem = loadPem(m[1]);
} else {
  pem = loadPem(pemPath);
}

const { base58, pubkey } = pemToBase58(pem);
updateEnv(base58);
console.log(`OK — WALLET_PRIVATE_KEY updated in .env`);
console.log(`Pubkey: ${pubkey}`);
console.log(`Verify: node cli.js balance`);