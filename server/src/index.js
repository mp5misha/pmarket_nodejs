import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getDb,
  queryMarkets,
  getMarket,
  getStats,
  getAllForExport,
  getTags,
  getSetting,
  setSetting,
  deleteSetting,
  DEFAULT_DB_PATH,
} from "./db.js";
import { fetchPriceHistory } from "./polymarket.js";
import { runSyncStep, refreshMarketPrices } from "./sync.js";
import { analyzeMarket } from "./deepseek.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DEEPSEEK_KEY_SETTING = "deepseek_api_key";
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

app.get("/api/stats", (req, res) => {
  res.json(getStats(getDb(DEFAULT_DB_PATH)));
});

app.get("/api/markets", (req, res) => {
  const { search, status, sortBy, minVolume, minPrice, maxPrice, tag } = req.query;
  const rows = queryMarkets(getDb(DEFAULT_DB_PATH), {
    search,
    status,
    sortBy,
    minVolume: minVolume ? Number(minVolume) : 0,
    minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
    maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
    tag: tag || undefined,
  });
  res.json(rows);
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

app.post("/api/markets/:slug/analyze", async (req, res) => {
  const row = getMarket(getDb(DEFAULT_DB_PATH), req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  try {
    const apiKey = getSetting(getDb(DEFAULT_DB_PATH), DEEPSEEK_KEY_SETTING);
    const analysis = await analyzeMarket(row.slug, { apiKey });
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
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
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

app.listen(PORT, () => {
  console.log(`Polymarket tracker listening on http://localhost:${PORT}`);
});
