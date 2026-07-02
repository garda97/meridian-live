/**
 * meridian Discord listener
 * Watches configured channels for Metlex Pool Bot messages and queues pool signals.
 *
 * Env vars (from ../.env):
 *   DISCORD_BOT_TOKEN      — bot token from Developer Portal (preferred)
 *   DISCORD_USER_TOKEN     — personal account token (legacy selfbot)
 *   DISCORD_GUILD_ID       — server ID
 *   DISCORD_CHANNEL_IDS    — comma-separated channel IDs to monitor
 *   DISCORD_MIN_FEES_SOL   — minimum pool fees threshold (default: 5)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: path.join(ROOT, ".env") });

import { runPreChecks } from "./pre-checks.js";

const SIGNALS_FILE = path.join(ROOT, "discord-signals.json");
const METLEX_BOT_USERNAME = "Metlex Pool Bot";

const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const FALSE_POSITIVE_SKIP = new Set([
  "solana", "meteora", "jupiter", "raydium", "orca",
]);

function isLikelySolanaAddress(str) {
  if (str.length < 32 || str.length > 44) return false;
  if (FALSE_POSITIVE_SKIP.has(str.toLowerCase())) return false;
  if (!/\d/.test(str)) return false;
  return true;
}

function loadSignals() {
  if (!fs.existsSync(SIGNALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")); } catch { return []; }
}

function saveSignal(record) {
  const signals = loadSignals();
  signals.unshift(record);
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals.slice(0, 100), null, 2));
}

function authorName(author) {
  return author?.username || author?.globalName || author?.displayName || "unknown";
}

async function processAddress(address, message) {
  const result = await runPreChecks(address);
  if (!result.pass) return;

  const record = {
    id: `${address.slice(0, 8)}-${Date.now()}`,
    pool_address: result.pool_address,
    base_mint: result.base_mint,
    base_symbol: result.symbol || "?",
    signal_source: "discord",
    discord_guild: message.guild?.name || "unknown",
    discord_channel: message.channel?.name || "unknown",
    discord_author: authorName(message.author),
    discord_message_snippet: message.content?.slice(0, 120) || "",
    queued_at: new Date().toISOString(),
    rug_score: result.rug_score ?? null,
    total_fees_sol: result.total_fees_sol ?? null,
    token_age_minutes: result.token_age_minutes ?? null,
    status: "pending",
  };

  saveSignal(record);
  console.log(`\n[QUEUED] ${record.base_symbol} → ${record.pool_address}`);
  console.log(`  from: @${record.discord_author} in #${record.discord_channel}`);
  console.log(`  → Check with: node ../cli.js discord-signals`);
}

function attachHandlers(client, mode) {
  const GUILD_ID = process.env.DISCORD_GUILD_ID;
  const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

  client.on("ready", () => {
    console.log(`\n[meridian discord-listener] Connected as ${client.user?.tag} (${mode})`);
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      console.warn(`WARNING: Guild ${GUILD_ID} not found in cache. Check DISCORD_GUILD_ID and bot invite.`);
    } else {
      console.log(`Watching guild: ${guild.name}`);
      const channelNames = CHANNEL_IDS.map((id) => {
        const ch = guild.channels.cache.get(id);
        return ch ? `#${ch.name}` : `#${id} (not found)`;
      });
      console.log(`Channels: ${channelNames.join(", ")}`);
    }
    console.log(`\nStreaming messages... (Ctrl+C to stop)\n`);
  });

  client.on("messageCreate", async (message) => {
    if (message.guildId !== GUILD_ID) return;
    if (!CHANNEL_IDS.includes(message.channelId)) return;
    if (message.author?.id === client.user?.id) return;
    if (authorName(message.author) !== METLEX_BOT_USERNAME) return;

    const content = message.content || "";
    const embeds = message.embeds?.map((e) => `${e.title || ""} ${e.description || ""}`).join(" ") || "";
    const fullText = `${content} ${embeds}`;

    const matches = [...fullText.matchAll(SOL_ADDR_RE)].map((m) => m[0]);
    const unique = [...new Set(matches)].filter(isLikelySolanaAddress);
    if (unique.length === 0) return;

    console.log(`\n[message] @${authorName(message.author)} in #${message.channel?.name}: "${content.slice(0, 80)}"`);
    console.log(`  Addresses found: ${unique.join(", ")}`);

    for (const addr of unique) {
      await processAddress(addr, message);
    }
  });

  client.on("error", (err) => {
    console.error("[discord error]", err.message);
  });
}

async function main() {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
  const USER_TOKEN = process.env.DISCORD_USER_TOKEN?.trim();
  const GUILD_ID = process.env.DISCORD_GUILD_ID;
  const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!BOT_TOKEN && !USER_TOKEN) {
    console.error("ERROR: Set DISCORD_BOT_TOKEN or DISCORD_USER_TOKEN in ../.env");
    process.exit(1);
  }
  if (!GUILD_ID) {
    console.error("ERROR: DISCORD_GUILD_ID not set in ../.env");
    process.exit(1);
  }
  if (CHANNEL_IDS.length === 0) {
    console.error("ERROR: DISCORD_CHANNEL_IDS not set in ../.env");
    process.exit(1);
  }

  if (BOT_TOKEN) {
    const { Client, GatewayIntentBits, Partials } = await import("discord.js");
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
    attachHandlers(client, "bot");
    await client.login(BOT_TOKEN);
    return;
  }

  const { Client } = await import("discord.js-selfbot-v13");
  const client = new Client({ checkUpdate: false });
  attachHandlers(client, "selfbot");
  await client.login(USER_TOKEN);
}

main().catch((err) => {
  console.error("[discord fatal]", err.message);
  process.exit(1);
});