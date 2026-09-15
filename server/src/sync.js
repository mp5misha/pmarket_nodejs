import { getDb, upsertMarket, getMarket, getSyncCursor, setSyncCursor } from "./db.js";
import {
  fetchMarketsPage,
  fetchMarketBySlug,
  fetchPriceHistory,
  normalizeMarket,
  resolveStatusFilter,
  inResolutionRange,
  syncFilterSignature,
} from "./polymarket.js";

const REFRESH_CONCURRENCY = 4;

// Processes exactly one page (bounded by batchSize) per call. The client
// calls this repeatedly, advancing `offset` each time, until `done` comes
// back true — see client/src/hooks/useCatalogFetch.js. Same contract as the
// Vercel version (api/sync/step.js) so the client works against either.
// `minVolume`/`minLiquidity`/`keyword` are Market Discovery's fetch-time
// filters (Phase 2) — markets below/not matching are skipped before upsert,
// same pattern as the existing tag/resolution-date filters.
//
// A fresh run always starts at offset 0 (the client's initial value) — but
// Gamma's ranking for a given sort order is fairly stable run to run, so
// starting from 0 every time would mean re-fetching the same top-of-list
// markets indefinitely rather than ever reaching new ones. When offset is 0,
// substitute the persisted cursor for this exact filter combination instead
// (see syncFilterSignature/getSyncCursor) — the caller just keeps following
// whatever `nextOffset` this returns. Once Gamma runs out of markets for
// this filter (a short page), the cursor resets to 0 so the next run sweeps
// from the top again.
export async function runSyncStep({
  dbPath,
  userId,
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
}) {
  const db = getDb(dbPath);
  const signature = syncFilterSignature({ status, tag, resolutionFrom, resolutionTo, minVolume, minLiquidity, keyword });
  const offset = requestedOffset || getSyncCursor(db, userId, signature);
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

  const nextOffset = offset + page.length;
  const done = page.length < batchSize;
  // done=true means Gamma itself ran out of markets for this filter (not
  // just that the caller's own "max markets" cap was reached) — a real end
  // of the catalog, so start over from the top next time.
  setSyncCursor(db, userId, signature, done ? 0 : nextOffset);

  return { processed, added, updated, nextOffset, done };
}

// Loops runSyncStep to completion server-side (no browser involved) — used
// by the in-process scheduler for a saved search's optional scheduled
// reruns (Phase 2), as opposed to the client-driven step-by-step loop in
// client/src/hooks/useCatalogFetch.js.
export async function runFullSync({ dbPath, userId, limit = 2000, ...filters }) {
  let offset = 0;
  let processed = 0;
  let added = 0;
  let updated = 0;
  for (;;) {
    const step = await runSyncStep({ dbPath, userId, offset, batchSize: 100, ...filters });
    processed += step.processed;
    added += step.added;
    updated += step.updated;
    offset = step.nextOffset;
    if (step.done || processed >= limit) break;
  }
  return { processed, added, updated };
}

// Re-fetches current price/volume/liquidity for a specific list of slugs —
// used by the "update selected markets" bulk action in the table and the
// resolution-checkers (bulk and single-trade), as opposed to runSyncStep's
// full paginated catalog sync. Existing min/max price and CLOB token id are
// preserved (upsertMarket's COALESCE behavior). `retries` (see
// polymarket.js's getJson) defaults to the patient multi-retry behavior
// appropriate for an unattended sweep; the single-trade "Resolve" button
// passes `retries: 1` so a stuck/erroring Polymarket call fails fast
// instead of leaving a button spinning through several retries' backoff.
export async function refreshMarketPrices({ dbPath, slugs, retries } = {}) {
  const db = getDb(dbPath);
  const queue = [...new Set(slugs)].filter(Boolean);
  const updated = [];
  const failed = [];

  async function worker() {
    for (;;) {
      const slug = queue.shift();
      if (!slug) return;
      try {
        const raw = await fetchMarketBySlug(slug, { retries });
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
