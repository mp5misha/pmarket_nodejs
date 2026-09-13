import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const TIME_PERIODS = [
  { value: "DAY", label: "Today" },
  { value: "WEEK", label: "This week" },
  { value: "MONTH", label: "This month" },
  { value: "ALL", label: "All time" },
];

// Same option set/labels/default as Sidebar.jsx's auto-sync dropdown, just
// for whale positions instead of the market catalog.
const AUTO_REFRESH_OPTIONS = [
  { value: 0, label: "No automatic sync" },
  { value: 1000, label: "Every 1 sec" },
  { value: 5000, label: "Every 5 sec" },
  { value: 20000, label: "Every 20 sec" },
  { value: 60000, label: "Every 1 min" },
  { value: 300000, label: "Every 5 min" },
  { value: 600000, label: "Every 10 min" },
];

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtPct(v) {
  if (v === null || v === undefined) return "—";
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function fmtPrice(v) {
  return v === null || v === undefined ? "—" : Number(v).toFixed(3);
}

// A wallet with no reported display name shows as a shortened address
// (0x1234…abcd) rather than the full 42-character string.
function traderLabel(position) {
  if (position.traderName) return position.traderName;
  const w = position.traderWallet;
  if (!w) return "Unknown trader";
  return w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

// Same /event/{slug} shape used by MarketDetail's external links.
function eventUrl(base, position) {
  const slug = position.eventSlug || position.slug;
  if (!slug) return null;
  return `${base}/event/${encodeURIComponent(slug)}`;
}

/** Positions currently held by Polymarket's top-50 leaderboard traders
 * ("whales"), aggregated server-side from the public leaderboard + each
 * wallet's open positions (see server/src/whales.js / lib/whales.js) — a
 * live external read with no local persistence, unlike My Trades. */
export default function WhaleTrades() {
  const [timePeriod, setTimePeriod] = useState("DAY");
  const [orderBy, setOrderBy] = useState("VOL");
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.whales({ timePeriod, orderBy, limit: 50 }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timePeriod, orderBy]);

  // Same ref-based interval pattern as Sidebar.jsx's auto-sync: refresh()
  // and loading are read through refs so the interval itself only needs to
  // be recreated when autoRefreshMs changes, and a tick is skipped (not
  // queued) while the previous refresh is still in flight.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    if (!autoRefreshMs) return undefined;
    const id = setInterval(() => {
      if (loadingRef.current) return;
      refreshRef.current();
    }, autoRefreshMs);
    return () => clearInterval(id);
  }, [autoRefreshMs]);

  const positions = data?.positions ?? [];

  return (
    <div className="whale-trades">
      <h2>Whales trades</h2>
      <p className="discovery-note">
        Live open positions held by the top 50 traders on Polymarket's public leaderboard, ranked by{" "}
        {orderBy === "PNL" ? "profit" : "volume"} for the selected window — refreshed from Polymarket
        directly (not stored in this app's own database).
      </p>

      <div className="filters">
        <select value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)}>
          {TIME_PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select value={orderBy} onChange={(e) => setOrderBy(e.target.value)}>
          <option value="VOL">Ranked by volume</option>
          <option value="PNL">Ranked by profit</option>
        </select>
        <button className="btn btn-small btn-ghost" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <label className="grid-inline-label whale-auto-refresh-field">
        Automatically sync positions with selected conditions
        <select value={autoRefreshMs} onChange={(e) => setAutoRefreshMs(Number(e.target.value))}>
          {AUTO_REFRESH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="sync-error">{error}</p>}

      {data && (
        <p className="trades-summary">
          <span>{data.traderCount} traders</span>
          <span>{positions.length} positions</span>
          {data.failedWalletCount > 0 && (
            <span>{data.failedWalletCount} trader(s) skipped (unavailable)</span>
          )}
          <span>Fetched {new Date(data.fetchedAt).toLocaleTimeString()}</span>
        </p>
      )}

      {loading && !data ? (
        <p className="discovery-note">Loading…</p>
      ) : positions.length === 0 ? (
        <div className="empty-state">No whale positions found for this window.</div>
      ) : (
        <table className="discovery-table">
          <thead>
            <tr>
              <th>Trader</th>
              <th>Market</th>
              <th>Outcome</th>
              <th>Size</th>
              <th>Avg price</th>
              <th>Current price</th>
              <th>Position value</th>
              <th>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => {
              const url = eventUrl("https://polymarket.com", p);
              return (
                <tr key={`${p.traderWallet}-${p.conditionId}-${i}`}>
                  <td title={p.traderWallet || ""}>
                    {traderLabel(p)}
                    {p.traderVolume != null && (
                      <div className="q-slug">{fmtMoney(p.traderVolume)} volume</div>
                    )}
                  </td>
                  <td className="discovery-filters-cell" title={p.title || ""}>
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        {p.title || p.slug || "—"}
                      </a>
                    ) : (
                      p.title || "—"
                    )}
                  </td>
                  <td>{p.outcome || "—"}</td>
                  <td className="num">{p.size != null ? Number(p.size).toLocaleString() : "—"}</td>
                  <td className="num">{fmtPrice(p.avgPrice)}</td>
                  <td className="num">{fmtPrice(p.curPrice)}</td>
                  <td className="num">{fmtMoney(p.currentValue)}</td>
                  <td className={p.cashPnl > 0 ? "trades-profit-positive" : p.cashPnl < 0 ? "trades-profit-negative" : ""}>
                    {fmtMoney(p.cashPnl)} {p.percentPnl != null && <>({fmtPct(p.percentPnl)})</>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
