import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const DECISION_LOG_FILE = repoPath("decision-log.json");
const MAX_DECISIONS = 100;

function load() {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch (error) {
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${error.message}`);
    return { decisions: [] };
  }
}

function save(data) {
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function stripThinkBlocks(text) {
  if (!text) return "";
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function normalizeSectionHeaders(text) {
  return text
    .replace(/⛔\s*NO DEPLOY\s*/gi, "⛔ NO DEPLOY\n")
    .replace(/\bBEST LOOKING CANDIDATE\b/gi, "\nBEST LOOKING CANDIDATE\n")
    .replace(/\bWHY SKIPPED\b/gi, "\nWHY SKIPPED\n")
    .replace(/\bWHY THIS WON\b/gi, "\nWHY THIS WON\n")
    .replace(/\s+REJECTED\s+-\s+/g, "\nREJECTED\n- ")
    .replace(/\bREJECTED\b/g, "\nREJECTED\n")
    .replace(/\bMARKET\b/gi, "\nMARKET\n")
    .replace(/\bAUDIT\b/gi, "\nAUDIT\n");
}

function parseRejectedList(section) {
  if (!section) return [];
  const cleaned = section.replace(/\s+/g, " ").trim().replace(/^-\s*/, "");
  const parts = cleaned.split(/\s+-\s+(?=[\w][\w.-]*:\s)/);
  return parts.map((part) => {
    const match = part.match(/^([\w][\w.-]*):\s*(.+)$/);
    if (match) return sanitize(`${match[1]}: ${match[2]}`, 180);
    return sanitize(part, 180);
  }).filter(Boolean).slice(0, 8);
}

function parseMetricsBlock(section) {
  const metrics = {};
  if (!section) return metrics;
  const patterns = [
    [/fee\/tvl:\s*([\d.]+)%?/i, "fee_tvl_pct"],
    [/volume:\s*\$?([\d,.]+[kKmMbB]?)/i, "volume"],
    [/tvl:\s*\$?([\d,.]+[kKmMbB]?)/i, "tvl"],
    [/volatility:\s*([\d.]+)/i, "volatility"],
    [/organic:\s*([\d.]+)/i, "organic"],
    [/mcap:\s*\$?([\d,.]+[kKmMbB]?)/i, "mcap"],
    [/age:\s*([\d.]+)h/i, "age_hours"],
    [/top10:\s*([\d.]+)%/i, "top10_pct"],
    [/bots:\s*([\d.]+)%/i, "bots_pct"],
    [/fees paid:\s*([\d.]+)\s*sol/i, "fees_sol"],
  ];
  for (const [pattern, key] of patterns) {
    const hit = section.match(pattern);
    if (hit) metrics[key] = hit[1].replace(/,/g, "");
  }
  return metrics;
}

function extractRisks(text) {
  const risks = [];
  const riskRe = /(?:risk|concern|caution|warning)[^.!?\n]{0,120}/gi;
  let match;
  while ((match = riskRe.exec(text)) !== null) {
    const line = match[0].replace(/\s+/g, " ").trim();
    if (line.length > 12) risks.push(sanitize(line, 140));
  }
  return [...new Set(risks)].filter(Boolean).slice(0, 6);
}

export function parseScreeningReport(raw) {
  const text = normalizeSectionHeaders(stripThinkBlocks(raw));
  const parsed = {
    pool_name: null,
    reason: null,
    rejected: [],
    risks: [],
    metrics: {},
  };

  const candidate = text.match(/BEST LOOKING CANDIDATE\s*\n\s*([^\n]+)/i)
    || text.match(/BEST LOOKING CANDIDATE\s+(\S+-SOL|\S+)/i);
  if (candidate) {
    const name = candidate[1].trim();
    if (name && !/^(none|n\/a)$/i.test(name)) parsed.pool_name = name;
  }

  const whySkipped = text.match(/WHY SKIPPED\s*\n([\s\S]*?)(?=\nREJECTED|\nMARKET|\n🚀|$)/i);
  if (whySkipped) {
    parsed.reason = sanitize(whySkipped[1], 500);
    parsed.risks = extractRisks(whySkipped[1]);
  }

  const rejected = text.match(/REJECTED\s*\n([\s\S]*?)(?=\nMARKET|\n🚀|$)/i)
    || text.match(/REJECTED\s+([\s\S]*?)$/i);
  if (rejected) {
    parsed.rejected = parseRejectedList(rejected[1]);
  }

  const market = text.match(/MARKET\s*\n([\s\S]*?)(?=\nAUDIT|\nWHY|$)/i);
  const audit = text.match(/AUDIT\s*\n([\s\S]*?)(?=\nWHY|$)/i);
  parsed.metrics = {
    ...parseMetricsBlock(market?.[1]),
    ...parseMetricsBlock(audit?.[1]),
  };

  return parsed;
}

export function enrichDecisionEntry(entry, reportText) {
  if (!reportText) return entry;
  const parsed = parseScreeningReport(reportText);
  const hasMetrics = entry.metrics && Object.keys(entry.metrics).length > 0;
  return {
    ...entry,
    pool_name: entry.pool_name || parsed.pool_name,
    reason: parsed.reason || entry.reason || sanitize(stripThinkBlocks(reportText), 500),
    rejected: entry.rejected?.length ? entry.rejected : parsed.rejected,
    risks: entry.risks?.length ? entry.risks : parsed.risks,
    metrics: hasMetrics ? entry.metrics : parsed.metrics,
  };
}

export function appendDecision(entry) {
  const data = load();
  const decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean).slice(0, 8) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10) {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
