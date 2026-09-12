import { getPool, ensureSchema, queryMarkets } from "../../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const { search, status, sortBy, minVolume } = req.query;
    const rows = await queryMarkets(pool, {
      search,
      status,
      sortBy,
      minVolume: minVolume ? Number(minVolume) : 0,
    });
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
