import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useCatalogFetch } from "../hooks/useCatalogFetch.js";

// Phase 2: a configurable Market Discovery screen — filter by date range,
// category/tag, min liquidity/volume, active/resolved status, and keyword;
// save named search configs; run an ad hoc "Fetch now"; optionally schedule
// a saved search to rerun automatically; and review an audit trail of every
// fetch run. Saved-search/fetch-run endpoints don't exist on the frozen
// Vercel deploy (see README's "Function count" section for why — Vercel
// Hobby's 12-serverless-function cap didn't leave room for them once
// api/analyses/[id]/follow-up.js was added), so this screen degrades to
// "feature unavailable" there instead of breaking. Fetch now itself still
// works there (api/sync/step.js) — doFetch's own summary message (below) is
// what confirms it worked, independent of the (also Vercel-unimplemented)
// fetch-run audit table.
export default function MarketDiscovery({ tags }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("active");
  const [tag, setTag] = useState("");
  const [resolutionFrom, setResolutionFrom] = useState("");
  const [resolutionTo, setResolutionTo] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [minLiquidity, setMinLiquidity] = useState("");
  const [keyword, setKeyword] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState("");
  const [limit, setLimit] = useState(500);

  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchesUnavailable, setSavedSearchesUnavailable] = useState(false);
  const [fetchRuns, setFetchRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [fetchSummary, setFetchSummary] = useState(null);

  const { syncStatus, run } = useCatalogFetch();

  const refreshSavedSearches = async () => {
    try {
      setSavedSearches(await api.listSavedSearches());
      setSavedSearchesUnavailable(false);
    } catch {
      setSavedSearchesUnavailable(true);
    }
  };

  const refreshFetchRuns = async () => {
    try {
      setFetchRuns(await api.listFetchRuns({ limit: 20 }));
    } catch {
      setFetchRuns([]);
    }
  };

  useEffect(() => {
    refreshSavedSearches();
    refreshFetchRuns();
  }, []);

  const currentFilters = () => ({
    status,
    tag: tag || undefined,
    resolutionFrom: resolutionFrom || undefined,
    resolutionTo: resolutionTo || undefined,
    minVolume: minVolume === "" ? undefined : Number(minVolume),
    minLiquidity: minLiquidity === "" ? undefined : Number(minLiquidity),
    keyword: keyword || undefined,
  });

  const doFetch = async (params, activeKey) => {
    setActiveRun(activeKey);
    setFetchSummary(null);
    try {
      const result = await run({ limit, history: false, interval: "max", delay: 0.1, ...params });
      setFetchSummary(
        result.total === 0
          ? "No markets matched these filters."
          : `Fetched ${result.total} market(s): ${result.added} added, ${result.updated} updated.`
      );
    } catch {
      // syncStatus.error already reflects the failure.
    } finally {
      refreshFetchRuns();
      setActiveRun(null);
    }
  };

  const handleFetchNow = () => doFetch({ savedSearchId: null, ...currentFilters() }, "adhoc");

  const handleRunSaved = (s) =>
    doFetch(
      {
        savedSearchId: s.id,
        status: s.status,
        tag: s.tag || undefined,
        resolutionFrom: s.resolution_from || undefined,
        resolutionTo: s.resolution_to || undefined,
        minVolume: s.min_volume ?? undefined,
        minLiquidity: s.min_liquidity ?? undefined,
        keyword: s.keyword || undefined,
      },
      s.id
    );

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveError("Name is required to save a search");
      return;
    }
    setSaveError(null);
    try {
      await api.createSavedSearch({
        name: name.trim(),
        ...currentFilters(),
        scheduleMinutes: scheduleMinutes === "" ? undefined : Number(scheduleMinutes),
      });
      setName("");
      setScheduleMinutes("");
      refreshSavedSearches();
    } catch (err) {
      if (err.status === 404) {
        setSavedSearchesUnavailable(true);
        setSaveError("Saved searches aren't available on this deploy target yet.");
      } else {
        setSaveError(err.message);
      }
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.deleteSavedSearch(id);
      refreshSavedSearches();
    } catch {
      /* non-fatal */
    }
  };

  const pct = syncStatus.limit
    ? Math.min(100, Math.round((syncStatus.total / syncStatus.limit) * 100))
    : 0;

  return (
    <div className="discovery">
      <h2>Market Discovery</h2>
      <p className="discovery-intro">
        Configure filters, optionally save them as a named search, then fetch matching markets from
        Polymarket into the local catalog.
      </p>

      <div className="discovery-form">
        <div className="field">
          <label htmlFor="disc-name">Save as (optional)</label>
          <input
            id="disc-name"
            type="text"
            placeholder="e.g. High-volume US politics"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="disc-status">Status</label>
          <select id="disc-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="closed">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="disc-tag">Category / tag</label>
          <select id="disc-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="disc-resolution-from">Resolves between</label>
          <div className="field-pair">
            <input
              id="disc-resolution-from"
              type="date"
              value={resolutionFrom}
              onChange={(e) => setResolutionFrom(e.target.value)}
            />
            <input
              id="disc-resolution-to"
              type="date"
              value={resolutionTo}
              onChange={(e) => setResolutionTo(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="disc-min-volume">Min volume $</label>
          <input
            id="disc-min-volume"
            type="number"
            min={0}
            value={minVolume}
            onChange={(e) => setMinVolume(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="disc-min-liquidity">Min liquidity $</label>
          <input
            id="disc-min-liquidity"
            type="number"
            min={0}
            value={minLiquidity}
            onChange={(e) => setMinLiquidity(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="disc-keyword">Keyword</label>
          <input
            id="disc-keyword"
            type="text"
            placeholder="Search question text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="disc-limit">Max markets to fetch</label>
          <input
            id="disc-limit"
            type="number"
            min={10}
            max={10000}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </div>

        <div className="field">
          <label htmlFor="disc-schedule">Auto re-run every (minutes, blank = manual only)</label>
          <input
            id="disc-schedule"
            type="number"
            min={0}
            placeholder="off"
            value={scheduleMinutes}
            onChange={(e) => setScheduleMinutes(e.target.value)}
          />
        </div>

        <div className="discovery-actions">
          <button
            className="btn"
            disabled={syncStatus.running}
            onClick={handleFetchNow}
          >
            {syncStatus.running && activeRun === "adhoc" ? "Fetching…" : "Fetch now"}
          </button>
          <button
            className="btn btn-ghost"
            disabled={syncStatus.running || savedSearchesUnavailable}
            title={savedSearchesUnavailable ? "Saved searches aren't available on this deploy target yet." : undefined}
            onClick={handleSave}
          >
            Save search
          </button>
        </div>

        {saveError && <p className="sync-error">{saveError}</p>}

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
        {!syncStatus.running && fetchSummary && <p className="sync-note">{fetchSummary}</p>}
        {syncStatus.error && <p className="sync-error">{syncStatus.error}</p>}
      </div>

      <div className="discovery-section">
        <h3>Saved searches</h3>
        {savedSearchesUnavailable ? (
          <p className="discovery-note">
            Saved searches aren't available on this deploy target yet.
          </p>
        ) : savedSearches.length === 0 ? (
          <p className="discovery-note">No saved searches yet.</p>
        ) : (
          <table className="discovery-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Tag</th>
                <th>Keyword</th>
                <th>Schedule</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {savedSearches.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.status}</td>
                  <td>{s.tag || "—"}</td>
                  <td>{s.keyword || "—"}</td>
                  <td>{s.schedule_minutes ? `every ${s.schedule_minutes}m` : "manual"}</td>
                  <td>{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never"}</td>
                  <td className="discovery-row-actions">
                    <button
                      className="btn btn-small"
                      disabled={syncStatus.running}
                      onClick={() => handleRunSaved(s)}
                    >
                      {syncStatus.running && activeRun === s.id ? "Running…" : "Run"}
                    </button>
                    <button className="btn btn-small btn-ghost" onClick={() => handleDelete(s.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="discovery-section">
        <h3>Recent fetch runs</h3>
        {fetchRuns.length === 0 ? (
          <p className="discovery-note">No fetch runs recorded yet.</p>
        ) : (
          <table className="discovery-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Added</th>
                <th>Updated</th>
                <th>Filters</th>
              </tr>
            </thead>
            <tbody>
              {fetchRuns.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.started_at).toLocaleString()}</td>
                  <td>{r.status}</td>
                  <td>{r.markets_added}</td>
                  <td>{r.markets_updated}</td>
                  <td className="discovery-filters-cell" title={r.filters_json}>
                    {r.filters_json}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
