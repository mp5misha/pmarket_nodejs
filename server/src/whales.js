import { fetchLeaderboard, fetchUserPositions } from "./polymarket.js";

// How many of each whale's biggest positions to pull in — top-50 traders ×
// this is the worst-case row count the tab has to render.
const POSITIONS_PER_WHALE = 5;
// Fetching 50 wallets' positions one at a time would be slow; this mirrors
// the worker-queue pattern in sync.js's refreshMarketPrices.
const CONCURRENCY = 6;
// This fans out to ~50 external requests, so cache the aggregated result
// briefly rather than re-running the whole thing on every tab open/refresh.
const CACHE_TTL_MS = 2 * 60 * 1000;

let cache = null; // { key, at, data }

/** Top-50 leaderboard traders' current positions, biggest first — each row
 * tagged with which trader holds it. Per-wallet failures (a dead wallet, a
 * rate limit) are skipped rather than failing the whole request; the result
 * reports how many were skipped so the UI can say so. */
export async function fetchWhalePositions({ limit = 50, timePeriod = "DAY", orderBy = "VOL" } = {}) {
  const key = JSON.stringify({ limit, timePeriod, orderBy });
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const traders = await fetchLeaderboard({ limit, timePeriod, orderBy });
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

  positions.sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
  const result = { positions, traderCount: traders.length, failedWalletCount, fetchedAt: new Date().toISOString() };
  cache = { key, at: Date.now(), data: result };
  return result;
}
