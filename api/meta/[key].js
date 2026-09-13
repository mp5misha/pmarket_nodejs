import { getPool, ensureSchema, getStats, getTags } from "../../lib/db.js";

// A single dynamic FILE at one directory level (`api/meta/[key].js`) — the
// same proven shape as api/settings/[key].js, which already merges two
// routes this way in production. Serves /api/meta/stats and /api/meta/tags
// (previously api/stats.js and api/tags.js) so the Hobby plan's 12-function
// budget has room for api/analyses/[id]/follow-up.js. See README's
// "Function count" section.
export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    if (req.query.key === "stats") {
      const row = await getStats(pool);
      return res.status(200).json({ count: Number(row.count), lastUpdated: row.last_updated });
    }
    if (req.query.key === "tags") {
      return res.status(200).json(await getTags(pool));
    }
    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
