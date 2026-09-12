const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const REQUEST_TIMEOUT_MS = 90000; // background/probability analysis can take a while

// deepseek-chat/deepseek-reasoner were retired; deepseek-flash and
// deepseek-v4-pro are the current models, both accepting a reasoning_effort
// parameter. The UI exposes this as a 3-way "non-thinking / thinking /
// thinking (max)" choice rather than the full none/low/high/max range —
// low and xhigh both collapse to their nearer neighbor server-side anyway.
export const AVAILABLE_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
export const REASONING_EFFORT_OPTIONS = [
  { value: "none", label: "Non-thinking" },
  { value: "high", label: "Thinking" },
  { value: "max", label: "Thinking (max)" },
];
export const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
export const DEFAULT_REASONING_EFFORT = "high";

// Rough list pricing in USD per 1M tokens, for the "estimated cost" shown
// alongside a saved analysis. DeepSeek's actual billed price varies (peak
// vs. off-peak, cache hits) — treat this purely as a budgeting estimate,
// not an accounting-accurate figure.
const PRICING_PER_MILLION_USD = {
  "deepseek-flash": { input: 0.15, output: 0.6 },
  "deepseek-v4-pro": { input: 0.955, output: 1.2 },
};

export function estimateCost(modelName, promptTokens, completionTokens) {
  const pricing = PRICING_PER_MILLION_USD[modelName];
  if (!pricing || promptTokens == null || completionTokens == null) return null;
  return (promptTokens / 1e6) * pricing.input + (completionTokens / 1e6) * pricing.output;
}

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

/** Fills a prompt template's {slug}/{yes_price}/{no_price}/{end_date}/
 * {liquidity} placeholders from a market row (server's snake_case shape:
 * current_price, no_price, resolution_date, liquidity). */
export function buildAnalysisPrompt(market, template = DEFAULT_PROMPT_TEMPLATE) {
  return template
    .replaceAll("{slug}", market.slug ?? "unknown")
    .replaceAll("{yes_price}", fmtPrice(market.current_price))
    .replaceAll("{no_price}", fmtPrice(market.no_price))
    .replaceAll("{end_date}", fmtDate(market.resolution_date))
    .replaceAll("{liquidity}", fmtMoney(market.liquidity));
}

/** Sends the analysis prompt for one market to DeepSeek's (OpenAI-compatible)
 * chat completions API and returns the reply plus token usage. `apiKey` and
 * `promptTemplate`, when given (saved via the app's settings window), take
 * precedence over DEEPSEEK_API_KEY and the built-in default template.
 * `model`/`reasoningEffort` default to DEFAULT_MODEL/DEFAULT_REASONING_EFFORT. */
export async function analyzeMarket(
  market,
  { apiKey, promptTemplate, model, reasoningEffort } = {}
) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      "No DeepSeek API key configured. Set one in Settings, or via the DEEPSEEK_API_KEY environment variable."
    );
  }
  const chosenModel = model || DEFAULT_MODEL;
  const effort = reasoningEffort || DEFAULT_REASONING_EFFORT;
  const prompt = buildAnalysisPrompt(market, promptTemplate || DEFAULT_PROMPT_TEMPLATE);

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
        model: chosenModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        reasoning_effort: effort,
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
    promptText: prompt,
    model: chosenModel,
    reasoningEffort: effort,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    tokensUsed: usage.total_tokens ?? null,
  };
}
