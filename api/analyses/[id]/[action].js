import {
  getPool,
  ensureSchema,
  getAnalysis,
  getAnalysisThread,
  createAnalysis,
  updateAnalysisFairProb,
  getSetting,
} from "../../../lib/db.js";
import { askFollowUp, DEEPSEEK_MODEL, extractFairProbability } from "../../../lib/deepseek.js";
import { DEEPSEEK_KEY_SETTING } from "../../../lib/settings.js";

// A dynamic FOLDER segment (`[id]`) plus a dynamic filename (`[action].js`)
// — same shape as api/settings/[key].js/api/meta/[key].js, multiplexing
// more than one route onto a single Vercel function so the Hobby plan's
// 12-function budget has room. Was a static `follow-up.js` file (one
// route); `action` now also accepts `parse-fair-probability`, so both
// `POST /api/analyses/:id/follow-up` and
// `POST /api/analyses/:id/parse-fair-probability` land here.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const pool = getPool();
    await ensureSchema(pool);

    if (req.query.action === "parse-fair-probability") {
      return await handleParseFairProbability(req, res, pool);
    }
    if (req.query.action === "follow-up") {
      return await handleFollowUp(req, res, pool);
    }
    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}

// Phase 4 parity: a follow-up question layered on a prior analysis —
// DeepSeek gets the full reconstructed thread (every ancestor's prompt+
// reply) plus the new question, so it can build on that context. Always
// creates a new row (parent_analysis_id set), never served from cache.
async function handleFollowUp(req, res, pool) {
  const parent = await getAnalysis(pool, req.query.id);
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
    // Inherit the parent's kind ('market' or 'whales') — see
    // server/src/index.js's matching route for why.
    kind: parent.kind,
  });
  res.status(200).json({ analysis });
}

// Re-parses a market-kind analysis's already-stored result_text for the
// trailing "FAIR_PROBABILITY_YES: <decimal>" line and persists whatever it
// finds — see server/src/index.js's matching route for the full rationale.
// Doesn't call DeepSeek again; it's a pure re-read of text already on the
// row.
async function handleParseFairProbability(req, res, pool) {
  const analysis = await getAnalysis(pool, req.query.id);
  if (!analysis) return res.status(404).json({ error: "Analysis not found" });
  if (analysis.kind !== "market") {
    return res.status(400).json({ error: "Only a market analysis has a fair-probability line to parse." });
  }
  const fairProbYes = extractFairProbability(analysis.result_text);
  if (fairProbYes == null) {
    return res.status(422).json({ error: 'No "FAIR_PROBABILITY_YES: <decimal>" line found in this response.' });
  }
  const saved = await updateAnalysisFairProb(pool, analysis.id, fairProbYes);
  res.status(200).json({ analysis: saved });
}
