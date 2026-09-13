import { getPool, ensureSchema, queryMarketsGrouped } from "../../lib/db.js";
import { getWhaleSlugSet } from "../../lib/whales.js";

// Must exist as a static sibling file to api/markets/[slug]/ — Vercel's
// file-based routing otherwise falls through "/api/markets/grouped" to the
// dynamic [slug] route (treating "grouped" as a slug), 404ing with "Market
// not found". Same reasoning as api/markets/refresh.js.
export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const { search, status, sortBy, minVolume, minPrice, maxPrice, tag, myTrades, onlyWhaleMarkets, page, pageSize } =
      req.query;
    // See server/src/index.js's matching route for why this is fetched
    // unconditionally (powers the grid's purple highlight on every load,
    // not just when the "Whales trades" filter checkbox is on).
    const whaleSlugs = await getWhaleSlugSet(pool);
    const result = await queryMarketsGrouped(pool, {
      search,
      status,
      sortBy,
      minVolume: minVolume ? Number(minVolume) : 0,
      minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
      maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
      tag: tag || undefined,
      hasTrade: myTrades === "true" || myTrades === "1",
      whaleSlugs,
      onlyWhaleMarkets: onlyWhaleMarkets === "true" || onlyWhaleMarkets === "1",
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 25,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
