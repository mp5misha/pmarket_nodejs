import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import Sidebar from "./components/Sidebar.jsx";
import MarketTable from "./components/MarketTable.jsx";
import MarketDetail from "./components/MarketDetail.jsx";

export default function App() {
  const [stats, setStats] = useState({ count: 0, lastUpdated: null });
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sortBy, setSortBy] = useState("volume");
  const [minVolume, setMinVolume] = useState(0);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState([]);

  const [selectedSlug, setSelectedSlug] = useState(null);
  const [selectedSlugs, setSelectedSlugs] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ running: false, total: 0, limit: 0 });
  const cancelRef = useRef(false);

  const refreshStats = async () => {
    try {
      setStats(await api.stats());
    } catch {
      /* non-fatal */
    }
  };

  const refreshTags = async () => {
    try {
      setTags(await api.tags());
    } catch {
      /* non-fatal */
    }
  };

  const refreshMarkets = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.markets({
        search,
        status,
        sortBy,
        minVolume: minVolume || undefined,
        minPrice: minPrice === "" ? undefined : minPrice,
        maxPrice: maxPrice === "" ? undefined : maxPrice,
        tag: tag || undefined,
      });
      setMarkets(rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    refreshStats();
    refreshTags();
    refreshMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-query whenever a filter changes
  useEffect(() => {
    refreshMarkets();
    setSelectedSlugs(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, sortBy, minVolume, minPrice, maxPrice, tag]);

  useEffect(() => () => {
    cancelRef.current = true;
  }, []);

  const toggleSelectMarket = (slug) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleSelectAllMarkets = () => {
    setSelectedSlugs((prev) => {
      const allSelected = markets.length > 0 && markets.every((m) => prev.has(m.slug));
      return allSelected ? new Set() : new Set(markets.map((m) => m.slug));
    });
  };

  // Fetches fresh price/volume/liquidity from Polymarket for just the
  // checked rows, instead of running a full catalog sync.
  const updateSelectedPrices = async () => {
    if (selectedSlugs.size === 0) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await api.refreshMarkets([...selectedSlugs]);
      setSelectedSlugs(new Set());
      await Promise.all([refreshMarkets(), refreshStats()]);
      if (result.failed?.length) {
        setRefreshError(
          `Couldn't update ${result.failed.length} market(s): ${result.failed
            .map((f) => f.slug)
            .join(", ")}`
        );
      }
    } catch (err) {
      setRefreshError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  // Runs the sync as a series of bounded steps (see api.syncStep) — small
  // enough per call to stay well within a serverless function's time limit,
  // looped here in the browser until the target is reached or the server
  // reports no more pages.
  const startSync = async ({ limit, closed, history, interval, delay }) => {
    cancelRef.current = false;
    setSyncStatus({ running: true, total: 0, limit, error: null });

    // Keep each request small when fetching price history (one extra HTTP
    // call per market), larger when not.
    const batchSize = history ? 20 : 100;
    let offset = 0;
    let total = 0;

    try {
      while (total < limit && !cancelRef.current) {
        const step = await api.syncStep({
          offset,
          batchSize: Math.min(batchSize, limit - total),
          closed,
          history,
          interval,
        });
        total += step.processed;
        offset = step.nextOffset;
        setSyncStatus({ running: true, total, limit, error: null });
        if (step.done) break;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
      setSyncStatus({ running: false, total, limit, error: null });
      refreshStats();
      refreshTags();
      refreshMarkets();
    } catch (err) {
      setSyncStatus({ running: false, total, limit, error: err.message });
    }
  };

  const selected = markets.find((m) => m.slug === selectedSlug) || null;

  return (
    <div className="app">
      <Sidebar
        stats={stats}
        syncStatus={syncStatus}
        onSync={startSync}
        onExport={() => window.open(api.exportUrl(), "_blank")}
      />
      <main className="main">
        <h2>Polymarket Markets</h2>

        <div className="filters">
          <input
            type="text"
            placeholder="Search question or slug"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="volume">Sort: Volume</option>
            <option value="liquidity">Sort: Liquidity</option>
            <option value="current_price">Sort: Price</option>
            <option value="resolution_date">Sort: Resolution date</option>
          </select>
          <input
            type="number"
            placeholder="Min volume $"
            value={minVolume || ""}
            onChange={(e) => setMinVolume(Number(e.target.value) || 0)}
          />
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All categories</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="number"
            placeholder="Min price"
            min={0}
            max={1}
            step={0.01}
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value === "" ? "" : Number(e.target.value))}
          />
          <input
            type="number"
            placeholder="Max price"
            min={0}
            max={1}
            step={0.01}
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>

        {error && <p className="sync-error">{error}</p>}
        {refreshError && <p className="sync-error">{refreshError}</p>}

        {!loading && markets.length === 0 ? (
          <div className="empty-state">
            No markets stored yet. Use <strong>Run sync</strong> in the sidebar to fetch from Polymarket.
          </div>
        ) : (
          <>
            <div className="toolbar">
              <p className="result-count">{markets.length} markets</p>
              <div className="bulk-actions">
                <span className="selected-count">{selectedSlugs.size} selected</span>
                <button
                  className="btn btn-small"
                  disabled={selectedSlugs.size === 0 || refreshing}
                  onClick={updateSelectedPrices}
                >
                  {refreshing ? "Updating…" : "Update selected prices"}
                </button>
              </div>
            </div>
            <MarketTable
              markets={markets}
              selectedSlug={selectedSlug}
              onSelect={setSelectedSlug}
              selectedSlugs={selectedSlugs}
              onToggleSelect={toggleSelectMarket}
              onToggleSelectAll={toggleSelectAllMarkets}
            />
          </>
        )}

        {selected && <MarketDetail market={selected} />}
      </main>
    </div>
  );
}
