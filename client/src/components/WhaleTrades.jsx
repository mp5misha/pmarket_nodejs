import { useEffect, useRef, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { api } from "../api.js";

const TIME_PERIODS = [
  { value: "DAY", label: "Today" },
  { value: "WEEK", label: "This week" },
  { value: "MONTH", label: "This month" },
  { value: "ALL", label: "All time" },
];

const LEADERBOARD_SIZES = [
  { value: 50, label: "Top 50" },
  { value: 100, label: "Top 100" },
  { value: 150, label: "Top 150" },
  { value: 200, label: "Top 200" },
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

// Same wallet-fallback rule as traderLabel, for a top-10-traders entry
// ({ name, wallet }) rather than a position ({ traderName, traderWallet }).
function topTraderLabel(t) {
  if (t.name) return t.name;
  const w = t.wallet;
  if (!w) return "Unknown trader";
  return w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

/** Positions currently held by Polymarket's top-50 leaderboard traders
 * ("whales"), aggregated server-side from the public leaderboard + each
 * wallet's open positions (see server/src/whales.js / lib/whales.js). Each
 * successful rescan is persisted to this app's own database as a durable
 * "last known good" snapshot (unlike My Trades' user-entered records, this
 * is a cache of external data, not something you edit here), so a rescan
 * that fails outright still has something to show — see the `stale` flag
 * below. */
export default function WhaleTrades() {
  const [timePeriod, setTimePeriod] = useState("DAY");
  const [orderBy, setOrderBy] = useState("VOL");
  const [leaderboardSize, setLeaderboardSize] = useState(50);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.whales({ timePeriod, orderBy, limit: leaderboardSize }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timePeriod, orderBy, leaderboardSize]);

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
  const topTraders = data?.topTraders ?? [];

  return (
    <div className="whale-trades">
      <h2>Whales trades</h2>
      <p className="discovery-note">
        Live open positions held by the top {leaderboardSize} traders on Polymarket's public leaderboard,
        ranked by {orderBy === "PNL" ? "profit" : "volume"} for the selected window — refreshed from
        Polymarket directly (unrelated to the sidebar's "Run sync"). Each successful rescan is saved to
        this app's own database, so a temporary Polymarket outage falls back to the last known snapshot
        instead of showing nothing.
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
        <select value={leaderboardSize} onChange={(e) => setLeaderboardSize(Number(e.target.value))}>
          {LEADERBOARD_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
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
          {data.stale && (
            <span className="sync-error">
              Live rescan failed — showing the last successfully stored snapshot
            </span>
          )}
        </p>
      )}

      {topTraders.length > 0 && (
        <div className="chart-block whale-top-traders">
          <p className="chart-title">
            Top 10 most profitable traders — realized P&amp;L for the selected window, from Polymarket's
            own leaderboard stats
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={topTraders.map((t) => ({ ...t, label: topTraderLabel(t) }))}>
              <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={70} />
              <YAxis tick={{ fontSize: 11 }} width={60} />
              <Tooltip formatter={(v) => [`$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`, "Realized P&L"]} />
              <Bar dataKey="pnl">
                {topTraders.map((t) => (
                  <Cell key={t.rank} fill={(t.pnl ?? 0) >= 0 ? "var(--up)" : "var(--down)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <table className="discovery-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Trader</th>
                <th>Realized P&amp;L</th>
                <th>Volume</th>
              </tr>
            </thead>
            <tbody>
              {topTraders.map((t) => (
                <tr key={t.rank}>
                  <td className="num">{t.rank}</td>
                  <td title={t.wallet || ""}>{topTraderLabel(t)}</td>
                  <td className={t.pnl > 0 ? "trades-profit-positive" : t.pnl < 0 ? "trades-profit-negative" : ""}>
                    {fmtMoney(t.pnl)}
                  </td>
                  <td className="num">{fmtMoney(t.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
