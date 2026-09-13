import { getPool, ensureSchema, upsertMarket, getMarket, getSyncCursor, setSyncCursor } from "../../lib/db.js";
import {
  fetchMarketsPage,
  fetchPriceHistory,
  normalizeMarket,
  resolveStatusFilter,
  inResolutionRange,
  syncFilterSignature,
} from "../../lib/polymarket.js";

// Processes exactly one page (bounded by batchSize) per invocation, so this
// stays well within Vercel's function time limit even on the Hobby plan.
// The client calls this repeatedly, advancing `offset` each time, until
// `done` comes back true — see client/src/App.jsx's startSync().
//
// A fresh run always starts at offset 0 (the client's initial value) — but
// Gamma's ranking for a given sort order is fairly stable run to run, so
// starting from 0 every time would mean re-fetching the same top-of-list
// markets indefinitely rather than ever reaching new ones. When offset is 0,
// substitute the persisted cursor for this exact filter combination instead
// (see syncFilterSignature/getSyncCursor) — the client just keeps following
// whatever `nextOffset` this returns, so no client change is needed. Once
// Gamma runs out of markets for this filter (a short page), the cursor
// resets to 0 so the next run sweeps from the top again.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const pool = getPool();
    await ensureSchema(pool);

    const {
      offset: requestedOffset = 0,
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

    const signature = syncFilterSignature({ status, tag, resolutionFrom, resolutionTo, minVolume, minLiquidity, keyword });
    const offset = requestedOffset || (await getSyncCursor(pool, signature));

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

    const nextOffset = offset + page.length;
    const done = page.length < batchSize;
    // done=true means Gamma itself ran out of markets for this filter (not
    // just that the client's own "max markets" cap was reached) — a real
    // end of the catalog, so start over from the top next time.
    await setSyncCursor(pool, signature, done ? 0 : nextOffset);

    res.status(200).json({
      processed,
      added,
      updated,
      nextOffset,
      done,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
