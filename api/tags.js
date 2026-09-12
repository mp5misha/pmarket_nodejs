import { getPool, ensureSchema, getTags } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    res.status(200).json(await getTags(pool));
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
