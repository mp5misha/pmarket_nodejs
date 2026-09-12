const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
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
 * chat completions API and returns the assistant's reply text. `apiKey` and
 * `promptTemplate`, when given (saved via the app's settings window), take
 * precedence over DEEPSEEK_API_KEY and the built-in default template. */
export async function analyzeMarket(market, { apiKey, promptTemplate } = {}) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      "No DeepSeek API key configured. Set one in Settings, or via the DEEPSEEK_API_KEY environment variable."
    );
  }
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
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: prompt }],
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
  return content;
}
