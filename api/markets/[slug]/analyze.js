import { getPool, ensureSchema, getMarket, getSetting, createAnalysis } from "../../../lib/db.js";
import { analyzeMarket, DEEPSEEK_MODEL } from "../../../lib/deepseek.js";
import { DEEPSEEK_KEY_SETTING, DEEPSEEK_PROMPT_SETTING } from "../../../lib/settings.js";

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
    const promptTemplate = await getSetting(pool, DEEPSEEK_PROMPT_SETTING);
    const result = await analyzeMarket(row, { apiKey, promptTemplate });
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
    });
    res.status(200).json({ analysis, cached: false });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}
