#!/usr/bin/env node
/**
 * Swap wallet dust (non-SOL SPL) → SOL via Jupiter Swap API v2 (same path as tools/wallet.js).
 *
 * Usage:
 *   node scripts/auto-swap-dust.js
 *   node scripts/auto-swap-dust.js --dry-run
 *   node scripts/auto-swap-dust.js --mint <mint> --amount <n>
 */

import "../envcrypt.js"; // loads + decrypts .env — must stay the first import
import { getWalletBalances, swapToken } from "../tools/wallet.js";
import { config } from "../config.js";

const SOL_MINT = config.tokens.SOL;
const MIN_BALANCE = 0.000001;

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { dryRun: false, mint: null, amount: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") flags.dryRun = true;
    else if (args[i] === "--mint") flags.mint = args[++i];
    else if (args[i] === "--amount") flags.amount = Number(args[++i]);
  }
  return flags;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAutoSwapDust(flags = parseArgs()) {
  if (flags.dryRun) process.env.DRY_RUN = "true";

  console.log("AUTO-SWAP DUST → SOL (Jupiter v2)\n" + "=".repeat(60));

  const before = await getWalletBalances();
  if (before.error) {
    throw new Error(before.error);
  }

  console.log(`Wallet: ${before.wallet}`);
  console.log(`SOL before: ${before.sol}\n`);

  let targets;
  if (flags.mint && Number.isFinite(flags.amount) && flags.amount > 0) {
    targets = [{
      mint: flags.mint,
      symbol: flags.mint.slice(0, 8),
      balance: flags.amount,
      usd: null,
    }];
  } else {
    targets = (before.tokens || []).filter((t) => {
      if (t.mint === SOL_MINT || t.symbol === "SOL") return false;
      return Number(t.balance) > MIN_BALANCE;
    });
  }

  if (!targets.length) {
    console.log("No dust tokens to swap.");
    return { swapped: 0, total: 0, before, after: before };
  }

  const retries = config.management.autoSwapRetryAttempts ?? 3;
  const delayMs = config.management.autoSwapRetryDelayMs ?? 3000;
  let swapped = 0;

  for (const token of targets) {
    const label = token.symbol || token.mint.slice(0, 8);
    console.log(`[${label}] ${token.balance} → SOL`);

    let result = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      result = await swapToken({
        input_mint: token.mint,
        output_mint: SOL_MINT,
        amount: token.balance,
      });
      if (result?.success || result?.dry_run) break;
      console.log(`  retry ${attempt}/${retries}: ${result?.error || "unknown error"}`);
      if (attempt < retries) await sleep(delayMs);
    }

    if (result?.success) {
      console.log(`  ✓ TX: ${result.tx}`);
      swapped++;
    } else if (result?.dry_run) {
      console.log("  (dry run — no tx sent)");
      swapped++;
    } else {
      console.log(`  ✗ ${result?.error || "swap failed"}`);
    }

    await sleep(2000);
  }

  const after = await getWalletBalances();
  console.log("\n" + "=".repeat(60));
  console.log(`Done: ${swapped}/${targets.length}`);
  console.log(`SOL after: ${after.sol} (was ${before.sol})`);

  return { swapped, total: targets.length, before, after };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutoSwapDust()
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}