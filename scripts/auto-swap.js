#!/usr/bin/env node
/** @deprecated Use auto-swap-dust.js — kept as alias for Hermes/cron references. */
import { runAutoSwapDust } from "./auto-swap-dust.js";

runAutoSwapDust().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});