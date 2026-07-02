#!/usr/bin/env node
/**
 * Test swap fix — pequeño amount to verify functionality
 */

import { execSync } from "child_process";

console.log("\n=".repeat(90));
console.log("TESTING SWAP FIX");
console.log("=".repeat(90));

console.log("\nTest 1: Swap 0.001 FROGBULL → SOL (small amount)");
console.log("─".repeat(90));

try {
  const result = execSync(
    `node cli.js swap --from BDbNwA95183CdqUhx2P6R3fWXbefubVbx2wNnCp6pump --to So11111111111111111111111111111111111111111 --amount 0.001`,
    {
      cwd: "/root/meridian",
      timeout: 60000,
      encoding: "utf8",
    }
  );

  console.log("✓ Swap completed:");
  console.log(result);

  // Parse result
  try {
    const data = JSON.parse(result);
    if (data.success) {
      console.log(`\n✓ SUCCESS! TX: ${data.tx}`);
      console.log(`  Output: ${data.amount_out}`);
    } else {
      console.log(`\n✗ Failed: ${data.error}`);
    }
  } catch {
    console.log(result);
  }
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
  if (err.stderr) {
    console.log("\nStderr:", err.stderr.toString());
  }
}

console.log("\n" + "=".repeat(90) + "\n");
