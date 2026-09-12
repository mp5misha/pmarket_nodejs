import { getPool, ensureSchema, getMarket, getSetting } from "../../../lib/db.js";
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
    const resultText = await analyzeMarket(row, { apiKey, promptTemplate });
    // The client renders `analysis` as a stored analysis record (id,
    // created_at, model_name, result_text, ...) — that's what the
    // Express/SQLite backend's history feature (Phase 3) persists and
    // returns. This deploy target has no analyses table (frozen pre-Phase-2
    // schema), so there's nothing to persist across requests, but the shape
    // still has to match or the client's `new Date(a.created_at)` etc. blow
    // up with "Invalid Date". Synthesize a one-off record instead of a bare
    // string.
    const analysis = {
      id: `${row.slug}-${Date.now()}`,
      parent_analysis_id: null,
      prompt_text: null,
      result_text: resultText,
      model_name: DEEPSEEK_MODEL,
      tokens_used: null,
      cost_estimate: null,
      created_at: new Date().toISOString(),
    };
    res.status(200).json({ analysis, cached: false });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}
