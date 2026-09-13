import { useState } from "react";

export default function Sidebar({
  stats,
  syncStatus,
  tags,
  deepseekStatus,
  onSync,
  onExport,
  onOpenSettings,
  user,
  onLogout,
}) {
  const [limit, setLimit] = useState(500);
  // Defaults to "all" (not "active only") so a routine sync keeps both
  // active and resolved markets' active/closed flags and prices fresh —
  // an "active only" sync never re-touches a market once it resolves on
  // Polymarket's side (Gamma stops returning it for that query), so its
  // stored `closed` flag and price go stale forever, which makes the grid's
  // "Resolved" status filter look broken (missing or outdated markets)
  // even though the filter query itself is correct.
  const [status, setStatus] = useState("all");
  const [tag, setTag] = useState("");
  const [resolutionFrom, setResolutionFrom] = useState("");
  const [resolutionTo, setResolutionTo] = useState("");
  const [history, setHistory] = useState(false);
  const [interval, setInterval_] = useState("max");
  const [delay, setDelay] = useState(0.15);

  const pct = syncStatus.limit
    ? Math.min(100, Math.round((syncStatus.total / syncStatus.limit) * 100))
    : 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div>
          <h1>Polymarket Tracker</h1>
          <p className="tagline">Local dashboard for Polymarket's public market data.</p>
        </div>
        <button
          className="btn-icon"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
          {deepseekStatus && !deepseekStatus.configured && <span className="btn-icon-dot" />}
        </button>
      </div>

      <div className="stat-line">
        {stats.count} markets stored
        {stats.lastUpdated && <> · updated {new Date(stats.lastUpdated).toLocaleString()}</>}
      </div>

      {user && (
        <div className="account-line">
          <span title={user.email}>{user.email}</span>
          <button className="link-button" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}

      <div className="sync-panel">
        <div className="field">
          <label htmlFor="limit">Max markets to fetch</label>
          <input
            id="limit"
            type="number"
            min={10}
            max={10000}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </div>

        <div className="field">
          <label htmlFor="status">Market status</label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active only</option>
            <option value="closed">Closed only</option>
            <option value="all">All (active + closed)</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="sync-tag">Category / tag</label>
          <select id="sync-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="resolution-from">Resolves between</label>
          <div className="field-pair">
            <input
              id="resolution-from"
              type="date"
              value={resolutionFrom}
              onChange={(e) => setResolutionFrom(e.target.value)}
            />
            <input
              id="resolution-to"
              type="date"
              value={resolutionTo}
              onChange={(e) => setResolutionTo(e.target.value)}
            />
          </div>
        </div>

        <label className="field-row">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          Also fetch price history (min/max)
        </label>

        <div className="field">
          <label htmlFor="interval">History window</label>
          <select
            id="interval"
            value={interval}
            onChange={(e) => setInterval_(e.target.value)}
            disabled={!history}
          >
            <option value="max">max</option>
            <option value="1w">1w</option>
            <option value="1d">1d</option>
            <option value="6h">6h</option>
            <option value="1h">1h</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="delay">Delay between history calls (sec)</label>
          <input
            id="delay"
            type="number"
            step={0.05}
            min={0}
            max={5}
            value={delay}
            onChange={(e) => setDelay(Number(e.target.value))}
          />
        </div>

        <button
          className="btn"
          disabled={syncStatus.running}
          onClick={() =>
            onSync({ limit, status, tag, resolutionFrom, resolutionTo, history, interval, delay })
          }
        >
          {syncStatus.running ? "Syncing…" : "Run sync"}
        </button>

        {syncStatus.running && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="sync-note">
              {syncStatus.total}/{syncStatus.limit} markets synced
            </p>
          </>
        )}
        {syncStatus.error && <p className="sync-error">{syncStatus.error}</p>}

        <button className="btn btn-ghost" onClick={onExport}>
          Export CSV
        </button>
      </div>
    </aside>
  );
}
