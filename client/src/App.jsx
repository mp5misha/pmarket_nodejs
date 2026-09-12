import { useEffect, useState } from "react";
import { api } from "./api.js";
import Sidebar from "./components/Sidebar.jsx";
import MarketGrid from "./components/MarketGrid.jsx";
import MarketDetail from "./components/MarketDetail.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import MarketDiscovery from "./components/MarketDiscovery.jsx";
import MyTrades from "./components/MyTrades.jsx";
import { useMarketGroups } from "./hooks/useMarketGroups.js";
import { useCatalogFetch } from "./hooks/useCatalogFetch.js";

export default function App() {
  const [stats, setStats] = useState({ count: 0, lastUpdated: null });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sortBy, setSortBy] = useState("volume");
  const [minVolume, setMinVolume] = useState(0);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState([]);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(30);

  const {
    groups,
    total: totalMarkets,
    loading,
    error,
    lastFetchedAt,
    refetch: refetchGrid,
  } = useMarketGroups(
    {
      search,
      status,
      sortBy,
      minVolume: minVolume || undefined,
      minPrice: minPrice === "" ? undefined : minPrice,
      maxPrice: maxPrice === "" ? undefined : maxPrice,
      tag: tag || undefined,
      page,
      pageSize,
    },
    refreshIntervalSec
  );

  const [selectedSlug, setSelectedSlug] = useState(null);
  const [selectedMarket, setSelectedMarket] = useState(null);
  const [selectedSlugs, setSelectedSlugs] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deepseekStatus, setDeepseekStatus] = useState(null);
  const [view, setView] = useState("markets");
  const { syncStatus, run: runCatalogFetch } = useCatalogFetch();
  const [highlightThresholdPct, setHighlightThresholdPct] = useState(null);

  const refreshStats = async () => {
    try {
      setStats(await api.stats());
    } catch {
      /* non-fatal */
    }
  };

  const refreshDeepseekStatus = async () => {
    try {
      setDeepseekStatus(await api.getDeepSeekKeyStatus());
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

  // Initial load
  useEffect(() => {
    refreshStats();
    refreshTags();
    refreshDeepseekStatus();
    api
      .getHighlightThreshold()
      .then((r) => setHighlightThresholdPct(r.thresholdPct))
      .catch(() => setHighlightThresholdPct(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateHighlightThreshold = async (pct) => {
    setHighlightThresholdPct(pct);
    try {
      await api.setHighlightThreshold(pct);
    } catch {
      /* non-fatal — the grid still highlights using the locally-set value */
    }
  };

  // Any filter (or page size) change jumps back to page 1 — useMarketGroups
  // re-fetches on its own whenever any of these (or page) change.
  useEffect(() => {
    setPage(1);
    setSelectedSlugs(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, sortBy, minVolume, minPrice, maxPrice, tag, pageSize]);

  // The selected market is fetched independently of the current page's rows
  // — pagination or a filter change shouldn't lose the detail panel, and a
  // related-market click can jump to a market that isn't on this page at all.
  useEffect(() => {
    if (!selectedSlug) {
      setSelectedMarket(null);
      return;
    }
    let cancelled = false;
    api
      .market(selectedSlug)
      .then((m) => {
        if (!cancelled) setSelectedMarket(m);
      })
      .catch(() => {
        if (!cancelled) setSelectedMarket(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug]);

  const toggleSelectMarket = (slug) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleSelectAllMarkets = () => {
    const allMarkets = groups.flatMap((g) => g.markets);
    setSelectedSlugs((prev) => {
      const allSelected = allMarkets.length > 0 && allMarkets.every((m) => prev.has(m.slug));
      return allSelected ? new Set() : new Set(allMarkets.map((m) => m.slug));
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
      await Promise.all([refetchGrid(), refreshStats()]);
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

  // Thin wrapper around useCatalogFetch's run() for the sidebar's "Run
  // sync" button — same audited-fetch-run path the Market Discovery screen
  // uses (Phase 2), just without a saved search behind it.
  const startSync = async (params) => {
    try {
      await runCatalogFetch(params);
    } catch {
      // syncStatus.error already reflects the failure — nothing else to do.
    } finally {
      refreshStats();
      refreshTags();
      refetchGrid();
    }
  };

  return (
    <div className="app">
      <Sidebar
        stats={stats}
        syncStatus={syncStatus}
        tags={tags}
        deepseekStatus={deepseekStatus}
        onSync={startSync}
        onExport={() => window.open(api.exportUrl(), "_blank")}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        <div className="view-switcher">
          <button
            className={`view-tab ${view === "markets" ? "active" : ""}`}
            onClick={() => setView("markets")}
          >
            All Markets
          </button>
          <button
            className={`view-tab ${view === "discovery" ? "active" : ""}`}
            onClick={() => setView("discovery")}
          >
            Market Discovery
          </button>
          <button
            className={`view-tab ${view === "trades" ? "active" : ""}`}
            onClick={() => setView("trades")}
          >
            My Trades
          </button>
        </div>

        {view === "discovery" ? (
          <MarketDiscovery tags={tags} />
        ) : view === "trades" ? (
          <MyTrades />
        ) : (
          <>
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
              {highlightThresholdPct != null && (
                <label className="highlight-threshold-field" title="Highlight markets at or above this implied Yes probability">
                  Highlight ≥
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={highlightThresholdPct}
                    onChange={(e) => updateHighlightThreshold(Number(e.target.value))}
                  />
                  %
                </label>
              )}
            </div>

            {refreshError && <p className="sync-error">{refreshError}</p>}

            {!loading && totalMarkets === 0 && groups.length === 0 && !search && !status && !tag ? (
              <div className="empty-state">
                No markets stored yet. Use <strong>Run sync</strong> in the sidebar to fetch from Polymarket.
              </div>
            ) : (
              <>
                <div className="toolbar">
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
                <MarketGrid
                  groups={groups}
                  total={totalMarkets}
                  page={page}
                  pageSize={pageSize}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                  sortBy={sortBy}
                  onSortByChange={setSortBy}
                  loading={loading}
                  error={error}
                  lastFetchedAt={lastFetchedAt}
                  refreshIntervalSec={refreshIntervalSec}
                  onRefreshIntervalChange={setRefreshIntervalSec}
                  selectedSlug={selectedSlug}
                  onSelectMarket={setSelectedSlug}
                  selectedSlugs={selectedSlugs}
                  onToggleSelect={toggleSelectMarket}
                  onToggleSelectAll={toggleSelectAllMarkets}
                  highlightThreshold={highlightThresholdPct != null ? highlightThresholdPct / 100 : null}
                />
              </>
            )}

            {selectedMarket && (
              <MarketDetail
                market={selectedMarket}
                onOpenSettings={() => setSettingsOpen(true)}
                onSelectRelated={setSelectedSlug}
              />
            )}
          </>
        )}
      </main>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onStatusChange={setDeepseekStatus}
        />
      )}
    </div>
  );
}
