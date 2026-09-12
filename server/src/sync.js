import { getDb, upsertMarket, getMarket } from "./db.js";
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
// back true — see client/src/hooks/useCatalogFetch.js. Same contract as the
// Vercel version (api/sync/step.js) so the client works against either.
// `minVolume`/`minLiquidity`/`keyword` are Market Discovery's fetch-time
// filters (Phase 2) — markets below/not matching are skipped before upsert,
// same pattern as the existing tag/resolution-date filters.
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
  minVolume = 0,
  minLiquidity = 0,
  keyword = "",
}) {
  const db = getDb(dbPath);
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

    const isNew = !getMarket(db, m.slug);
    upsertMarket(db, m, { minPrice, maxPrice });
    processed += 1;
    if (isNew) added += 1;
    else updated += 1;
  }

  return {
    processed,
    added,
    updated,
    nextOffset: offset + page.length,
    done: page.length < batchSize,
  };
}

// Loops runSyncStep to completion server-side (no browser involved) — used
// by the in-process scheduler for a saved search's optional scheduled
// reruns (Phase 2), as opposed to the client-driven step-by-step loop in
// client/src/hooks/useCatalogFetch.js.
export async function runFullSync({ dbPath, limit = 2000, ...filters }) {
  let offset = 0;
  let processed = 0;
  let added = 0;
  let updated = 0;
  for (;;) {
    const step = await runSyncStep({ dbPath, offset, batchSize: 100, ...filters });
    processed += step.processed;
    added += step.added;
    updated += step.updated;
    offset = step.nextOffset;
    if (step.done || processed >= limit) break;
  }
  return { processed, added, updated };
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
