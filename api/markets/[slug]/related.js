import { getPool, ensureSchema, getMarket, getMarketsByEvent } from "../../../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });
    if (!row.event_id) return res.status(200).json([]);
    res.status(200).json(await getMarketsByEvent(pool, row.event_id, row.slug));
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
