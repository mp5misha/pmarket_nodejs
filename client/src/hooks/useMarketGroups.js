import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

// Data-fetching for the reusable <MarketGrid> — kept separate from the
// component so different views (All Markets, and later Watchlist/My Trades)
// can supply different filter sets while sharing the same grid rendering.
// `filters` should be a stable-ish object (the caller controls its identity
// via its own state); we diff by JSON so callers don't need to memoize it.
export function useMarketGroups(filters, refreshIntervalSec = 0) {
  const [groups, setGroups] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  const filtersKey = JSON.stringify(filters);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.groupedMarkets(JSON.parse(filtersKey));
      setGroups(result.groups);
      setTotal(result.total);
      setLastFetchedAt(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    if (!refreshIntervalSec) return undefined;
    const id = setInterval(fetchGroups, refreshIntervalSec * 1000);
    return () => clearInterval(id);
  }, [refreshIntervalSec, fetchGroups]);

  return { groups, total, loading, error, lastFetchedAt, refetch: fetchGroups };
}
