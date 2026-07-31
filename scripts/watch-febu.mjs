#!/usr/bin/env node
/**
 * FEBU + screening watch loop — append status to notes/FEBU_WATCH.log
 * Run: node scripts/watch-febu.mjs
 */
import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getTopCandidates } from "../tools/screening.js";
import { getMyPositions } from "../tools/dlmm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, "../notes/FEBU_WATCH.log");
const FEBU_POOL = "2CVnAQYvrgTX8rmnRzWCE3Citgbo3kga3M8TeoFsUEJz";
const INTERVAL_MS = 5 * 60 * 1000;

function append(line) {
  const row = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(LOG, row);
  process.stdout.write(row);
}

async function tick() {
  try {
    const [r, pos] = await Promise.all([
      getTopCandidates({ limit: 15 }),
      getMyPositions(),
    ]);
    const list = r.candidates || [];
    const febu = list.find(
      (c) => c.pool === FEBU_POOL || /febu/i.test(c.name || ""),
    );
    const top = list.slice(0, 3).map((c) => `${c.name}(v${Math.round(c.volume_window || 0)})`).join(", ");
    if (febu) {
      append(
        `FEBU IN rank #${list.indexOf(febu) + 1}/${list.length} | vol=$${Math.round(febu.volume_window || 0)} tvl=$${Math.round(febu.tvl || 0)} share=${febu.estimated_share_pct ?? "?"}% | pos=${pos.total_positions} | top: ${top}`,
      );
    } else {
      const why = (r.filtered_out || [])
        .filter((f) => /febu/i.test(f.name || "") || f.pool === FEBU_POOL)
        .map((f) => f.filter_reason || f.reason)
        .join("; ");
      append(`FEBU OUT | candidates=${list.length} | filter=${why || "not in discovery top"} | top: ${top || "none"}`);
    }
  } catch (e) {
    append(`ERROR ${e.message}`);
  }
}

append("watch-febu started");
await tick();
setInterval(tick, INTERVAL_MS);