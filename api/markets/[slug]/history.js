import { getPool, ensureSchema, getMarket } from "../../../lib/db.js";
import { fetchPriceHistory } from "../../../lib/polymarket.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });
    if (!row.yes_token_id) {
      return res
        .status(400)
        .json({ error: "No CLOB token id stored for this market yet — sync with history enabled." });
    }
    const history = await fetchPriceHistory(row.yes_token_id, req.query.interval || "max");
    res.status(200).json(history);
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
}
