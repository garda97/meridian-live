import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { repoPath } from "./repo-root.js";
import { atomicWriteFileSync } from "./utils/atomic-write.js";

const DEFAULT_ENV_PATH = repoPath(".env");
const DEFAULT_KEY_PATH = repoPath(".envrypt");

function isEncryptedMarker(line) {
  return line.trim().toLowerCase() === "# encrypted";
}

function parseEncryptedKeys(filePath) {
  if (!fs.existsSync(filePath)) return new Set();

  const encrypted = new Set();
  let encryptedNext = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      encryptedNext = false;
      continue;
    }
    if (isEncryptedMarker(trimmed)) {
      encryptedNext = true;
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && encryptedNext) encrypted.add(match[1]);
    encryptedNext = false;
  }
  return encrypted;
}

function getEnvcryptKey(keyPath = DEFAULT_KEY_PATH) {
  const key =
    process.env.ENVRYPT_KEY ||
    process.env.ENVCRYPT_KEY ||
    (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");

  if (!key) return null;
  if (key.length < 8) {
    throw new Error("Envrypt encryption key must be at least 8 characters long.");
  }
  return key;
}

function shouldEncryptEnvKey(envKey) {
  return envKey.endsWith("_KEY") ||
    envKey.endsWith("_KEYS") ||
    envKey === "RPC_URL" || // Helius URL embeds the API key as a query param
    envKey.startsWith("ENVRIPT_") ||
    /(?:PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC)/i.test(envKey);
}

/**
 * Format one KEY=VALUE assignment for writing into the managed .env —
 * encrypted (with its "# encrypted" marker line) when the key is secret-shaped
 * and an envrypt key is available, plaintext otherwise. Writers that patch
 * .env in place (e.g. the Helius key rotator) must use this instead of raw
 * string interpolation, or they corrupt the encrypted-file format.
 */
export function formatEnvAssignment(envKey, value, { keyPath = DEFAULT_KEY_PATH } = {}) {
  if (shouldEncryptEnvKey(envKey)) {
    const key = getEnvcryptKey(keyPath);
    if (key) return `# encrypted\n${envKey}=${envryptEncrypt(value, key)}`;
  }
  return `${envKey}=${value}`;
}

// v2 format: "v2:" + base64(salt[16] | iv[12] | authTag[16] | ciphertext).
// AES-256-GCM with a per-value random salt/iv; the GCM auth tag makes a wrong
// passphrase fail loudly instead of silently yielding garbage like the old XOR.
const V2_PREFIX = "v2:";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveAesKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32);
}

export function envryptEncrypt(value, key) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveAesKey(key, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return V2_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

// Legacy XOR scheme — kept only so existing v1 values still decrypt; new
// writes always produce v2. Re-run `node scripts/envrypt.js encrypt` to upgrade.
function legacyXorDecrypt(value, key) {
  const encrypted = Buffer.from(String(value), "base64").toString("utf8");
  return Array.from(encrypted, (char, index) =>
    String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))
  ).join("");
}

export function envryptDecrypt(value, key) {
  const raw = String(value);
  if (!raw.startsWith(V2_PREFIX)) return legacyXorDecrypt(raw, key);

  const payload = Buffer.from(raw.slice(V2_PREFIX.length), "base64");
  if (payload.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("Envrypt v2 payload is truncated.");
  }
  const salt = payload.subarray(0, SALT_LEN);
  const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = payload.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = payload.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveAesKey(key, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function loadEnv({ envPath = DEFAULT_ENV_PATH, keyPath = DEFAULT_KEY_PATH, override = true } = {}) {
  // override=true so repo .env wins over stale PM2-injected env on restart
  dotenv.config({ path: envPath, override, quiet: true });

  const encryptedKeys = parseEncryptedKeys(envPath);
  if (encryptedKeys.size === 0) return { encryptedKeys: [] };

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error(
      `Encrypted env values found in ${envPath}, but no envrypt key was provided. ` +
      "Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY.",
    );
  }

  for (const envKey of encryptedKeys) {
    const value = process.env[envKey];
    if (value == null || value === "") continue;
    process.env[envKey] = envryptDecrypt(value, key);
  }

  return { encryptedKeys: [...encryptedKeys] };
}

export function encryptEnvRaw({
  rawPath = repoPath(".env.raw"),
  outPath = DEFAULT_ENV_PATH,
  keyPath = DEFAULT_KEY_PATH,
} = {}) {
  if (!fs.existsSync(rawPath)) {
    throw new Error(`No ${rawPath} file found.`);
  }

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error("Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY before encrypting.");
  }

  const parsed = dotenv.parse(fs.readFileSync(rawPath, "utf8"));
  const lines = ["# Envrypt managed environment file.", ""];
  for (const [envKey, value] of Object.entries(parsed)) {
    if (shouldEncryptEnvKey(envKey)) {
      lines.push("# encrypted");
      lines.push(`${envKey}=${envryptEncrypt(value, key)}`, "");
    } else {
      lines.push(`${envKey}=${value}`);
    }
  }

  atomicWriteFileSync(outPath, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  fs.chmodSync(outPath, 0o600); // writeFileSync mode is masked by umask — enforce explicitly
  return { rawPath, outPath };
}

loadEnv();
