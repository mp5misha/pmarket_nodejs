const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const REQUEST_TIMEOUT_MS = 90000; // background/probability analysis can take a while

// Placeholders the prompt template may reference — substituted from the
// selected market's own stored data at analysis time.
export const PROMPT_VARIABLES = ["slug", "yes_price", "no_price", "end_date", "liquidity"];

export const DEFAULT_PROMPT_TEMPLATE =
  "Could you please analyze the real probability and analyze all the background " +
  "information available for the following event at Polymarket: {slug}\n\n" +
  "Market data:\n" +
  "- YES price: {yes_price}\n" +
  "- NO price: {no_price}\n" +
  "- Resolution date: {end_date}\n" +
  "- Liquidity: {liquidity}";

function fmtPrice(v) {
  return v === null || v === undefined ? "unknown" : Number(v).toFixed(3);
}

function fmtDate(v) {
  if (!v) return "unknown";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

function fmtMoney(v) {
  return v === null || v === undefined ? "unknown" : `$${Number(v).toLocaleString()}`;
}

// See server/src/deepseek.js's FAIR_PROBABILITY_INSTRUCTION/
// extractFairProbability for the full rationale — mirrored here verbatim.
const FAIR_PROBABILITY_INSTRUCTION =
  "\n\nAfter your analysis, on its own final line, output exactly (no other " +
  "text on that line): FAIR_PROBABILITY_YES: <your estimated probability " +
  "that this resolves YES, as a decimal between 0 and 1>";

const FAIR_PROBABILITY_RE = /FAIR_PROBABILITY_YES:\s*([01](?:\.\d+)?|\.\d+)/i;

export function extractFairProbability(resultText) {
  if (!resultText) return null;
  const match = resultText.match(FAIR_PROBABILITY_RE);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** Fills a prompt template's {slug}/{yes_price}/{no_price}/{end_date}/
 * {liquidity} placeholders from a market row (server's snake_case shape:
 * current_price, no_price, resolution_date, liquidity). */
export function buildAnalysisPrompt(market, template = DEFAULT_PROMPT_TEMPLATE) {
  const filled = template
    .replaceAll("{slug}", market.slug ?? "unknown")
    .replaceAll("{yes_price}", fmtPrice(market.current_price))
    .replaceAll("{no_price}", fmtPrice(market.no_price))
    .replaceAll("{end_date}", fmtDate(market.resolution_date))
    .replaceAll("{liquidity}", fmtMoney(market.liquidity));
  return filled + FAIR_PROBABILITY_INSTRUCTION;
}

// See server/src/deepseek.js's WHALE_PROMPT_VARIABLES/
// DEFAULT_WHALE_PROMPT_TEMPLATE/buildWhaleAnalysisPrompt — mirrored here
// verbatim (this deploy target has no per-user template picker, but the
// same substitution logic applies to its single global whale-prompt
// setting — see settings.js).
export const WHALE_PROMPT_VARIABLES = [
  "slug",
  "whale_name",
  "whale_position_direction",
  "whale_position_value",
  "whale_unrealized_pnl",
];

export const DEFAULT_WHALE_PROMPT_TEMPLATE =
  "Analyze the whale trading activity for the following Polymarket event: {slug}\n\n" +
  "The top-50 leaderboard traders below currently hold a position in this market " +
  "(each list is numbered in the same order, so entry N in every list is the same trader):\n\n" +
  "Trader:\n{whale_name}\n\n" +
  "Position direction (Yes/No):\n{whale_position_direction}\n\n" +
  "Position value:\n{whale_position_value}\n\n" +
  "Unrealized P&L:\n{whale_unrealized_pnl}\n\n" +
  "Based on this whale activity, assess whether it signals bullish or bearish " +
  "conviction for this market, and whether the positioning suggests informed/" +
  "smart money confidence in a particular outcome.";

function whaleLabel(w) {
  if (w.traderName) return w.traderName;
  const addr = w.traderWallet;
  return addr && addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr || "Unknown trader";
}

function fmtPnl(cashPnl, percentPnl) {
  const money = fmtMoney(cashPnl);
  if (percentPnl == null) return money;
  return `${money} (${(Number(percentPnl) * 100).toFixed(1)}%)`;
}

export function buildWhaleAnalysisPrompt(market, whalePositions, template = DEFAULT_WHALE_PROMPT_TEMPLATE) {
  const numbered = (fn) => whalePositions.map((w, i) => `${i + 1}. ${fn(w)}`).join("\n");
  return template
    .replaceAll("{slug}", market.slug ?? "unknown")
    .replaceAll("{whale_name}", numbered(whaleLabel))
    .replaceAll("{whale_position_direction}", numbered((w) => (w.outcome ? w.outcome : "unknown")))
    .replaceAll("{whale_position_value}", numbered((w) => fmtMoney(w.currentValue)))
    .replaceAll("{whale_unrealized_pnl}", numbered((w) => fmtPnl(w.cashPnl, w.percentPnl)));
}

/** Shared chat-completions call used by a fresh market analysis, a
 * follow-up, and a whale-activity analysis — see server/src/deepseek.js's
 * matching export for the full rationale. This deploy target has no
 * model/reasoning-effort picker (Phase 3+, Express/SQLite only) — always
 * DEEPSEEK_MODEL. */
export async function callChatCompletions(messages, { apiKey } = {}) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      "No DeepSeek API key configured. Set one in Settings, or via the DEEPSEEK_API_KEY environment variable."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("DeepSeek request timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek returned an empty response.");
  }
  const usage = data?.usage || {};
  return {
    content,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    tokensUsed: usage.total_tokens ?? null,
  };
}

/** Sends the analysis prompt for one market to DeepSeek's (OpenAI-compatible)
 * chat completions API and returns the reply plus token usage. `apiKey` and
 * `promptTemplate`, when given (saved via the app's settings window), take
 * precedence over DEEPSEEK_API_KEY and the built-in default template. */
export async function analyzeMarket(market, { apiKey, promptTemplate } = {}) {
  const prompt = buildAnalysisPrompt(market, promptTemplate || DEFAULT_PROMPT_TEMPLATE);
  const result = await callChatCompletions([{ role: "user", content: prompt }], { apiKey });
  return { ...result, promptText: prompt };
}

/** Continues an existing analysis thread (Phase 4) — `threadMessages` is the
 * reconstructed user/assistant history (see db.getAnalysisThread), and
 * `followUpText` is the new question appended as the final user turn. */
export async function askFollowUp(threadMessages, followUpText, { apiKey } = {}) {
  return callChatCompletions([...threadMessages, { role: "user", content: followUpText }], { apiKey });
}
