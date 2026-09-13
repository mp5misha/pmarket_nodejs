import { fetchLeaderboard, fetchUserPositions } from "./polymarket.js";
import {
  replaceWhalePositions,
  getStoredWhalePositions,
  replaceWhaleTopTraders,
  getStoredWhaleTopTraders,
} from "./db.js";

// How many of the fetched leaderboard's traders to surface as "most
// profitable" (by realized P&L, Polymarket's own `pnl` stat for the
// selected time window) — independent of whether they currently hold a
// position that made it into the positions list below.
const TOP_TRADERS_COUNT = 10;

/** Ranks a fetched leaderboard by realized P&L (descending) and takes the
 * top `TOP_TRADERS_COUNT` — mirrors server/src/whales.js's version. */
function computeTopTraders(traders) {
  return [...traders]
    .filter((t) => t.pnl != null)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, TOP_TRADERS_COUNT)
    .map((t, i) => ({ rank: i + 1, wallet: t.wallet, name: t.name, pnl: t.pnl, volume: t.volume }));
}

// How many of each whale's biggest positions to pull in — top-50 traders ×
// this is the worst-case row count the tab has to render.
const POSITIONS_PER_WHALE = 5;
// Fetching 50 wallets' positions one at a time would be slow; mirrors the
// worker-queue pattern server/src/sync.js uses for refreshMarketPrices.
const CONCURRENCY = 6;
// This fans out to ~50 external requests, so cache the aggregated result
// briefly rather than re-running the whole thing on every tab open/refresh.
// Separate, shorter-lived thing from the DB snapshot below: this cache just
// avoids redundant external calls within a warm serverless instance; the DB
// row is the durable "last known good" copy, which also survives a cold
// start (unlike this in-memory cache).
const CACHE_TTL_MS = 2 * 60 * 1000;
// A stale (DB-fallback) result is cached for much less time than a healthy
// one — long enough that rapid page loads during an outage don't each pay
// the leaderboard call's full retry-with-backoff penalty, short enough to
// notice and recover quickly once Polymarket is back.
const STALE_CACHE_TTL_MS = 20 * 1000;

let cache = null; // { key, at, ttlMs, data }

/** Top-50 leaderboard traders' current positions, biggest first — each row
 * tagged with which trader holds it. Per-wallet failures (a dead wallet, a
 * rate limit) are skipped rather than failing the whole request; the result
 * reports how many were skipped so the UI can say so.
 *
 * Every actual rescan (i.e. not served from the in-memory cache above) is
 * persisted to the whale_positions table via replaceWhalePositions, so the
 * last successful scan survives a cold start. If the rescan itself fails
 * outright, this falls back to that stored snapshot — marked `stale: true`
 * — instead of throwing, so a transient Polymarket outage doesn't blank out
 * the tab (or the grid highlight/detail section built on top of it) when a
 * perfectly good last-known snapshot already exists. */
export async function fetchWhalePositions(pool, { limit = 50, timePeriod = "DAY", orderBy = "VOL" } = {}) {
  const key = JSON.stringify({ limit, timePeriod, orderBy });
  if (cache && cache.key === key && Date.now() - cache.at < cache.ttlMs) {
    return cache.data;
  }

  let traders;
  try {
    traders = await fetchLeaderboard({ limit, timePeriod, orderBy });
  } catch (err) {
    const stored = await getStoredWhalePositions(pool);
    if (stored) {
      const storedTop = await getStoredWhaleTopTraders(pool);
      const fallback = { ...stored, topTraders: storedTop?.topTraders ?? [], stale: true };
      cache = { key, at: Date.now(), ttlMs: STALE_CACHE_TTL_MS, data: fallback };
      return fallback;
    }
    throw err;
  }

  const queue = [...traders];
  const positions = [];
  let failedWalletCount = 0;

  async function worker() {
    for (;;) {
      const trader = queue.shift();
      if (!trader) return;
      try {
        const rows = await fetchUserPositions(trader.wallet, { limit: POSITIONS_PER_WHALE });
        for (const row of rows) {
          positions.push({
            ...row,
            traderWallet: trader.wallet,
            traderName: trader.name,
            traderPnl: trader.pnl,
            traderVolume: trader.volume,
          });
        }
      } catch {
        failedWalletCount += 1;
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Every single wallet's position fetch failing (e.g. the positions
  // endpoint itself is down, even though the leaderboard call above
  // succeeded) isn't a partial result worth keeping — don't let it
  // overwrite a previously-good stored snapshot with an empty one.
  if (traders.length > 0 && failedWalletCount === traders.length) {
    const stored = await getStoredWhalePositions(pool);
    if (stored) {
      const storedTop = await getStoredWhaleTopTraders(pool);
      const fallback = { ...stored, topTraders: storedTop?.topTraders ?? [], stale: true };
      cache = { key, at: Date.now(), ttlMs: STALE_CACHE_TTL_MS, data: fallback };
      return fallback;
    }
  }

  positions.sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
  const fetchedAt = new Date().toISOString();
  const topTraders = computeTopTraders(traders);
  const result = { positions, topTraders, traderCount: traders.length, failedWalletCount, fetchedAt };
  await replaceWhalePositions(pool, result);
  await replaceWhaleTopTraders(pool, { topTraders, fetchedAt });
  cache = { key, at: Date.now(), ttlMs: CACHE_TTL_MS, data: result };
  return result;
}

/** Deduped list of market slugs any top-50 trader currently holds a
 * position in — powers the markets grid's purple "whale-relevant" highlight
 * and its "Whales trades" filter (see queryMarketsGrouped's whaleSlugs/
 * onlyWhaleMarkets params). Degrades to an empty list on any failure (a
 * whale-data hiccup should never break the markets grid itself), and reuses
 * fetchWhalePositions' own 2-minute cache, so this is cheap on the common
 * path — the grid doesn't add its own separate external fetch. */
export async function getWhaleSlugSet(pool, opts) {
  try {
    const { positions } = await fetchWhalePositions(pool, opts);
    return [...new Set(positions.map((p) => p.slug).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Whale positions held specifically in one market — powers the market
 * detail panel's "Whale positions in this market" section. Same graceful
 * degrade-to-empty on failure as getWhaleSlugSet. */
export async function getWhalePositionsForSlug(pool, slug, opts) {
  try {
    const { positions } = await fetchWhalePositions(pool, opts);
    return positions.filter((p) => p.slug === slug);
  } catch {
    return [];
  }
}
