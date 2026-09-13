import { getPool, ensureSchema, getMarket, listAnalysesForMarket } from "../../../lib/db.js";

// Full history of past analyses for one market (newest first) — without
// this, switching to another market and back loses every analysis you ran
// (they're persisted in Postgres either way, via analyze.js/follow-up.js,
// but the detail panel has no way to fetch them back without this route).
export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });
    const kind = req.query.kind === "whales" ? "whales" : "market";
    res.status(200).json(await listAnalysesForMarket(pool, row.slug, kind));
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
