import { getPool, ensureSchema, upsertMarket } from "../../lib/db.js";
import { fetchMarketBySlug, normalizeMarket } from "../../lib/polymarket.js";

const REFRESH_CONCURRENCY = 4;

// Re-fetches current price/volume/liquidity for a specific list of slugs —
// used by the "update selected markets" bulk action in the table, as
// opposed to sync/step.js's full paginated catalog sync. Same contract as
// the Express server's POST /api/markets/refresh (server/src/sync.js).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { slugs } = req.body || {};
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: "slugs must be a non-empty array" });
  }
  try {
    const pool = getPool();
    await ensureSchema(pool);

    const queue = [...new Set(slugs)].filter(Boolean);
    const updated = [];
    const failed = [];

    async function worker() {
      for (;;) {
        const slug = queue.shift();
        if (!slug) return;
        try {
          const raw = await fetchMarketBySlug(slug);
          if (!raw) {
            failed.push({ slug, error: "Not found on Polymarket" });
            continue;
          }
          await upsertMarket(pool, normalizeMarket(raw));
          updated.push(slug);
        } catch (err) {
          failed.push({ slug, error: String(err.message ?? err) });
        }
      }
    }

    const workerCount = Math.min(REFRESH_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    res.status(200).json({ updated, failed });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
