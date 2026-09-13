import { getPool, ensureSchema, upsertMarket, getMarket } from "../../lib/db.js";
import {
  fetchMarketsPage,
  fetchPriceHistory,
  normalizeMarket,
  resolveStatusFilter,
  inResolutionRange,
} from "../../lib/polymarket.js";

// Processes exactly one page (bounded by batchSize) per invocation, so this
// stays well within Vercel's function time limit even on the Hobby plan.
// The client calls this repeatedly, advancing `offset` each time, until
// `done` comes back true — see client/src/App.jsx's startSync().
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const pool = getPool();
    await ensureSchema(pool);

    const {
      offset = 0,
      batchSize = 50,
      status = "active",
      history = false,
      interval = "max",
      tag = "",
      resolutionFrom = "",
      resolutionTo = "",
      minVolume = 0,
      minLiquidity = 0,
      keyword = "",
    } = req.body || {};

    const { active, closed } = resolveStatusFilter(status);
    const page = await fetchMarketsPage(offset, { limit: batchSize, active, closed });

    let processed = 0;
    let added = 0;
    let updated = 0;
    for (const raw of page) {
      const m = normalizeMarket(raw);
      if (!m.slug) continue;
      if (tag && !m.tags.includes(tag)) continue;
      if (!inResolutionRange(m.resolutionDate, resolutionFrom, resolutionTo)) continue;
      if (minVolume && (m.volume ?? 0) < minVolume) continue;
      if (minLiquidity && (m.liquidity ?? 0) < minLiquidity) continue;
      if (keyword && !(m.question ?? "").toLowerCase().includes(keyword.toLowerCase())) continue;

      let minPrice = null;
      let maxPrice = null;
      if (history && m.yesTokenId) {
        try {
          const hist = await fetchPriceHistory(m.yesTokenId, interval);
          const prices = hist.map((p) => p.p).filter((p) => typeof p === "number");
          if (prices.length) {
            minPrice = Math.min(...prices);
            maxPrice = Math.max(...prices);
          }
        } catch {
          // keep going even if one market's history call fails
        }
      }

      const isNew = !(await getMarket(pool, m.slug));
      await upsertMarket(pool, m, { minPrice, maxPrice });
      processed += 1;
      if (isNew) added += 1;
      else updated += 1;
    }

    res.status(200).json({
      processed,
      added,
      updated,
      nextOffset: offset + page.length,
      done: page.length < batchSize,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
