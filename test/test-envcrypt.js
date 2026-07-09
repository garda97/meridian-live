/**
 * Unit tests for envcrypt AES-256-GCM (v2) encryption + legacy XOR fallback.
 * Run: node test/test-envcrypt.js
 */

import fs from "fs";
import path from "path";
import os from "os";
import { envryptEncrypt, envryptDecrypt, encryptEnvRaw, loadEnv } from "../envcrypt.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const KEY = "test-passphrase-for-envcrypt-suite";

// v2 round-trip
const secret = "4jf7JsExampleBase58PrivateKeyValue1234567890";
const encrypted = envryptEncrypt(secret, KEY);
assert(encrypted.startsWith("v2:"), "new encrypts must produce v2 format");
assert(envryptDecrypt(encrypted, KEY) === secret, "v2 round-trip must return original");

// Unique salt/iv: same plaintext encrypts to different ciphertexts
assert(envryptEncrypt(secret, KEY) !== encrypted, "each encrypt must use fresh salt/iv");

// Wrong passphrase fails loudly (GCM auth tag), never returns garbage
let threw = false;
try { envryptDecrypt(encrypted, "wrong-passphrase"); } catch { threw = true; }
assert(threw, "v2 decrypt with wrong key must throw, not return garbage");

// Truncated payload fails loudly
threw = false;
try { envryptDecrypt("v2:AAAA", KEY); } catch { threw = true; }
assert(threw, "truncated v2 payload must throw");

// Legacy XOR values (no v2: prefix) still decrypt — backward compat
const legacyXor = Buffer.from(
  Array.from("legacy-secret", (c, i) =>
    String.fromCharCode(c.charCodeAt(0) ^ KEY.charCodeAt(i % KEY.length))
  ).join(""),
  "ascii",
).toString("base64");
assert(envryptDecrypt(legacyXor, KEY) === "legacy-secret", "legacy XOR values must still decrypt");

// Unicode survives the round-trip
const unicode = "kunci-rahasia-◎-émoji-密钥";
assert(envryptDecrypt(envryptEncrypt(unicode, KEY), KEY) === unicode, "unicode round-trip");

// encryptEnvRaw + loadEnv end-to-end on temp files
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envcrypt-test-"));
try {
  const rawPath = path.join(dir, ".env.raw");
  const outPath = path.join(dir, ".env");
  const keyPath = path.join(dir, ".envrypt");
  fs.writeFileSync(keyPath, KEY);
  fs.writeFileSync(rawPath, [
    "WALLET_PRIVATE_KEY=super-secret-base58",
    "HELIUS_API_KEY=abc123",
    "TELEGRAM_BOT_TOKEN=tok-456",
    "LLM_MODEL=hermes-3-405b",
    "DRY_RUN=false",
  ].join("\n") + "\n");

  encryptEnvRaw({ rawPath, outPath, keyPath });

  const out = fs.readFileSync(outPath, "utf8");
  assert(!out.includes("super-secret-base58"), "private key must not appear in plaintext");
  assert(!out.includes("abc123"), "API key must not appear in plaintext");
  assert(!out.includes("tok-456"), "bot token must not appear in plaintext");
  assert(out.includes("LLM_MODEL=hermes-3-405b"), "non-secret values stay plaintext");
  assert(out.includes("DRY_RUN=false"), "non-secret values stay plaintext");
  const mode = fs.statSync(outPath).mode & 0o777;
  assert(mode === 0o600, `encrypted .env must be 0600, got ${mode.toString(8)}`);

  // loadEnv decrypts back into process.env
  delete process.env.WALLET_PRIVATE_KEY;
  delete process.env.HELIUS_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const { encryptedKeys } = loadEnv({ envPath: outPath, keyPath });
  assert(encryptedKeys.includes("WALLET_PRIVATE_KEY"), "WALLET_PRIVATE_KEY marked encrypted");
  assert(process.env.WALLET_PRIVATE_KEY === "super-secret-base58", "loadEnv must decrypt private key");
  assert(process.env.HELIUS_API_KEY === "abc123", "loadEnv must decrypt API key");
  assert(process.env.TELEGRAM_BOT_TOKEN === "tok-456", "loadEnv must decrypt bot token");
  assert(process.env.LLM_MODEL === "hermes-3-405b", "plaintext values load unchanged");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// persistEnvKeys (Helius rotator) must keep the encrypted-file format intact
{
  const { persistEnvKeys, getCurrentHeliusKey, getHeliusKeys, buildHeliusRpcUrl } =
    await import("../utils/helius-rotator.js");
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "envcrypt-rotator-"));
  try {
    process.env.ENVRYPT_KEY = KEY; // beats .envrypt in getEnvcryptKey resolution
    const envPath = path.join(dir2, ".env");
    fs.writeFileSync(envPath, "LLM_MODEL=hermes-3-405b\n# encrypted\nHELIUS_API_KEY=v2:stale\n");

    const primary = getCurrentHeliusKey();
    assert(persistEnvKeys(envPath) === true, "persistEnvKeys must report success");
    persistEnvKeys(envPath); // second run must be format-idempotent

    const out = fs.readFileSync(envPath, "utf8");
    assert(!out.includes(primary), "rotated Helius key must not land in plaintext");
    assert(!out.includes("v2:stale"), "stale encrypted value must be replaced");
    const markers = out.split("\n").filter((l) => l.trim() === "# encrypted").length;
    assert(markers === 3, `one marker per encrypted field (KEY, KEYS, RPC_URL), got ${markers}`);
    assert(out.includes("LLM_MODEL=hermes-3-405b"), "unrelated lines must survive");

    for (const k of ["HELIUS_API_KEY", "HELIUS_API_KEYS", "RPC_URL"]) delete process.env[k];
    loadEnv({ envPath, keyPath: path.join(dir2, "no-such-file") });
    assert(process.env.HELIUS_API_KEY === primary, "persisted key must decrypt back to primary");
    assert(process.env.HELIUS_API_KEYS === getHeliusKeys().join(","), "key list must round-trip");
    assert(process.env.RPC_URL === buildHeliusRpcUrl(primary), "RPC_URL must round-trip");
  } finally {
    delete process.env.ENVRYPT_KEY;
    fs.rmSync(dir2, { recursive: true, force: true });
  }
}

console.log("test-envcrypt: all assertions passed ✅");
