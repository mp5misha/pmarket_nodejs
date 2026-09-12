import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb, queryMarkets, getMarket, getStats, getAllForExport, DEFAULT_DB_PATH } from "./db.js";
import { fetchPriceHistory } from "./polymarket.js";
import { runSyncStep } from "./sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/stats", (req, res) => {
  res.json(getStats(getDb(DEFAULT_DB_PATH)));
});

app.get("/api/markets", (req, res) => {
  const { search, status, sortBy, minVolume } = req.query;
  const rows = queryMarkets(getDb(DEFAULT_DB_PATH), {
    search,
    status,
    sortBy,
    minVolume: minVolume ? Number(minVolume) : 0,
  });
  res.json(rows);
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

app.post("/api/sync/step", async (req, res) => {
  try {
    const {
      offset = 0,
      batchSize = 50,
      closed = false,
      history = false,
      interval = "max",
    } = req.body || {};
    const result = await runSyncStep({
      dbPath: DEFAULT_DB_PATH,
      offset,
      batchSize,
      closed,
      history,
      interval,
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
