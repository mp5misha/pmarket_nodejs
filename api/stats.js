import { getPool, ensureSchema, getStats } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getStats(pool);
    res.status(200).json({ count: Number(row.count), lastUpdated: row.last_updated });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
