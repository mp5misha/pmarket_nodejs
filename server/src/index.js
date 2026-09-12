import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getDb,
  queryMarkets,
  queryMarketsGrouped,
  getMarket,
  getMarketsByEvent,
  getStats,
  getAllForExport,
  getTags,
  getSetting,
  setSetting,
  deleteSetting,
  listSavedSearches,
  getSavedSearch,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
  createFetchRun,
  completeFetchRun,
  listFetchRuns,
  listDueSavedSearches,
  markSavedSearchRun,
  DEFAULT_DB_PATH,
} from "./db.js";
import { fetchPriceHistory } from "./polymarket.js";
import { runSyncStep, refreshMarketPrices, runFullSync } from "./sync.js";
import { analyzeMarket, DEFAULT_PROMPT_TEMPLATE } from "./deepseek.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DEEPSEEK_KEY_SETTING = "deepseek_api_key";
const DEEPSEEK_PROMPT_SETTING = "deepseek_prompt_template";
const app = express();
app.use(cors());
app.use(express.json());

/** Reports whether a DeepSeek key is available and where it came from,
 * without ever sending the key itself back to the client. */
function deepseekKeyStatus() {
  const stored = getSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_KEY_SETTING);
  if (stored) return { configured: true, source: "database" };
  if (process.env.DEEPSEEK_API_KEY) return { configured: true, source: "env" };
  return { configured: false, source: "none" };
}

function deepseekPromptStatus() {
  const stored = getSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_PROMPT_SETTING);
  return { template: stored || DEFAULT_PROMPT_TEMPLATE, isDefault: !stored };
}

app.get("/api/stats", (req, res) => {
  res.json(getStats(getDb(DEFAULT_DB_PATH)));
});

app.get("/api/markets", (req, res) => {
  const { search, status, sortBy, minVolume, minPrice, maxPrice, tag, page, pageSize } = req.query;
  const result = queryMarkets(getDb(DEFAULT_DB_PATH), {
    search,
    status,
    sortBy,
    minVolume: minVolume ? Number(minVolume) : 0,
    minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
    maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
    tag: tag || undefined,
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 50,
  });
  res.json(result);
});

// Event/market grid (Phase 1) — same filters as /api/markets, but grouped by
// Polymarket event and paginated over groups. /api/markets stays untouched
// (flat, ungrouped) since CSV export and the bulk price-refresh selection
// still depend on that shape.
app.get("/api/markets/grouped", (req, res) => {
  const { search, status, sortBy, minVolume, minPrice, maxPrice, tag, page, pageSize } = req.query;
  const result = queryMarketsGrouped(getDb(DEFAULT_DB_PATH), {
    search,
    status,
    sortBy,
    minVolume: minVolume ? Number(minVolume) : 0,
    minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
    maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
    tag: tag || undefined,
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 25,
  });
  res.json(result);
});

app.get("/api/tags", (req, res) => {
  res.json(getTags(getDb(DEFAULT_DB_PATH)));
});

app.get("/api/markets/:slug", (req, res) => {
  const row = getMarket(getDb(DEFAULT_DB_PATH), req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  res.json(row);
});

app.get("/api/markets/:slug/history", async (req, res) => {
  const row = getMarket(getDb(DEFAULT_DB_PATH), req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  if (!row.yes_token_id) {
    return res
      .status(400)
      .json({ error: "No CLOB token id stored for this market yet — sync with history enabled." });
  }
  try {
    const history = await fetchPriceHistory(row.yes_token_id, req.query.interval || "max");
    res.json(history);
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/markets/:slug/related", (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const row = getMarket(db, req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  if (!row.event_id) return res.json([]);
  res.json(getMarketsByEvent(db, row.event_id, row.slug));
});

app.post("/api/markets/:slug/analyze", async (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const row = getMarket(db, req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  try {
    const apiKey = getSetting(db, DEEPSEEK_KEY_SETTING);
    const promptTemplate = getSetting(db, DEEPSEEK_PROMPT_SETTING);
    const analysis = await analyzeMarket(row, { apiKey, promptTemplate });
    res.status(200).json({ analysis });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/settings/deepseek-key", (req, res) => {
  res.json(deepseekKeyStatus());
});

app.post("/api/settings/deepseek-key", (req, res) => {
  const { apiKey } = req.body || {};
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return res.status(400).json({ error: "apiKey is required" });
  }
  setSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_KEY_SETTING, apiKey.trim());
  res.status(200).json(deepseekKeyStatus());
});

app.delete("/api/settings/deepseek-key", (req, res) => {
  deleteSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_KEY_SETTING);
  res.status(200).json(deepseekKeyStatus());
});

app.get("/api/settings/deepseek-prompt", (req, res) => {
  res.json(deepseekPromptStatus());
});

app.post("/api/settings/deepseek-prompt", (req, res) => {
  const { template } = req.body || {};
  if (typeof template !== "string" || !template.trim()) {
    return res.status(400).json({ error: "template is required" });
  }
  setSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_PROMPT_SETTING, template);
  res.status(200).json(deepseekPromptStatus());
});

app.delete("/api/settings/deepseek-prompt", (req, res) => {
  deleteSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_PROMPT_SETTING);
  res.status(200).json(deepseekPromptStatus());
});

app.get("/api/export", (req, res) => {
  const rows = getAllForExport(getDb(DEFAULT_DB_PATH));
  if (!rows.length) return res.status(404).send("No data to export yet");
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=markets.csv");
  res.send(lines.join("\n"));
});

app.post("/api/markets/refresh", async (req, res) => {
  const { slugs } = req.body || {};
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: "slugs must be a non-empty array" });
  }
  try {
    const result = await refreshMarketPrices({ dbPath: DEFAULT_DB_PATH, slugs });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.post("/api/sync/step", async (req, res) => {
  try {
    const {
      offset = 0,
      batchSize = 50,
      status = "active",
      history = false,
      interval = "max",
      tag = "",
      resolutionFrom = "",
      resolutionTo = "",
      minVolume = 0,
      minLiquidity = 0,
      keyword = "",
    } = req.body || {};
    const result = await runSyncStep({
      dbPath: DEFAULT_DB_PATH,
      offset,
      batchSize,
      status,
      history,
      interval,
      tag,
      resolutionFrom,
      resolutionTo,
      minVolume,
      minLiquidity,
      keyword,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// Market Discovery (Phase 2) — saved search configurations.
app.get("/api/saved-searches", (req, res) => {
  res.json(listSavedSearches(getDb(DEFAULT_DB_PATH)));
});

app.post("/api/saved-searches", (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const created = createSavedSearch(getDb(DEFAULT_DB_PATH), req.body);
  res.status(201).json(created);
});

app.put("/api/saved-searches/:id", (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const existing = getSavedSearch(db, req.params.id);
  if (!existing) return res.status(404).json({ error: "Saved search not found" });
  const merged = {
    name: existing.name,
    status: existing.status,
    tag: existing.tag,
    resolutionFrom: existing.resolution_from,
    resolutionTo: existing.resolution_to,
    minVolume: existing.min_volume,
    minLiquidity: existing.min_liquidity,
    keyword: existing.keyword,
    scheduleMinutes: existing.schedule_minutes,
    ...req.body,
  };
  const updated = updateSavedSearch(db, req.params.id, merged);
  res.status(200).json(updated);
});

app.delete("/api/saved-searches/:id", (req, res) => {
  deleteSavedSearch(getDb(DEFAULT_DB_PATH), req.params.id);
  res.status(204).end();
});

// Market Discovery (Phase 2) — audit trail of catalog fetches, either ad hoc
// or tied to a saved search. The client creates a run before starting its
// sync-step loop, then marks it complete/failed once the loop finishes.
app.get("/api/fetch-runs", (req, res) => {
  const { savedSearchId, limit } = req.query;
  res.json(
    listFetchRuns(getDb(DEFAULT_DB_PATH), {
      savedSearchId: savedSearchId ? Number(savedSearchId) : undefined,
      limit: limit ? Number(limit) : 50,
    })
  );
});

app.post("/api/fetch-runs", (req, res) => {
  const { savedSearchId, filters } = req.body || {};
  const id = createFetchRun(getDb(DEFAULT_DB_PATH), { savedSearchId: savedSearchId ?? null, filters });
  res.status(201).json({ id });
});

app.post("/api/fetch-runs/:id/complete", (req, res) => {
  const { marketsAdded = 0, marketsUpdated = 0, status = "completed", error = null } = req.body || {};
  completeFetchRun(getDb(DEFAULT_DB_PATH), req.params.id, { marketsAdded, marketsUpdated, status, error });
  res.status(200).json({ ok: true });
});

// In production, serve the built client (client/dist) from this same
// process/port — lets the whole app run as one deployable service instead
// of two separate dev servers. No-op locally until you run `npm run build`.
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
  console.log("Serving built client from", clientDist);
}

// Phase 2's "optional scheduled reruns" — a saved search with
// schedule_minutes set is re-fetched automatically. In-process interval
// rather than a separate job queue/cron dependency, per the agreed job
// scheduling approach; only meaningful while this server process stays up.
const SCHEDULE_POLL_MS = 60_000;

async function runDueScheduledSearches() {
  const db = getDb(DEFAULT_DB_PATH);
  const due = listDueSavedSearches(db);
  for (const s of due) {
    const filters = {
      status: s.status,
      tag: s.tag || "",
      resolutionFrom: s.resolution_from || "",
      resolutionTo: s.resolution_to || "",
      minVolume: s.min_volume || 0,
      minLiquidity: s.min_liquidity || 0,
      keyword: s.keyword || "",
    };
    const runId = createFetchRun(db, { savedSearchId: s.id, filters });
    try {
      const result = await runFullSync({ dbPath: DEFAULT_DB_PATH, ...filters });
      completeFetchRun(db, runId, {
        marketsAdded: result.added,
        marketsUpdated: result.updated,
        status: "completed",
      });
    } catch (err) {
      completeFetchRun(db, runId, { status: "failed", error: String(err.message ?? err) });
    }
    markSavedSearchRun(db, s.id);
  }
}

setInterval(() => {
  runDueScheduledSearches().catch((err) => console.error("Scheduled saved-search run failed:", err));
}, SCHEDULE_POLL_MS);

app.listen(PORT, () => {
  console.log(`Polymarket tracker listening on http://localhost:${PORT}`);
});
