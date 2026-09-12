import { getDb, upsertMarket } from "./db.js";
import { fetchMarketsPage, fetchPriceHistory, normalizeMarket } from "./polymarket.js";

// Processes exactly one page (bounded by batchSize) per call. The client
// calls this repeatedly, advancing `offset` each time, until `done` comes
// back true — see client/src/App.jsx's startSync(). Same contract as the
// Vercel version (api/sync/step.js) so the client works against either.
export async function runSyncStep({
  dbPath,
  offset = 0,
  batchSize = 50,
  closed = false,
  history = false,
  interval = "max",
}) {
  const db = getDb(dbPath);
  const page = await fetchMarketsPage(offset, { limit: batchSize, active: !closed, closed });

  let processed = 0;
  for (const raw of page) {
    const m = normalizeMarket(raw);
    if (!m.slug) continue;

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

    upsertMarket(db, m, { minPrice, maxPrice });
    processed += 1;
  }

  return {
    processed,
    nextOffset: offset + page.length,
    done: page.length < batchSize,
  };
}
