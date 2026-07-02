#!/usr/bin/env node
/** Batch swap remaining dust → SOL (delegates to auto-swap-dust.js / Jupiter v2). */
import { runAutoSwapDust } from "./auto-swap-dust.js";

runAutoSwapDust().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});