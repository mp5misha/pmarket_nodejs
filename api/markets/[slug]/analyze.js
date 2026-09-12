import { getPool, ensureSchema, getMarket } from "../../../lib/db.js";
import { analyzeMarket } from "../../../lib/deepseek.js";

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
    const analysis = await analyzeMarket(row.slug);
    res.status(200).json({ analysis });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}
