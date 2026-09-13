import { getPool, ensureSchema, getMarket, getSetting, createAnalysis } from "../../../lib/db.js";
import {
  analyzeMarket,
  DEEPSEEK_MODEL,
  extractFairProbability,
  buildWhaleAnalysisPrompt,
  DEFAULT_WHALE_PROMPT_TEMPLATE,
  callChatCompletions,
} from "../../../lib/deepseek.js";
import { DEEPSEEK_KEY_SETTING, DEEPSEEK_PROMPT_SETTING, DEEPSEEK_WHALE_PROMPT_SETTING } from "../../../lib/settings.js";
import { getWhalePositionsForSlug } from "../../../lib/whales.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });
    const apiKey = await getSetting(pool, DEEPSEEK_KEY_SETTING);
    const { kind = "market" } = req.body || {};
    if (kind !== "market" && kind !== "whales") {
      return res.status(400).json({ error: "kind must be 'market' or 'whales'" });
    }

    // See server/src/index.js's matching route for the full rationale —
    // "AI analysis of Whales activity" (kind: "whales") is a parallel
    // analysis stream on the same market, its own prompt built from whale
    // positions instead of market data, otherwise reusing the same storage.
    let result;
    let fairProbYes = null;
    if (kind === "whales") {
      const whalePositions = await getWhalePositionsForSlug(pool, row.slug);
      if (whalePositions.length === 0) {
        return res.status(400).json({ error: "This market has no whale positions to analyze" });
      }
      const promptTemplate = (await getSetting(pool, DEEPSEEK_WHALE_PROMPT_SETTING)) || DEFAULT_WHALE_PROMPT_TEMPLATE;
      const promptText = buildWhaleAnalysisPrompt(row, whalePositions, promptTemplate);
      const raw = await callChatCompletions([{ role: "user", content: promptText }], { apiKey });
      result = { ...raw, promptText };
    } else {
      const promptTemplate = await getSetting(pool, DEEPSEEK_PROMPT_SETTING);
      result = await analyzeMarket(row, { apiKey, promptTemplate });
      fairProbYes = extractFairProbability(result.content);
    }

    // The client renders `analysis` as a stored analysis record (id,
    // created_at, model_name, result_text, ...) — the shape the Express/
    // SQLite backend's history feature persists. Persisting a real row here
    // (rather than a synthesized one-off object) is also what lets
    // api/analyses/[id]/follow-up.js build on it afterwards.
    const analysis = await createAnalysis(pool, {
      marketSlug: row.slug,
      promptText: result.promptText,
      resultText: result.content,
      modelName: DEEPSEEK_MODEL,
      tokensUsed: result.tokensUsed,
      kind,
      fairProbYes,
    });
    res.status(200).json({ analysis, cached: false });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}
