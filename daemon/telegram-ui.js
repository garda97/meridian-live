/**
 * Telegram ops surface: slash commands, inline settings menu, the message
 * queue, and the deterministic /screen → /deploy N flow. Free-form messages
 * fall through to the GENERAL/SCREENER agent loop.
 */
import { agentLoop } from "../agent.js";
import { log } from "../logger.js";
import { config, computeDeployAmount } from "../config.js";
import { executeTool } from "../tools/executor.js";
import { getMyPositions, closePosition } from "../tools/dlmm.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTopCandidates } from "../tools/screening.js";
import { checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "../tools/token.js";
import { setPositionInstruction } from "../state.js";
import { appendDecision } from "../decision-log.js";
import { applyPendingPlanToDeployArgs } from "../tools/strategy-router.js";
import {
  isHiveMindEnabled,
  ensureAgentId,
  getHiveMindPullMode,
  pullHiveMindLessons,
  pullHiveMindPresets,
  registerHiveMindAgent,
} from "../hivemind.js";
import { generateBriefing } from "../briefing.js";
import {
  sendMessage,
  sendMessageToChat,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  createLiveMessage,
} from "../telegram.js";
import {
  TG,
  localizeTelegramReport,
  formatNoCandidatesReport,
  formatHelpTextId,
  formatWalletStatusId,
  formatConfigSnapshotId,
  formatPositionsListId,
} from "../utils/telegram-id.js";
import {
  isEngineBusy,
  ensureCronStarted,
  pauseCronJobs,
  getLoneCandidateSkipReason,
} from "./engine.js";
import {
  isInteractiveBusy,
  setInteractiveBusy,
  refreshPrompt,
  sessionHistory,
  appendHistory,
  setLatestCandidates,
  getLatestCandidatesMeta,
  describeLatestCandidates,
  stripThink,
} from "./runtime.js";

const _telegramQueue = []; // queued messages received while agent was busy

function formatWalletStatus(wallet, positions) {
  return formatWalletStatusId(
    {
      sol: wallet.sol,
      sol_usd: wallet.sol_usd,
      sol_price: wallet.sol_price,
      nextDeploy: computeDeployAmount(wallet.sol),
      dryRun: process.env.DRY_RUN === "true",
      hiveMind: isHiveMindEnabled() ? "aktif" : "nonaktif",
    },
    positions,
    config.risk.maxPositions,
  );
}

function formatConfigSnapshot() {
  return formatConfigSnapshotId(
    {
      strategy: config.strategy.strategy,
      minBinsBelow: config.strategy.minBinsBelow,
      maxBinsBelow: config.strategy.maxBinsBelow,
      defaultBinsBelow: config.strategy.defaultBinsBelow,
      deployAmountSol: config.management.deployAmountSol,
      gasReserve: config.management.gasReserve,
      maxPositions: config.risk.maxPositions,
      stopLossPct: config.management.stopLossPct,
      takeProfitPct: config.management.takeProfitPct,
      trailingTakeProfit: config.management.trailingTakeProfit,
      trailingTriggerPct: config.management.trailingTriggerPct,
      trailingDropPct: config.management.trailingDropPct,
      outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
      oorCooldownTriggerCount: config.management.oorCooldownTriggerCount,
      oorCooldownHours: config.management.oorCooldownHours,
      repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
      repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
      repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
      minFeePerTvl24h: config.management.minFeePerTvl24h,
      minAgeBeforeYieldCheck: config.management.minAgeBeforeYieldCheck,
      category: config.screening.category,
      timeframe: config.screening.timeframe,
      minTvl: config.screening.minTvl,
      maxTvl: config.screening.maxTvl,
      managementIntervalMin: config.schedule.managementIntervalMin,
      screeningIntervalMin: config.schedule.screeningIntervalMin,
    },
    isHiveMindEnabled(),
    config.hiveMind.agentId,
  );
}

export function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const pageLabel = { main: "utama", risk: "risiko", screen: "screening", indicators: "indikator" }[page] || page;
  const title = page === "main" ? "Menu pengaturan" : `Pengaturan: ${pageLabel}`;
  const onOff = (v) => (v ? "on" : "off");
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${onOff(config.api.lpAgentRelayEnabled)}`,
    `Strategi: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${onOff(config.management.trailingTakeProfit)}`,
    `Indikator: ${onOff(config.indicators.enabled)} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Utama", "cfg:page:main"),
      settingButton("Risiko", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indikator", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Tutup", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max posisi", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Ditutup");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Setting tidak valid");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Aksi tidak dikenal");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Gagal update config");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Diupdate ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return formatHelpTextId();
}

export async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return localizeTelegramReport(`Kandidat teratas (${candidates.length})\n\n${lines.join("\n")}`);
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? formatNoCandidatesReport(examples)
    : "Tidak ada kandidat saat ini.";
}

export async function deployLatestCandidate(index) {
  const latestCandidates = getLatestCandidatesMeta().candidates;
  const candidate = latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  // B — Spray mode: if this candidate passed ONLY via the spray ceiling (top10 > base maxTop10Pct),
  // deploy a small spray amount instead of the full amount (limits rugpull damage).
  const candTop10 = Number(candidate?.top10_pct ?? candidate?.audit?.gmgn_top10_pct ?? 0);
  const baseMaxTop10 = config.screening.maxTop10Pct;
  const sprayOn = config.management?.sprayModeEnabled;
  const useSpray = sprayOn && candTop10 > baseMaxTop10 && candTop10 <= (config.management.sprayMaxTop10Pct ?? 70);
  const finalDeployAmount = useSpray ? (config.management.sprayAmountSol ?? 0.05) : deployAmount;
  const binsBelow = computeBinsBelow(candidate.volatility);
  // Use the auto_strategy router plan (resolved earlier in the screening cycle)
  // instead of the generic volatility formula — the router plan carries the
  // correct strategy (spot/bid_ask/curve) + bins tuned to market view, and is
  // the single source of truth when autoStrategy is enabled. Fall back to the
  // formula only if no pending plan exists (e.g. autoStrategy off).
  let deployArgs = {
    pool_address: candidate.pool,
    amount_y: finalDeployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  };
  if (config.autoStrategy?.enabled) {
    deployArgs = applyPendingPlanToDeployArgs(deployArgs);
  }
  const result = await executeTool("deploy_position", deployArgs);
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !isEngineBusy() && !isInteractiveBusy()) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

export async function telegramHandler(msg) {
  if (msg?.savedPhoto) {
    const photo = msg.savedPhoto;
    const caption = String(msg.text || msg.caption || "").trim();
    await sendMessageToChat(msg.chat?.id, TG.photoSaved(photo.filename, photo.abs_path, caption))
      .catch(() => sendMessage(TG.photoSaved(photo.filename, photo.abs_path, caption)).catch(() => {}));
    if (caption) {
      const queued = { ...msg, text: `[Telegram screenshot: ${photo.abs_path}] ${caption}` };
      if (_telegramQueue.length < 5) _telegramQueue.push(queued);
    }
    return;
  }

  const text = msg?.text?.trim();
  if (!text) return;

  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(TG.settingsError(e.message)).catch(() => {}));
    return;
  }
  if (isEngineBusy() || isInteractiveBusy()) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(TG.queued(_telegramQueue.length, text)).catch(() => {});
    } else {
      sendMessage(TG.queueFull).catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nGunakan /positions untuk daftar bernomor.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage(TG.noOpenPositions); return; }
      await sendMessage(formatPositionsListId(positions, total_positions, config.management.solMode));
    } catch (e) { await sendMessage(TG.error(e.message)).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(TG.invalidIndex); return; }
      const pos = positions[idx];
      const cur = config.management.solMode ? "◎" : "$";
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Posisi: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | aktif ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fee: ${cur}${pos.unclaimed_fees_usd ?? "?"}`,
        `Nilai: ${cur}${pos.total_value_usd ?? "?"}`,
        `Umur: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "DALAM RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Catatan: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(TG.invalidIndex); return; }
      const pos = positions[idx];
      await sendMessage(TG.closing(pos.pair));
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const cur = config.management.solMode ? "◎" : "$";
        const claimNote = result.claim_txs?.length ? `\nTx klaim: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(TG.closedManual(pos.pair, `${cur}${result.pnl_usd ?? "?"}`, closeTxs?.join(", ") || "n/a", claimNote));
      } else {
        await sendMessage(TG.closeFailed(result));
      }
    } catch (e) { await sendMessage(TG.error(e.message)).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage(TG.noOpenPositions); return; }
      await sendMessage(TG.closingAll(positions.length));
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "ditutup" : `gagal (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: gagal (${error.message})`);
        }
      }
      await sendMessage(TG.closeAllDone(results.join("\n"))).catch(() => {});
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(TG.invalidIndex); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(TG.noteSet(pos.pair, note));
    } catch (e) { await sendMessage(TG.error(e.message)).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(TG.configFailed((result?.unknown || []).join(", ") || "none")).catch(() => {});
        return;
      }
      await sendMessage(TG.configUpdated(key, value)).catch(() => {});
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategi: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deploy ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Jumlah: ${deployAmount} SOL`,
        coverage,
        `Posisi: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(TG.error(e.message)).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    pauseCronJobs();
    await sendMessage(TG.paused).catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (ensureCronStarted()) {
      await sendMessage(TG.resumed).catch(() => {});
    } else {
      await sendMessage(TG.alreadyRunning).catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: nonaktif\nAgent ID: ${agentId}\nSet hiveMindApiKey untuk connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: aktif",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Mode pull: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "peringatan"}`,
        `Pelajaran shared: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Preset: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Pull manual: selesai" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error HiveMind: ${e.message}`).catch(() => {});
    }
    return;
  }

  setInteractiveBusy(true);
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage(TG.liveUpdate, TG.liveRequest(text));
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(TG.error(e.message)).catch(() => {});
  } finally {
    setInteractiveBusy(false);
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}
