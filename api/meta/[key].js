import { getPool, ensureSchema, getStats, getTags, getAllForExport } from "../../lib/db.js";
import { fetchWhalePositions } from "../../lib/whales.js";

// A single dynamic FILE at one directory level (`api/meta/[key].js`) — the
// same proven shape as api/settings/[key].js, which already merges routes
// this way in production. Serves /api/meta/stats, /api/meta/tags, and
// /api/meta/export (previously api/stats.js, api/tags.js, api/export.js)
// so the Hobby plan's 12-function budget has room for
// api/markets/[slug]/analyses.js. See README's "Function count" section.
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
    if (req.query.key === "whales") {
      const { limit, timePeriod, orderBy } = req.query;
      const result = await fetchWhalePositions(pool, {
        limit: limit ? Number(limit) : 50,
        timePeriod: timePeriod || undefined,
        orderBy: orderBy || undefined,
      });
      return res.status(200).json(result);
    }
    if (req.query.key === "export") {
      const rows = await getAllForExport(pool);
      if (!rows.length) return res.status(404).send("No data to export yet");
      const cols = Object.keys(rows[0]);
      const escape = (v) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [cols.join(",")];
      for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=markets.csv");
      return res.status(200).send(lines.join("\n"));
    }
    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
