import { useEffect, useState } from "react";
import { api } from "./api.js";
import Sidebar from "./components/Sidebar.jsx";
import MarketGrid from "./components/MarketGrid.jsx";
import MarketDetail from "./components/MarketDetail.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import MyTrades from "./components/MyTrades.jsx";
import AuthScreen, { VerifyEmailLanding, ResetPasswordLanding } from "./components/AuthScreen.jsx";
import { useMarketGroups } from "./hooks/useMarketGroups.js";
import { useCatalogFetch } from "./hooks/useCatalogFetch.js";

// No router library (consistent with the rest of the app, e.g. the view
// switcher) — the two email-link landing pages are recognized by a plain
// window.location check instead.
function parseUrlRoute() {
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get("token");
  if (path === "/verify-email" && token) return { type: "verify-email", token };
  if (path === "/reset-password" && token) return { type: "reset-password", token };
  return null;
}

export default function App() {
  // undefined = still checking the session cookie; null = logged out;
  // an object = the authenticated user.
  const [authUser, setAuthUser] = useState(undefined);
  // This same client is also served by the frozen Vercel/Postgres backend
  // (api/, lib/), which predates accounts and has no /api/auth/* routes at
  // all — api.me() reports that via authSupported: false. Showing a login
  // screen there would lock every visitor out permanently (no working
  // login endpoint behind it), so the auth gate is skipped entirely on
  // that backend and the app renders exactly as it did before Phase 8.
  const [authSupported, setAuthSupported] = useState(true);
  const [urlRoute, setUrlRoute] = useState(parseUrlRoute);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setAuthUser(r.user);
        setAuthSupported(r.authSupported !== false);
      })
      .catch(() => setAuthUser(null));
  }, []);

  const clearUrlRoute = () => {
    window.history.replaceState({}, "", "/");
    setUrlRoute(null);
  };

  if (urlRoute?.type === "verify-email") {
    return <VerifyEmailLanding token={urlRoute.token} onDone={clearUrlRoute} />;
  }
  if (urlRoute?.type === "reset-password") {
    return <ResetPasswordLanding token={urlRoute.token} onDone={clearUrlRoute} />;
  }

  if (authUser === undefined) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Polymarket Tracker</h1>
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  if (authSupported && authUser === null) {
    return <AuthScreen onAuthenticated={setAuthUser} />;
  }

  return (
    <MainApp
      user={authSupported ? authUser : null}
      onLogout={() => {
        api.logout().finally(() => setAuthUser(null));
      }}
    />
  );
}

function MainApp({ user, onLogout }) {
  const [stats, setStats] = useState({ count: 0, lastUpdated: null });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sortBy, setSortBy] = useState("volume");
  const [minVolume, setMinVolume] = useState(0);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState([]);
  const [myTradesOnly, setMyTradesOnly] = useState(false);

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
      myTrades: myTradesOnly || undefined,
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
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
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
  }, [search, status, sortBy, minVolume, minPrice, maxPrice, tag, myTradesOnly, pageSize]);

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

  // Removes the checked rows from the local catalog entirely — e.g.
  // clearing out resolved markets you don't want cluttering the grid
  // anymore. Doesn't touch any trades recorded against those slugs.
  const deleteSelectedMarkets = async () => {
    if (selectedSlugs.size === 0) return;
    const count = selectedSlugs.size;
    if (!window.confirm(`Delete ${count} market(s) from the catalog? This can't be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteMarkets([...selectedSlugs]);
      setSelectedSlugs(new Set());
      if (selectedSlug && selectedSlugs.has(selectedSlug)) setSelectedSlug(null);
      await Promise.all([refetchGrid(), refreshStats()]);
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  // Thin wrapper around useCatalogFetch's run() for the sidebar's "Run
  // sync" button.
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
        user={user}
        onLogout={onLogout}
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
            className={`view-tab ${view === "trades" ? "active" : ""}`}
            onClick={() => setView("trades")}
          >
            My Trades
          </button>
        </div>

        {view === "trades" ? (
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
                <option value="closed">Resolved</option>
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
              <label className="field-row my-trades-filter">
                <input
                  type="checkbox"
                  checked={myTradesOnly}
                  onChange={(e) => setMyTradesOnly(e.target.checked)}
                />
                My trade markets
              </label>
            </div>

            {refreshError && <p className="sync-error">{refreshError}</p>}
            {deleteError && <p className="sync-error">{deleteError}</p>}

            {!loading && totalMarkets === 0 && groups.length === 0 && !search && !status && !tag && !myTradesOnly ? (
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
                      disabled={selectedSlugs.size === 0 || refreshing || deleting}
                      onClick={updateSelectedPrices}
                    >
                      {refreshing ? "Updating…" : "Update selected prices"}
                    </button>
                    <button
                      className="btn btn-small btn-ghost"
                      disabled={selectedSlugs.size === 0 || refreshing || deleting}
                      onClick={deleteSelectedMarkets}
                    >
                      {deleting ? "Deleting…" : "Delete selected"}
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
                  statusFilter={status}
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
