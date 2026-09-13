import {
  getPool,
  ensureSchema,
  getMarket,
  getMarketsByEvent,
  getSetting,
  createAnalysis,
  listAnalysesForMarket,
} from "../../../lib/db.js";
import { fetchPriceHistory } from "../../../lib/polymarket.js";
import { analyzeMarket, DEEPSEEK_MODEL } from "../../../lib/deepseek.js";
import { DEEPSEEK_KEY_SETTING, DEEPSEEK_PROMPT_SETTING } from "../../../lib/settings.js";

// A single dynamic-route function serving every /api/markets/:slug/* leaf
// (previously four separate files: index, history, related, analyze) — the
// Hobby plan caps a deployment at 12 serverless functions, and this repo
// needs the budget for saved-searches/trades/analyses below.

async function handleIndex(req, res, pool, row) {
  res.status(200).json(row);
}

async function handleHistory(req, res, pool, row) {
  if (!row.yes_token_id) {
    return res
      .status(400)
      .json({ error: "No CLOB token id stored for this market yet — sync with history enabled." });
  }
  const history = await fetchPriceHistory(row.yes_token_id, req.query.interval || "max");
  res.status(200).json(history);
}

async function handleRelated(req, res, pool, row) {
  if (!row.event_id) return res.status(200).json([]);
  res.status(200).json(await getMarketsByEvent(pool, row.event_id, row.slug));
}

async function handleAnalyze(req, res, pool, row) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = await getSetting(pool, DEEPSEEK_KEY_SETTING);
  const promptTemplate = await getSetting(pool, DEEPSEEK_PROMPT_SETTING);
  const result = await analyzeMarket(row, { apiKey, promptTemplate });
  const analysis = await createAnalysis(pool, {
    marketSlug: row.slug,
    promptText: result.promptText,
    resultText: result.content,
    modelName: DEEPSEEK_MODEL,
    tokensUsed: result.tokensUsed,
  });
  res.status(200).json({ analysis, cached: false });
}

async function handleAnalysesList(req, res, pool, row) {
  res.status(200).json(await listAnalysesForMarket(pool, row.slug));
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });

    const action = req.query.action?.[0];
    if (!action) return await handleIndex(req, res, pool, row);
    if (action === "history") return await handleHistory(req, res, pool, row);
    if (action === "related") return await handleRelated(req, res, pool, row);
    if (action === "analyze") return await handleAnalyze(req, res, pool, row);
    if (action === "analyses") return await handleAnalysesList(req, res, pool, row);

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    const status = req.query.action?.[0] === "analyze" || req.query.action?.[0] === "history" ? 502 : 500;
    res.status(status).json({ error: String(err.message ?? err) });
  }
}
