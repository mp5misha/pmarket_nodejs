import { useRef, useState } from "react";
import { api } from "../api.js";

// Runs a catalog sync as a series of bounded steps (see api.syncStep) —
// small enough per call to stay well within a serverless function's time
// limit, looped here in the browser until the target is reached or the
// server reports no more pages. Used by the sidebar's "Run sync".
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
  }) => {
    cancelRef.current = false;
    setSyncStatus({ running: true, total: 0, limit, error: null });

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
      return { total, added, updated };
    } catch (err) {
      setSyncStatus({ running: false, total, limit, error: err.message });
      throw err;
    }
  };

  return { syncStatus, run, cancel };
}
