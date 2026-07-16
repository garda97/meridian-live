import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool, sanitizeToolName } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "rebalance_position", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions", "rebalance_position"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";
// 9router-local models only — stepfun/openrouter-direct without router creds will 404.
const FALLBACK_MODEL_DEFAULT = process.env.LLM_FALLBACK_MODEL || "openrouter/openrouter/free";
const FALLBACK_MODEL_ALT = "openrouter/tencent/hy3:free";

function resolveFallbackModel(primary) {
  const fb = FALLBACK_MODEL_DEFAULT;
  if (primary && primary !== fb) return fb;
  return FALLBACK_MODEL_ALT;
}

function isMissingProviderError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  const status = error?.status ?? error?.response?.status;
  return status === 404
    || /no active credentials|not a valid model|model not found|provider.*unavailable/.test(msg);
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER" || agentType === "SCREENER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

/** Screening may end with a formatted no-deploy report without calling deploy_position. */
function isScreenerNoDeployAnswer(content) {
  return /⛔\s*(NO DEPLOY|TIDAK DEPLOY)/i.test(String(content || ""));
}

function extractReasoningText(msg) {
  const direct = String(msg?.reasoning ?? "").trim();
  if (direct) return direct;
  const details = msg?.reasoning_details;
  if (!Array.isArray(details)) return "";
  return details
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "reasoning.text" && part?.text) return part.text;
      if (part?.text) return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Some 9router/Hermes providers return empty content but populate reasoning/refusal fields. */
function getAssistantText(msg) {
  const content = String(msg?.content ?? "").trim();
  if (content) return content;
  const refusal = String(msg?.refusal ?? "").trim();
  if (refusal) return refusal;
  return extractReasoningText(msg);
}

function hydrateAssistantMessage(msg) {
  return msg;
}

function hasReasoningOnly(msg) {
  return !String(msg?.content ?? "").trim() && Boolean(extractReasoningText(msg));
}

/** SCREENER must return the Telegram report format, not English chain-of-thought. */
function isScreenerIncompleteAnswer(content) {
  const c = String(content || "").trim();
  if (!c) return true;
  if (/⛔\s*(NO DEPLOY|TIDAK DEPLOY)|🚀\s*DEPLOY|KANDIDAT TERBAIK/i.test(c)) return false;
  if (c.length < 120) return true;
  if (/let me analyze|let me reconsider|i need to think|step by step/i.test(c)) return true;
  return false;
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  // Stays true for the whole run once a thinking-mode provider rejects tool_choice
  let omitToolChoice = false;

  const MAX_EMPTY_RETRIES = 3;
  let emptyStreak = 0;
  // After repeated empty responses, swap to the fallback model for the rest of the run
  let emptyFallbackActive = false;
  let fallbackModel = null;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;
      if (!fallbackModel) fallbackModel = resolveFallbackModel(activeModel);

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      let response;
      let usedModel = emptyFallbackActive ? fallbackModel : activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes.
      // SCREENER skips required: Hermes-free often returns empty under forced tools; no-deploy answers are valid.
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let stepToolChoice = (
        agentType !== "SCREENER"
        && step === 0
        && (ACTION_INTENTS.test(goal) || mustUseRealTool)
      ) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reqParams = {
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
            stream: false,
          };
          if (!omitToolChoice) reqParams.tool_choice = stepToolChoice;
          response = await client.chat.completions.create(reqParams);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (stepToolChoice === "required" && isToolChoiceRequiredError(error)) {
            stepToolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            log("agent", "Provider thinking mode does not support tool_choice — retrying without it");
            attempt -= 1;
            continue;
          }
          if (isMissingProviderError(error) && usedModel !== fallbackModel) {
            usedModel = fallbackModel;
            emptyFallbackActive = true;
            log("agent", `Provider unavailable for ${activeModel} — switching to fallback ${fallbackModel}`);
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== fallbackModel) {
            usedModel = fallbackModel;
            emptyFallbackActive = true;
            log("agent", `Switching to fallback model ${fallbackModel}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = hydrateAssistantMessage(response.choices[0].message);
      const assistantText = getAssistantText(msg);
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Some providers return null/whitespace content with no tool_calls — retry without burning a step
        if (!assistantText) {
          if (hasReasoningOnly(msg)) {
            log("agent", "Reasoning-only response — nudging model for final formatted answer");
            messages.push({
              role: providerMode === "system" ? "system" : "user",
              content: providerMode === "system"
                ? "Do not stop at internal reasoning. Reply now in the message content field using the exact Indonesian report format from the goal (⛔ TIDAK DEPLOY or 🚀 DEPLOY)."
                : "[SYSTEM REMINDER]\nDo not stop at internal reasoning. Reply now in the message content field using the exact Indonesian report format from the goal (⛔ TIDAK DEPLOY or 🚀 DEPLOY).",
            });
            step -= 1;
            continue;
          }
          if (stepToolChoice === "required") {
            stepToolChoice = "auto";
            log("agent", "Empty response with tool_choice=required — retrying with tool_choice=auto");
            step -= 1;
            continue;
          }
          emptyStreak += 1;
          if (emptyStreak >= MAX_EMPTY_RETRIES) {
            log("agent", `Empty response cap reached (${emptyStreak}/${MAX_EMPTY_RETRIES}), aborting`);
            return {
              content: "The model returned empty responses repeatedly. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          if (emptyStreak >= 1 && !emptyFallbackActive && (model || DEFAULT_MODEL) !== fallbackModel) {
            emptyFallbackActive = true;
            stepToolChoice = "auto";
            log("agent", `Empty response — switching to fallback model ${fallbackModel}`);
          }
          const wait = emptyStreak * 2000;
          log("agent", `Empty response, retrying in ${wait / 1000}s (${emptyStreak}/${MAX_EMPTY_RETRIES})...`);
          await sleep(wait);
          step -= 1;
          continue;
        }
        messages.push(msg);
        emptyStreak = 0;
        if (agentType === "SCREENER" && isScreenerIncompleteAnswer(msg.content)) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `SCREENER incomplete answer (${noToolRetryCount}/3) — requesting formatted report`);
          if (noToolRetryCount >= 3) {
            return {
              content: "Screening selesai tetapi model tidak mengembalikan format laporan yang valid. Coba lagi pada siklus berikutnya.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "Your last reply was not a valid screening report. Respond ONLY with the final Indonesian Telegram format from the goal: either the full ⛔ TIDAK DEPLOY block or the full 🚀 DEPLOY block after a real deploy_position tool result. No English analysis."
              : "[SYSTEM REMINDER]\nYour last reply was not a valid screening report. Respond ONLY with the final Indonesian Telegram format from the goal: either the full ⛔ TIDAK DEPLOY block or the full 🚀 DEPLOY block after a real deploy_position tool result. No English analysis.",
          });
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          if (agentType === "SCREENER" && isScreenerNoDeployAnswer(msg.content)) {
            log("agent", "SCREENER no-deploy answer accepted without tool call");
            return { content: msg.content, userMessage: goal };
          }
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          const screenerReminder = agentType === "SCREENER"
            ? "If no pool is worth deploying, reply with the ⛔ TIDAK DEPLOY format from the goal — that is valid without tools. If you ARE deploying, you MUST call deploy_position first and only report results from the real tool response. Never claim 🚀 DEPLOY without a deploy_position tool result."
            : "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.";
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? screenerReminder
              : `[SYSTEM REMINDER]\n${screenerReminder}`,
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      messages.push(msg);
      emptyStreak = 0;
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        // Normalize model-mangled names (artifacts, prefixes, CompatGetTopCandidates-style aliases)
        // so the once-per-session locks below see the same name the executor resolves.
        const functionName = sanitizeToolName(toolCall.function.name).name;
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs, { actor: agentType });
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
