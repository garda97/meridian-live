/**
 * Unit tests for atomicWriteFileSync (crash-safe state writes).
 * Run: node test/test-atomic-write.js
 */

import fs from "fs";
import path from "path";
import os from "os";
import { atomicWriteFileSync } from "../utils/atomic-write.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
try {
  const target = path.join(dir, "state.json");

  // Fresh write
  atomicWriteFileSync(target, JSON.stringify({ a: 1 }));
  assert(JSON.parse(fs.readFileSync(target, "utf8")).a === 1, "fresh write must land");

  // Overwrite existing
  atomicWriteFileSync(target, JSON.stringify({ a: 2 }));
  assert(JSON.parse(fs.readFileSync(target, "utf8")).a === 2, "overwrite must replace content");

  // No temp leftovers after successful writes
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  assert(leftovers.length === 0, `no .tmp files may remain, found: ${leftovers.join(", ")}`);

  // Mode option applied (e.g. 0600 key files)
  const secret = path.join(dir, "keys.json");
  atomicWriteFileSync(secret, "{}", { mode: 0o600 });
  const mode = fs.statSync(secret).mode & 0o777;
  assert(mode === 0o600, `mode 0600 must be preserved, got ${mode.toString(8)}`);

  // Failed rename cleans up its temp file (target dir vanishes mid-flight)
  const goneDir = path.join(dir, "sub");
  fs.mkdirSync(goneDir);
  const goneTarget = path.join(goneDir, "x.json");
  let threw = false;
  const origRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("simulated rename failure"); };
  try {
    atomicWriteFileSync(goneTarget, "{}");
  } catch {
    threw = true;
  } finally {
    fs.renameSync = origRename;
  }
  assert(threw, "rename failure must propagate");
  assert(fs.readdirSync(goneDir).length === 0, "temp file must be cleaned up after rename failure");

  console.log("  atomic-write: fresh/overwrite/no-leftovers/mode/cleanup OK");
  console.log("test-atomic-write: OK");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
