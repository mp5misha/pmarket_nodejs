import { getPool, ensureSchema, upsertMarket, deleteMarkets } from "../../lib/db.js";
import { fetchMarketBySlug, normalizeMarket } from "../../lib/polymarket.js";

const REFRESH_CONCURRENCY = 4;

// Bulk actions on a specific list of slugs, checked in the table: refresh
// (re-fetch current price/volume/liquidity from Polymarket, as opposed to
// sync/step.js's full paginated catalog sync) or delete (remove from the
// local catalog entirely, e.g. clearing out resolved markets). Same
// contract as the Express server's POST/DELETE /api/markets/bulk
// (server/src/index.js) — formerly two routes (refresh + a since-added
// delete); merged under one name once both existed, still one function
// either way since this file already had the Hobby-plan function-count
// budget it needed.
async function handleRefresh(req, res, pool, slugs) {
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
}

async function handleDelete(req, res, pool) {
  // ?slugs=a,b,c rather than a DELETE body — a query param sidesteps any
  // uncertainty about whether a JSON body on a DELETE request gets parsed
  // the same way it does on POST (see README's "Function count" section on
  // preferring the most reliable option over an untested one here).
  const slugs = String(req.query.slugs || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (slugs.length === 0) return res.status(400).json({ error: "slugs must be a non-empty list" });
  const deleted = await deleteMarkets(pool, [...new Set(slugs)]);
  res.status(200).json({ deleted });
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    if (req.method === "DELETE") return await handleDelete(req, res, pool);
    if (req.method === "POST") {
      const { slugs } = req.body || {};
      if (!Array.isArray(slugs) || slugs.length === 0) {
        return res.status(400).json({ error: "slugs must be a non-empty array" });
      }
      return await handleRefresh(req, res, pool, slugs);
    }

    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
