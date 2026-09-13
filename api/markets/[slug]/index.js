import { getPool, ensureSchema, getMarket } from "../../../lib/db.js";
import { getWhalePositionsForSlug } from "../../../lib/whales.js";

// Plain `/api/markets/:slug` — a single dynamic FOLDER segment (`[slug]`)
// with static filenames inside (this file, history.js, related.js,
// analyze.js, analyses.js) is the routing shape Vercel documents and
// reliably supports outside Next.js too. An earlier version of this deploy
// tried consolidating these into one `[[...action]].js` optional-catch-all
// file to save on the Hobby plan's function-count budget — that syntax is
// unreliable in a plain (non-Next.js) Vercel deployment and broke market
// details in production. Don't reintroduce catch-all/nested-dynamic routing
// here; see README's "Function count" section for how this repo stays
// within budget instead.
export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const row = await getMarket(pool, req.query.slug);
    if (!row) return res.status(404).json({ error: "Market not found" });
    row.whalePositions = await getWhalePositionsForSlug(req.query.slug);
    res.status(200).json(row);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
