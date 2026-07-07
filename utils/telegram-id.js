/**
 * Teks notifikasi & UI Telegram — Bahasa Indonesia.
 */

export const TG_TITLES = {
  screening: "🔍 Siklus Screening",
  screeningScan: "Memindai kandidat...",
  management: "🔄 Siklus Manajemen",
  managementEval: "Mengevaluasi posisi...",
};

/** Terjemahkan laporan screening/management/LLM (EN → ID). */
export function translateReport(text = "") {
  if (!text) return text;
  let s = String(text);

  // Header & section labels (urutan penting — spesifik dulu)
  const rules = [
    [/🚀\s*DEPLOYED/gi, "🚀 DEPLOY"],
    [/⛔\s*NO DEPLOY/gi, "⛔ TIDAK DEPLOY"],
    [/BEST LOOKING CANDIDATE/gi, "KANDIDAT TERBAIK"],
    [/WHY SKIPPED/gi, "ALASAN DILEWATI"],
    [/WHY THIS WON/gi, "ALASAN MENANG"],
    [/^REJECTED$/gim, "DITOLAK"],
    [/^MARKET$/gim, "PASAR"],
    [/^AUDIT$/gim, "AUDIT"],
    [/Cycle finished with no valid entry\./gi, "Siklus selesai tanpa entry valid."],
    [/Scanning candidates\.\.\./gi, "Memindai kandidat..."],
    [/Evaluating positions\.\.\./gi, "Mengevaluasi posisi..."],
    [/Screening Cycle/gi, "Siklus Screening"],
    [/Management Cycle/gi, "Siklus Manajemen"],
    [/Screening skipped/gi, "Screening dilewati"],
    [/Screening pre-check failed/gi, "Pre-check screening gagal"],
    [/Screening cycle failed/gi, "Siklus screening gagal"],
    [/Management cycle failed/gi, "Siklus manajemen gagal"],
    [/screening_paused \(maxPositions=0\)/gi, "screening dijeda (maxPositions=0)"],
    [/Daily loss gate/gi, "Gate loss harian"],
    [/New deploys paused until WIB midnight/gi, "Deploy baru dijeda sampai tengah malam WIB"],
    [/Time gate/gi, "Time gate"],
    [/SOL regime gate/gi, "Gate regime SOL"],
    [/insufficient SOL/gi, "SOL tidak cukup"],
    [/needed for deploy \+ gas/gi, "diperlukan untuk deploy + gas"],
    [/No candidates available/gi, "Tidak ada kandidat"],
    [/all filtered by GMGN holder-quality rules/gi, "semua difilter aturan kualitas holder GMGN"],
    [/all filtered by launchpad \/ holder-quality rules/gi, "semua difilter launchpad / kualitas holder"],
    [/No open positions/gi, "Tidak ada posisi terbuka"],
    [/Triggering screening cycle/gi, "Memulai siklus screening"],
    [/Screening paused/gi, "Screening dijeda"],
    [/Filtered examples/gi, "Contoh yang difilter"],
    [/Only one candidate survived filtering, but it was not worth deploying/gi, "Hanya satu kandidat lolos filter, tapi tidak layak deploy"],
    [/The harness has locked out further deploy attempts this session after the first blocked call\. I need to stop and report\./gi, "Harness mengunci deploy lanjutan di sesi ini setelah percobaan pertama diblokir. Berhenti dan laporkan."],
    [/deploy\.position already attempted this session — do not retry\. If it failed, report the error and stop\./gi, "deploy sudah dicoba di sesi ini — jangan retry. Jika gagal, laporkan error dan stop."],
    [/Unknown tool:/gi, "Tool tidak dikenal:"],
    [/indicator reject: supertrend_break not confirmed on 15_MINUTE/gi, "indikator: supertrend break belum confirm di 15m"],
    [/rugcheck: top10 holders ([\d.]+)% > (\d+)%/gi, "rugcheck: top10 holder $1% > $2%"],
    [/loss close \(PnL ([^)]+)\)/gi, "close rugi (PnL $1)"],
    [/in-range win close \(PnL ([^)]+)\) — let the retrace pass/gi, "close win in-range (PnL $1) — tunggu retrace"],
    [/Range cover:/gi, "Cakupan range:"],
    [/Range:/gi, "Range:"],
    [/Fee\/TVL:/gi, "Fee/TVL:"],
    [/Volume:/gi, "Volume:"],
    [/Volatility:/gi, "Volatilitas:"],
    [/Organic:/gi, "Organik:"],
    [/Mcap:/gi, "Mcap:"],
    [/Smart wallets:/gi, "Smart wallet:"],
    [/Fees paid:/gi, "Fee dibayar:"],
    [/Top10:/gi, "Top10:"],
    [/Bots:/gi, "Bot:"],
    [/Summary:/gi, "Ringkasan:"],
    [/Positions: /gi, "Posisi: "],
    [/no action/gi, "tidak ada aksi"],
    [/Top candidates/gi, "Kandidat teratas"],
    [/No cached candidates yet\. Run \/screen first\./gi, "Belum ada kandidat cache. Jalankan /screen dulu."],
    [/Filter autotune: relaxed/gi, "Filter autotune: dilonggarkan"],
    [/\bdone\b/gi, "selesai"],
    [/\bfailed\b/gi, "gagal"],
    [/\bclosed\b/gi, "ditutup"],
    [/\bsubmitted\b/gi, "terkirim"],
  ];
  for (const [re, rep] of rules) s = s.replace(re, rep);
  return s;
}

/** Semua teks yang dikirim ke Telegram owner. */
export function localizeTelegramReport(text = "") {
  return translateReport(text);
}

export function formatNoCandidatesReport(examples, suffix = "") {
  const body = examples
    ? `Tidak ada kandidat.\nContoh yang difilter:\n${examples}`
    : `Tidak ada kandidat${suffix ? ` (${suffix})` : ""}.`;
  return body;
}

export function formatNoDeployReport({ candidateName, skipReason, rejectedLine }) {
  return [
    "⛔ TIDAK DEPLOY",
    "",
    "Siklus selesai tanpa entry valid.",
    "",
    "KANDIDAT TERBAIK",
    candidateName || "tidak ada",
    "",
    "ALASAN DILEWATI",
    skipReason,
    "",
    "DITOLAK",
    rejectedLine,
  ].join("\n");
}

export const TG = {
  deployed: (pair, amountSol, priceStr, coverageStr, poolStr, position, tx) =>
    `🚀 <b>DEPLOY BARU</b>\n` +
    `──────────────\n` +
    `Pair: <b>${pair}</b>\n` +
    `Jumlah: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Posisi: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,

  priceRange: (min, max) =>
    `Rentang harga: ${min < 0.0001 ? min.toExponential(3) : min.toFixed(6)} – ${max < 0.0001 ? max.toExponential(3) : max.toFixed(6)}\n`,

  rangeCover: (down, up, width) =>
    `Cakupan range: ${fmtPct(down)} downside | ${fmtPct(up)} upside | ${fmtPct(width)} total\n`,

  poolMeta: (binStep, baseFee) =>
    `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`,

  closed: (pair, pnlUsd, pnlPct, feesUsd) => {
    const sign = pnlUsd >= 0 ? "+" : "";
    const color = pnlUsd >= 0 ? "🟢" : "🔴";
    const feeLine = feesUsd != null ? `\nFee: ${fmtUsd(feesUsd)}` : "";
    return (
      `🔒 <b>TUTUP POSISI</b> ${pair}\n` +
      `──────────────\n` +
      `PnL: ${color} ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)${feeLine}`
    );
  },

  swapped: (inSym, outSym, amountIn, amountOut, tx) =>
    `🔄 <b>SWAP</b> ${inSym} → ${outSym}\n` +
    `──────────────\n` +
    `Masuk: ${amountIn ?? "?"}\n` +
    `Keluar: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,

  outOfRange: (pair, minutesOOR) =>
    `⚠️ <b>DI LUAR RANGE</b> ${pair}\n` +
    `──────────────\n` +
    `Sudah OOR: ${minutesOOR} menit`,

  managementCycle: (report) =>
    `🔄 <b>Siklus Manajemen</b>\n` +
    `──────────────\n` +
    `${localizeTelegramReport(report)}\n` +
    `──────────────\n` +
    `💡 /positions untuk detail`,

  screeningCycle: (report) =>
    `🔍 <b>Siklus Screening</b>\n` +
    `──────────────\n` +
    `${localizeTelegramReport(report)}\n` +
    `──────────────\n` +
    `💡 /candidates untuk daftar`,

  error: (msg) => `❌ <b>Error</b>\n──────────────\n${msg}`,
  noOpenPositions: "📭 Tidak ada posisi terbuka.",
  invalidIndex: "Nomor tidak valid. Jalankan /positions dulu.",
  closing: (pair) => `⏳ Menutup ${pair}...`,
  closedManual: (pair, pnl, txs, claimNote) =>
    `✅ <b>Ditutup</b> ${pair}\n──────────────\nPnL: ${pnl}\nTx close: ${txs}${claimNote ? "\n" + claimNote : ""}`,
  closeFailed: (result) => `❌ <b>Gagal tutup</b>\n──────────────\n${JSON.stringify(result)}`,
  closingAll: (n) => `⏳ Menutup ${n} posisi...`,
  closeAllDone: (results) => `✅ Selesai tutup semua.\n──────────────\n${results}`,
  noteSet: (pair, note) => `✅ <b>Catatan</b> ${pair}:\n"${note}"`,
  configFailed: (unknown) => `❌ Gagal update config.\nTidak dikenal: ${unknown}`,
  configUpdated: (key, value) => `✅ Diupdate <b>${key}</b> = ${JSON.stringify(value)}`,
  queued: (n, text) => `⏳ Antrian (${n}): "${text.slice(0, 60)}"`,
  queueFull: "⚠️ Antrian penuh (5 pesan). Tunggu agent selesai.",
  paused: "⏸ Siklus otomatis dijeda. Kontrol Telegram tetap aktif. /resume untuk lanjut.",
  resumed: "▶️ Siklus otomatis dilanjutkan.",
  alreadyRunning: "Siklus otomatis sudah berjalan.",
  settingsError: (msg) => `❌ Settings error: ${msg}`,
  photoSaved: (filename, path, caption) =>
    [
      "📷 Screenshot disimpan untuk Hermes vision.",
      `File: ${filename}`,
      `Path: ${path}`,
      caption ? `Caption: ${caption}` : "Kirim ke Hermes: baca screenshot Telegram terbaru.",
    ].join("\n"),
  photoSaveFailed: (msg) => `❌ Gagal simpan foto: ${msg}`,
  liveUpdate: "🤖 Update Langsung",
  liveStarting: "Memulai...",
  liveRequest: (text) => `Permintaan: ${text.slice(0, 240)}`,
};

export const BOT_COMMANDS_ID = [
  { command: "help", description: "Tampilkan perintah" },
  { command: "status", description: "Snapshot wallet + posisi" },
  { command: "wallet", description: "Wallet, deploy, status HiveMind" },
  { command: "positions", description: "Daftar posisi terbuka" },
  { command: "pool", description: "Detail satu posisi terbuka" },
  { command: "close", description: "Tutup posisi by nomor" },
  { command: "closeall", description: "Tutup semua posisi" },
  { command: "set", description: "Set catatan/instruksi posisi" },
  { command: "config", description: "Tampilkan config runtime" },
  { command: "settings", description: "Menu tombol config umum" },
  { command: "setcfg", description: "Update key config" },
  { command: "screen", description: "Refresh daftar kandidat" },
  { command: "candidates", description: "Kandidat ter-cache terbaru" },
  { command: "deploy", description: "Deploy kandidat by nomor" },
  { command: "briefing", description: "Briefing pagi" },
  { command: "hive", description: "Status sinkron HiveMind" },
  { command: "pause", description: "Hentikan siklus cron" },
  { command: "resume", description: "Lanjutkan siklus cron" },
  { command: "stop", description: "Matikan agent" },
];

const TOOL_LABELS_ID = {
  get_token_info: "info token",
  get_token_narrative: "narasi token",
  get_token_holders: "holder token",
  get_top_candidates: "kandidat teratas",
  get_pool_detail: "detail pool",
  get_active_bin: "bin aktif",
  deploy_position: "deploy posisi",
  close_position: "tutup posisi",
  claim_fees: "klaim fee",
  swap_token: "swap token",
  update_config: "update config",
  get_my_positions: "ambil posisi",
  get_wallet_balance: "saldo wallet",
  check_smart_wallets_on_pool: "cek smart wallet",
  study_top_lpers: "studi top LP",
  get_top_lpers: "top LP",
  search_pools: "cari pool",
  discover_pools: "discover pool",
  get_pool_memory: "memori pool",
  layer_resource_gateway: "gateway resource",
};

export function toolLabelId(name) {
  return TOOL_LABELS_ID[name] || name.replace(/_/g, " ");
}

export function summarizeToolResultId(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `posisi ${String(result.position).slice(0, 8)}...` : "terkirim";
    case "close_position":
      return result.success ? "ditutup" : (result.reason || "gagal");
    case "claim_fees":
      return result.claimed_amount != null ? `klaim ${result.claimed_amount}` : "selesai";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "diupdate";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} kandidat`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} posisi`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LP`;
    default:
      return result.success === false ? "gagal" : "selesai";
  }
}

export function formatHelpTextId() {
  return [
    "Perintah Telegram",
    "",
    "/help — tampilkan perintah",
    "/status — snapshot wallet + posisi",
    "/wallet — wallet, jumlah deploy, HiveMind",
    "/positions — daftar posisi terbuka",
    "/pool <n> — detail satu posisi",
    "/close <n> — tutup posisi by nomor",
    "/closeall — tutup semua posisi",
    "/set <n> <catatan> — set instruksi posisi",
    "/config — config runtime penting",
    "/settings — menu tombol config",
    "/setcfg <key> <value> — update config",
    "/screen — refresh kandidat deterministik",
    "/candidates — kandidat cache terbaru",
    "/deploy <n> — deploy kandidat by nomor",
    "/briefing — briefing pagi",
    "/hive — status HiveMind",
    "/hive pull — pull HiveMind manual",
    "/pause — hentikan siklus cron",
    "/resume — lanjutkan siklus cron",
    "/stop — matikan agent",
  ].join("\n");
}

export function formatWalletStatusId(wallet, positions, maxPositions) {
  const deployAmount = wallet.nextDeploy ?? wallet.deployAmount;
  const hive = wallet.hiveMind ?? "?";
  return [
    `💼 <b>Status Wallet</b>`,
    div(),
    kv("SOL", `${wallet.sol} SOL ($${wallet.sol_usd})`),
    kv("Harga SOL", `$${wallet.sol_price}`),
    kv("Posisi", `${positions.total_positions}/${maxPositions}`),
    kv("Deploy berikutnya", `${deployAmount ?? "?"} SOL`),
    kv("Dry run", wallet.dryRun ? "ya" : "tidak"),
    kv("HiveMind", hive),
  ].join("\n");
}

export function formatConfigSnapshotId(cfg, hiveEnabled, hiveAgentId) {
  return [
    `⚙️ <b>Snapshot Config</b>`,
    div(),
    `Strategi: ${cfg.strategy} | bins ${cfg.minBinsBelow}-${cfg.maxBinsBelow} (def ${cfg.defaultBinsBelow})`,
    `Deploy: ${cfg.deployAmountSol} SOL | gas ${cfg.gasReserve} | maxPosisi ${cfg.maxPositions}`,
    `SL: ${cfg.stopLossPct}% | TP: ${cfg.takeProfitPct}%`,
    `Trailing: ${cfg.trailingTakeProfit ? "on" : "off"} (trig ${cfg.trailingTriggerPct}% / drop ${cfg.trailingDropPct}%)`,
    `OOR: ${cfg.outOfRangeWaitMinutes}m | cooldown ${cfg.oorCooldownTriggerCount}x/${cfg.oorCooldownHours}j`,
    `Repeat cooldown: ${cfg.repeatDeployCooldownEnabled ? "on" : "off"} ${cfg.repeatDeployCooldownTriggerCount}x/${cfg.repeatDeployCooldownHours}j`,
    `Yield floor: ${cfg.minFeePerTvl24h}% | min umur ${cfg.minAgeBeforeYieldCheck}m`,
    `Screening: ${cfg.category}/${cfg.timeframe} | TVL ${cfg.minTvl}-${cfg.maxTvl}`,
    `Interval: manage ${cfg.managementIntervalMin}m | screen ${cfg.screeningIntervalMin}m`,
    `HiveMind: ${hiveEnabled ? "aktif" : "nonaktif"}${hiveAgentId ? ` | ${hiveAgentId}` : ""}`,
  ].join("\n");
}

export function describeLatestCandidatesId(candidates, updatedAt) {
  if (!candidates?.length) return "📭 Belum ada kandidat cache. Jalankan /screen dulu.";
  const lines = candidates.map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. <b>${pool.name}</b>\n   fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = updatedAt
    ? new Date(updatedAt).toLocaleString("id-ID", { hour12: false })
    : "tidak diketahui";
  return `🔎 <b>Kandidat Terbaru (${candidates.length})</b>\n${div()}\nupdate ${age}\n${div()}\n${lines.join(`\n${div()}\n`)}`;
}

export function formatPositionsListId(positions, total, solMode) {
  const cur = solMode ? "◎" : "$";
  const lines = positions.map((p, i) => {
    const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
    const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
    const oor = !p.in_range ? " ⚠️OOR" : "";
    return `${i + 1}. <b>${p.pair}</b>${oor}\n   💰 ${cur}${p.total_value_usd} | PnL ${pnl} | fee ${cur}${p.unclaimed_fees_usd} | ${age}`;
  });
  return `📊 <b>Posisi Terbuka (${total})</b>\n${div()}\n${lines.join(`\n${div()}\n`)}\n${div()}\n/close <n> tutup | /set <n> <catatan>`;
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// Helper formatting
function fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}
function div() {
  return "──────────────";
}
function kv(k, v) {
  return `${k}: ${v}`;
}