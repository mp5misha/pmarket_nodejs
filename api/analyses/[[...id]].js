import { getPool, ensureSchema, getAnalysis, getAnalysisThread, createAnalysis, getSetting } from "../../lib/db.js";
import { askFollowUp, DEEPSEEK_MODEL } from "../../lib/deepseek.js";
import { DEEPSEEK_KEY_SETTING } from "../../lib/settings.js";

// A catch-all covering /api/analyses/:id (GET) and /api/analyses/:id/
// follow-up (POST) in one function — see api/markets/[slug]/[[...action]].js
// for why this repo consolidates routes this way (Vercel Hobby's
// 12-serverless-function cap).

async function handleGet(req, res, pool, id) {
  const row = await getAnalysis(pool, id);
  if (!row) return res.status(404).json({ error: "Analysis not found" });
  res.status(200).json(row);
}

// Phase 4 parity: a follow-up question layered on a prior analysis —
// DeepSeek gets the full reconstructed thread (every ancestor's prompt+
// reply) plus the new question, so it can build on that context. Always
// creates a new row (parent_analysis_id set), never served from cache.
async function handleFollowUp(req, res, pool, id) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const parent = await getAnalysis(pool, id);
  if (!parent) return res.status(404).json({ error: "Analysis not found" });
  const { text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const apiKey = await getSetting(pool, DEEPSEEK_KEY_SETTING);
  const thread = await getAnalysisThread(pool, parent.id);
  const threadMessages = thread.flatMap((a) => [
    { role: "user", content: a.prompt_text },
    { role: "assistant", content: a.result_text },
  ]);
  const followUpText = text.trim();
  const result = await askFollowUp(threadMessages, followUpText, { apiKey });
  const analysis = await createAnalysis(pool, {
    marketSlug: parent.market_slug,
    parentAnalysisId: parent.id,
    promptText: followUpText,
    resultText: result.content,
    modelName: DEEPSEEK_MODEL,
    tokensUsed: result.tokensUsed,
  });
  res.status(200).json({ analysis });
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    const [id, sub] = req.query.id || [];
    if (!id) return res.status(404).json({ error: "Not found" });
    if (!sub) return await handleGet(req, res, pool, id);
    if (sub === "follow-up") return await handleFollowUp(req, res, pool, id);

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}
