import { useRef, useState } from "react";
import { api } from "../api.js";

// Runs a catalog sync as a series of bounded steps (see api.syncStep) —
// small enough per call to stay well within a serverless function's time
// limit, looped here in the browser until the target is reached or the
// server reports no more pages. Shared by the sidebar's "Run sync" and the
// Market Discovery screen's "Fetch now"/saved-search "Run" actions.
//
// Optionally wraps the run in an audited fetch_run record (Phase 2) —
// created before the loop starts, marked complete/failed after it ends.
// Fetch-run endpoints don't exist on every deploy target yet (the frozen
// Vercel backend, notably), so audit calls are best-effort and never block
// or fail the sync itself.
export function useCatalogFetch() {
  const [syncStatus, setSyncStatus] = useState({ running: false, total: 0, limit: 0, error: null });
  const cancelRef = useRef(false);

  const cancel = () => {
    cancelRef.current = true;
  };

  const run = async ({
    limit,
    status,
    tag,
    resolutionFrom,
    resolutionTo,
    minVolume,
    minLiquidity,
    keyword,
    history,
    interval,
    delay,
    savedSearchId = null,
  }) => {
    cancelRef.current = false;
    setSyncStatus({ running: true, total: 0, limit, error: null });

    const filters = {
      status,
      tag,
      resolutionFrom,
      resolutionTo,
      minVolume,
      minLiquidity,
      keyword,
      history,
      interval,
    };

    let runId = null;
    try {
      const created = await api.createFetchRun({ savedSearchId, filters });
      runId = created.id;
    } catch {
      // Not available on this deploy target — proceed without an audit record.
    }

    const batchSize = history ? 20 : 100;
    let offset = 0;
    let total = 0;
    let added = 0;
    let updated = 0;

    try {
      while (total < limit && !cancelRef.current) {
        const step = await api.syncStep({
          offset,
          batchSize: Math.min(batchSize, limit - total),
          status,
          tag,
          resolutionFrom,
          resolutionTo,
          minVolume,
          minLiquidity,
          keyword,
          history,
          interval,
        });
        total += step.processed;
        added += step.added || 0;
        updated += step.updated || 0;
        offset = step.nextOffset;
        setSyncStatus({ running: true, total, limit, error: null });
        if (step.done) break;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
      setSyncStatus({ running: false, total, limit, error: null });
      if (runId != null) {
        api
          .completeFetchRun(runId, { marketsAdded: added, marketsUpdated: updated, status: "completed" })
          .catch(() => {});
      }
      return { total, added, updated };
    } catch (err) {
      setSyncStatus({ running: false, total, limit, error: err.message });
      if (runId != null) {
        api
          .completeFetchRun(runId, {
            marketsAdded: added,
            marketsUpdated: updated,
            status: "failed",
            error: err.message,
          })
          .catch(() => {});
      }
      throw err;
    }
  };

  return { syncStatus, run, cancel };
}
