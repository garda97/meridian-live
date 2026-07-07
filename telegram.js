import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { atomicWriteFileSync } from "./utils/atomic-write.js";
import { fetchWithTimeout } from "./utils/fetch-timeout.js";

const TELEGRAM_FETCH_TIMEOUT_MS = 10_000;
import {
  TG,
  BOT_COMMANDS_ID,
  toolLabelId,
  summarizeToolResultId,
} from "./utils/telegram-id.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const UPLOADS_DIR = repoPath("uploads");
const MANIFEST_PATH = path.join(UPLOADS_DIR, "manifest.json");
const PENDING_IMAGE_PATH = repoPath("notes/telegram_image_pending.json");
const MAX_UPLOAD_ITEMS = 50;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;
let _warnedUnauthorizedChat = false;

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    atomicWriteFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== String(chatId)) {
    if (!_warnedUnauthorizedChat) {
      log("telegram_warn", `Ignoring Telegram chat ${incomingChatId} (expected ${chatId}). Update TELEGRAM_CHAT_ID if this is your DM.`);
      _warnedUnauthorizedChat = true;
    }
    return false;
  }

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetchWithTimeout(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    }, TELEGRAM_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetchWithTimeout(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, TELEGRAM_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageToChat(targetChatId, text) {
  if (!TOKEN || targetChatId == null) return null;
  return postTelegramRaw("sendMessage", {
    chat_id: targetChatId,
    text: String(text).slice(0, 4096),
  });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function createLiveMessage(title, intro = TG.liveStarting) {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabelId(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResultId(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


function readUploadManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return { latest: null, items: [] };
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return { latest: null, items: [] };
  }
}

function writeUploadManifest(manifest) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function pickLargestPhoto(photos = []) {
  if (!Array.isArray(photos) || !photos.length) return null;
  return photos.reduce((best, photo) => (
    !best || Number(photo.file_size || 0) > Number(best.file_size || 0) ? photo : best
  ));
}

async function downloadTelegramFile(fileId) {
  const meta = await postTelegramRaw("getFile", { file_id: fileId });
  const filePath = meta?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");
  const fileRes = await fetchWithTimeout(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, {}, TELEGRAM_FETCH_TIMEOUT_MS);
  if (!fileRes.ok) throw new Error(`Telegram file download failed: ${fileRes.status}`);
  return {
    buffer: Buffer.from(await fileRes.arrayBuffer()),
    filePath,
  };
}

function pickImageUpload(msg) {
  const photo = pickLargestPhoto(msg?.photo);
  if (photo?.file_id) return { file_id: photo.file_id, mime_type: null };
  const doc = msg?.document;
  if (doc?.file_id && /^image\//i.test(doc.mime_type || "")) {
    return { file_id: doc.file_id, mime_type: doc.mime_type };
  }
  return null;
}

export async function saveIncomingPhoto(msg) {
  const upload = pickImageUpload(msg);
  if (!upload?.file_id) return null;

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");

  const { buffer, filePath } = await downloadTelegramFile(upload.file_id);
  const ext = path.extname(filePath || "") || (upload.mime_type === "image/png" ? ".png" : ".jpg");
  const filename = `tg_${stamp}_${msg.message_id}${ext}`;
  const relPath = path.join("uploads", filename);
  const absPath = path.join(UPLOADS_DIR, filename);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(absPath, buffer);

  const entry = {
    path: relPath.replace(/\\/g, "/"),
    filename,
    abs_path: absPath,
    saved_at: now.toISOString(),
    message_id: msg.message_id,
    caption: msg.caption || null,
    mime_type: upload.mime_type || (ext.toLowerCase() === ".png" ? "image/png" : "image/jpeg"),
    size_bytes: buffer.length,
    telegram_file_path: filePath,
  };

  const manifest = readUploadManifest();
  manifest.items = [entry, ...(manifest.items || [])].slice(0, MAX_UPLOAD_ITEMS);
  manifest.latest = entry.path;
  writeUploadManifest(manifest);

  const pending = {
    ...entry,
    chat_id: msg.chat?.id ?? null,
    user_id: msg.from?.id ?? null,
    pending_for: "hermes",
  };
  fs.mkdirSync(path.dirname(PENDING_IMAGE_PATH), { recursive: true });
  fs.writeFileSync(PENDING_IMAGE_PATH, JSON.stringify(pending, null, 2));

  log("telegram", `Saved inbound photo → ${entry.path} (${entry.size_bytes} bytes)`);
  return entry;
}

export function getLatestUpload() {
  const manifest = readUploadManifest();
  const latestPath = manifest.latest;
  const item = (manifest.items || []).find((entry) => entry.path === latestPath) || manifest.items?.[0] || null;
  if (!item) return null;
  const absPath = item.abs_path || path.join(repoPath("."), item.path);
  return { ...item, abs_path: absPath };
}

export function getPendingTelegramImage() {
  try {
    if (!fs.existsSync(PENDING_IMAGE_PATH)) return null;
    return JSON.parse(fs.readFileSync(PENDING_IMAGE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function clearPendingTelegramImage() {
  try {
    if (fs.existsSync(PENDING_IMAGE_PATH)) fs.unlinkSync(PENDING_IMAGE_PATH);
  } catch { /* ignore */ }
}

// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log("telegram_error", `getUpdates HTTP ${res.status}: ${errText.slice(0, 200)}`);
        await sleep(5000);
        continue;
      }
      const data = await res.json();
      if (data.ok === false) {
        log("telegram_error", `getUpdates API error: ${data.description || JSON.stringify(data).slice(0, 200)}`);
        await sleep(5000);
        continue;
      }
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg) continue;

        const imageUpload = pickImageUpload(msg);
        const hasImage = !!imageUpload;
        const text = String(msg.text || msg.caption || "").trim();
        const kind = hasImage ? "image" : text ? "text" : "other";
        const docMeta = msg.document
          ? ` doc=${msg.document.file_name || "(no name)"} mime=${msg.document.mime_type || "?"}`
          : "";
        log("telegram", `Inbound ${kind} update_id=${update.update_id} chat=${msg.chat?.id} user=${msg.from?.id}${docMeta}`);

        if (!isAuthorizedIncomingMessage(msg)) continue;
        if (!hasImage && !text) continue;

        const enriched = { ...msg, text };
        if (hasImage) {
          try {
            const savedPhoto = await saveIncomingPhoto(msg);
            if (savedPhoto) enriched.savedPhoto = savedPhoto;
          } catch (error) {
            log("telegram_error", `Failed to save inbound photo: ${error.message}`);
            await sendMessageToChat(msg.chat?.id, TG.photoSaveFailed(error.message)).catch(() => {});
            continue;
          }
        }
        await onMessage(enriched);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = BOT_COMMANDS_ID;

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetchWithTimeout(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    }, TELEGRAM_FETCH_TIMEOUT_MS);
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  let config = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    config = cfg.telegramNotifications || {};
  } catch {}
  
  if (!config.deployNotify || hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? TG.priceRange(priceRange.min, priceRange.max)
    : "";
  const coverageStr = rangeCoverage
    ? TG.rangeCover(rangeCoverage.downside_pct, rangeCoverage.upside_pct, rangeCoverage.width_pct)
    : "";
  const poolStr = (binStep || baseFee) ? TG.poolMeta(binStep, baseFee) : "";
  await sendHTML(TG.deployed(pair, amountSol, priceStr, coverageStr, poolStr, position, tx));
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  let config = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    config = cfg.telegramNotifications || {};
  } catch {}
  
  if (!config.closeNotify || hasActiveLiveMessage()) return;
  await sendHTML(TG.closed(pair, pnlUsd, pnlPct));
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  let config = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    config = cfg.telegramNotifications || {};
  } catch {}
  
  if (!config.swapNotify || hasActiveLiveMessage()) return;
  await sendHTML(TG.swapped(inputSymbol, outputSymbol, amountIn, amountOut, tx));
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  let config = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    config = cfg.telegramNotifications || {};
  } catch {}
  
  if (!config.outOfRangeNotify || hasActiveLiveMessage()) return;
  await sendHTML(TG.outOfRange(pair, minutesOOR));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
