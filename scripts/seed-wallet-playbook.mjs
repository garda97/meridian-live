#!/usr/bin/env node
/** One-shot seed: snapshot current open positions for all signal wallets. */
import "../envcrypt.js";
import fs from "fs";
import { getWalletPositions } from "../tools/dlmm.js";
import { seedBaselinePositions } from "../utils/wallet-playbook.js";
import { repoPath } from "../repo-root.js";

const data = JSON.parse(fs.readFileSync(repoPath("smart-wallets.json"), "utf8"));
const wallets = (data.wallets || []).filter((w) => w.type === "signal" && w.mirror !== true);

let total = 0;
for (const wallet of wallets) {
  try {
    const { positions = [] } = await getWalletPositions({ wallet_address: wallet.address });
    const seeded = await seedBaselinePositions(wallet, positions);
    total += seeded.length;
    console.log(`${wallet.name}: ${seeded.length}/${positions.length} seeded`);
  } catch (e) {
    console.error(`${wallet.name}: ${e.message}`);
  }
}
console.log(`Done — ${total} baseline event(s) recorded.`);