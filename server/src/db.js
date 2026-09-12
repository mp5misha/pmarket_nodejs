import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.join(__dirname, "..", "polymarket.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS markets (
  slug            TEXT PRIMARY KEY,
  market_id       TEXT,
  condition_id    TEXT,
  question        TEXT,
  outcomes        TEXT,
  outcome_prices  TEXT,
  current_price   REAL,
  min_price       REAL,
  max_price       REAL,
  volume          REAL,
  liquidity       REAL,
  resolution_date TEXT,
  active          INTEGER,
  closed          INTEGER,
  yes_token_id    TEXT,
  tags            TEXT,
  last_updated    TEXT
);
CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume);
CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution_date);
`;

let dbInstance = null;
let dbInstancePath = null;

/** Returns a cached connection for dbPath, opening + migrating it on first use. */
export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (dbInstance && dbInstancePath === dbPath) return dbInstance;
  if (dbInstance) dbInstance.close();
  dbInstance = new Database(dbPath);
  dbInstance.exec(SCHEMA);
  // `tags` was added after the initial schema — CREATE TABLE IF NOT EXISTS
  // won't retrofit it onto a database file created before this change.
  const columns = dbInstance.prepare("PRAGMA table_info(markets)").all().map((c) => c.name);
  if (!columns.includes("tags")) {
    dbInstance.exec("ALTER TABLE markets ADD COLUMN tags TEXT");
  }
  dbInstancePath = dbPath;
  return dbInstance;
}

const UPSERT_SQL = `
INSERT INTO markets (slug, market_id, condition_id, question, outcomes,
                      outcome_prices, current_price, min_price, max_price,
                      volume, liquidity, resolution_date, active, closed,
                      yes_token_id, tags, last_updated)
VALUES (@slug, @market_id, @condition_id, @question, @outcomes,
        @outcome_prices, @current_price, @min_price, @max_price,
        @volume, @liquidity, @resolution_date, @active, @closed,
        @yes_token_id, @tags, @last_updated)
ON CONFLICT(slug) DO UPDATE SET
  market_id=excluded.market_id,
  condition_id=excluded.condition_id,
  question=excluded.question,
  outcomes=excluded.outcomes,
  outcome_prices=excluded.outcome_prices,
  current_price=excluded.current_price,
  min_price=COALESCE(excluded.min_price, markets.min_price),
  max_price=COALESCE(excluded.max_price, markets.max_price),
  volume=excluded.volume,
  liquidity=excluded.liquidity,
  resolution_date=excluded.resolution_date,
  active=excluded.active,
  closed=excluded.closed,
  yes_token_id=COALESCE(excluded.yes_token_id, markets.yes_token_id),
  tags=excluded.tags,
  last_updated=excluded.last_updated
`;

/** market is the normalized shape from polymarket.js (normalizeMarket). */
export function upsertMarket(db, market, { minPrice = null, maxPrice = null } = {}) {
  db.prepare(UPSERT_SQL).run({
    slug: market.slug,
    market_id: market.marketId ?? null,
    condition_id: market.conditionId ?? null,
    question: market.question ?? null,
    outcomes: JSON.stringify(market.outcomes ?? []),
    outcome_prices: JSON.stringify(market.outcomePrices ?? []),
    current_price: market.currentPrice ?? null,
    min_price: minPrice,
    max_price: maxPrice,
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    resolution_date: market.resolutionDate ?? null,
    active: market.active ? 1 : 0,
    closed: market.closed ? 1 : 0,
    yes_token_id: market.yesTokenId ?? null,
    tags: JSON.stringify(market.tags ?? []),
    last_updated: new Date().toISOString(),
  });
}

const SORTABLE = new Set(["volume", "liquidity", "current_price", "resolution_date"]);

export function queryMarkets(
  db,
  { search, status, sortBy = "volume", minVolume = 0, minPrice, maxPrice, tag } = {}
) {
  const clauses = [];
  const params = {};
  if (search) {
    clauses.push("(question LIKE @search OR slug LIKE @search)");
    params.search = `%${search}%`;
  }
  if (status === "active") clauses.push("active = 1");
  if (status === "closed") clauses.push("closed = 1");
  if (minVolume) {
    clauses.push("COALESCE(volume, 0) >= @minVolume");
    params.minVolume = minVolume;
  }
  if (minPrice != null) {
    clauses.push("current_price >= @minPrice");
    params.minPrice = minPrice;
  }
  if (maxPrice != null) {
    clauses.push("current_price <= @maxPrice");
    params.maxPrice = maxPrice;
  }
  if (tag) {
    clauses.push("tags LIKE @tag");
    params.tag = `%"${tag}"%`;
  }
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST`;
  return db.prepare(sql).all(params);
}

/** Distinct tag labels across all stored markets, sorted, for the category filter dropdown. */
export function getTags(db) {
  const rows = db.prepare("SELECT tags FROM markets WHERE tags IS NOT NULL AND tags != '[]'").all();
  const labels = new Set();
  for (const row of rows) {
    try {
      for (const t of JSON.parse(row.tags)) labels.add(t);
    } catch {
      // skip malformed JSON
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

export function getMarket(db, slug) {
  return db.prepare("SELECT * FROM markets WHERE slug = ?").get(slug);
}

export function getStats(db) {
  return db
    .prepare("SELECT COUNT(*) as count, MAX(last_updated) as lastUpdated FROM markets")
    .get();
}

export function getAllForExport(db) {
  return db.prepare("SELECT * FROM markets ORDER BY volume DESC NULLS LAST").all();
}
