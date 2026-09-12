import { getPool, ensureSchema, queryMarkets } from "../../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const { search, status, sortBy, minVolume, minPrice, maxPrice, tag, page, pageSize } = req.query;
    const result = await queryMarkets(pool, {
      search,
      status,
      sortBy,
      minVolume: minVolume ? Number(minVolume) : 0,
      minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
      maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
      tag: tag || undefined,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 50,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
