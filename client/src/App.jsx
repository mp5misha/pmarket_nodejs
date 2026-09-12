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

  const [selectedSlug, setSelectedSlug] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ running: false, total: 0, limit: 0 });
  const cancelRef = useRef(false);

  const refreshStats = async () => {
    try {
      setStats(await api.stats());
    } catch {
      /* non-fatal */
    }
  };

  const refreshMarkets = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.markets({ search, status, sortBy, minVolume: minVolume || undefined });
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
    refreshMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-query whenever a filter changes
  useEffect(() => {
    refreshMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, sortBy, minVolume]);

  useEffect(() => () => {
    cancelRef.current = true;
  }, []);

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
        </div>

        {error && <p className="sync-error">{error}</p>}

        {!loading && markets.length === 0 ? (
          <div className="empty-state">
            No markets stored yet. Use <strong>Run sync</strong> in the sidebar to fetch from Polymarket.
          </div>
        ) : (
          <>
            <p className="result-count">{markets.length} markets</p>
            <MarketTable markets={markets} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
          </>
        )}

        {selected && <MarketDetail market={selected} />}
      </main>
    </div>
  );
}
