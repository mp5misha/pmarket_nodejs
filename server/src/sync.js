import { getDb, upsertMarket } from "./db.js";
import {
  fetchMarketsPage,
  fetchMarketBySlug,
  fetchPriceHistory,
  normalizeMarket,
  resolveStatusFilter,
  inResolutionRange,
} from "./polymarket.js";

const REFRESH_CONCURRENCY = 4;

// Processes exactly one page (bounded by batchSize) per call. The client
// calls this repeatedly, advancing `offset` each time, until `done` comes
// back true — see client/src/App.jsx's startSync(). Same contract as the
// Vercel version (api/sync/step.js) so the client works against either.
export async function runSyncStep({
  dbPath,
  offset = 0,
  batchSize = 50,
  status = "active",
  history = false,
  interval = "max",
  tag = "",
  resolutionFrom = "",
  resolutionTo = "",
}) {
  const db = getDb(dbPath);
  const { active, closed } = resolveStatusFilter(status);
  const page = await fetchMarketsPage(offset, { limit: batchSize, active, closed });

  let processed = 0;
  for (const raw of page) {
    const m = normalizeMarket(raw);
    if (!m.slug) continue;
    if (tag && !m.tags.includes(tag)) continue;
    if (!inResolutionRange(m.resolutionDate, resolutionFrom, resolutionTo)) continue;

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

// Re-fetches current price/volume/liquidity for a specific list of slugs —
// used by the "update selected markets" bulk action in the table, as
// opposed to runSyncStep's full paginated catalog sync. Existing min/max
// price and CLOB token id are preserved (upsertMarket's COALESCE behavior).
export async function refreshMarketPrices({ dbPath, slugs }) {
  const db = getDb(dbPath);
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
        upsertMarket(db, normalizeMarket(raw));
        updated.push(slug);
      } catch (err) {
        failed.push({ slug, error: String(err.message ?? err) });
      }
    }
  }

  const workerCount = Math.min(REFRESH_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { updated, failed };
}
