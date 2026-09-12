import { useState } from "react";

export default function Sidebar({ stats, syncStatus, onSync, onExport }) {
  const [limit, setLimit] = useState(500);
  const [closed, setClosed] = useState(false);
  const [history, setHistory] = useState(false);
  const [interval, setInterval_] = useState("max");
  const [delay, setDelay] = useState(0.15);

  const pct = syncStatus.limit
    ? Math.min(100, Math.round((syncStatus.total / syncStatus.limit) * 100))
    : 0;

  return (
    <aside className="sidebar">
      <div>
        <h1>Polymarket Tracker</h1>
        <p className="tagline">Local dashboard for Polymarket's public market data.</p>
      </div>

      <div className="stat-line">
        {stats.count} markets stored
        {stats.lastUpdated && <> · updated {new Date(stats.lastUpdated).toLocaleString()}</>}
      </div>

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

        <label className="field-row">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
          Fetch closed markets instead of active
        </label>

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
            max={1}
            value={delay}
            onChange={(e) => setDelay(Number(e.target.value))}
            disabled={!history}
          />
        </div>

        <button
          className="btn"
          disabled={syncStatus.running}
          onClick={() => onSync({ limit, closed, history, interval, delay })}
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
