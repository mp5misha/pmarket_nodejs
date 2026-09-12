import { getPool, ensureSchema, getMarket } from "../../../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });
    res.status(200).json(row);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
