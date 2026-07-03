import fs from "fs";
import path from "path";

/**
 * Crash-safe replacement for fs.writeFileSync on state files.
 * Writes to a temp file in the same directory, then renames over the target —
 * rename is atomic on POSIX, so a crash mid-write can never leave a truncated
 * JSON store (a corrupted state.json silently forgets open positions).
 */
export function atomicWriteFileSync(filePath, contents, options = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, options);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
