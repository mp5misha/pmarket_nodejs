import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.join(__dirname, "..", "polymarket.db");

const CREATE_MARKETS_TABLE = `
CREATE TABLE IF NOT EXISTS markets (
  slug            TEXT PRIMARY KEY,
  market_id       TEXT,
  condition_id    TEXT,
  question        TEXT,
  outcomes        TEXT,
  outcome_prices  TEXT,
  current_price   REAL,
  no_price        REAL,
  min_price       REAL,
  max_price       REAL,
  volume          REAL,
  liquidity       REAL,
  resolution_date TEXT,
  active          INTEGER,
  closed          INTEGER,
  yes_token_id    TEXT,
  tags            TEXT,
  event_id        TEXT,
  event_slug      TEXT,
  event_title     TEXT,
  last_updated    TEXT
);
`;

// Indexes (idx_markets_event references a column that's only guaranteed to
// exist once the ALTER TABLEs in getDb() below have run) and the settings
// table — created after those migrations, not before.
const CREATE_INDEXES_AND_SETTINGS = `
CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume);
CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution_date);
CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let dbInstance = null;
let dbInstancePath = null;

/** Returns a cached connection for dbPath, opening + migrating it on first use. */
export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (dbInstance && dbInstancePath === dbPath) return dbInstance;
  if (dbInstance) dbInstance.close();
  dbInstance = new Database(dbPath);
  dbInstance.exec(CREATE_MARKETS_TABLE);
  // Columns added after the initial schema — CREATE TABLE IF NOT EXISTS won't
  // retrofit them onto a database file created before each change. These
  // must run before CREATE_INDEXES_AND_SETTINGS, since idx_markets_event
  // indexes a column that may not exist yet on an older database file.
  const columns = dbInstance.prepare("PRAGMA table_info(markets)").all().map((c) => c.name);
  const addColumnIfMissing = (name, ddl) => {
    if (!columns.includes(name)) dbInstance.exec(`ALTER TABLE markets ADD COLUMN ${ddl}`);
  };
  addColumnIfMissing("tags", "tags TEXT");
  addColumnIfMissing("no_price", "no_price REAL");
  addColumnIfMissing("event_id", "event_id TEXT");
  addColumnIfMissing("event_slug", "event_slug TEXT");
  addColumnIfMissing("event_title", "event_title TEXT");
  dbInstance.exec(CREATE_INDEXES_AND_SETTINGS);
  dbInstancePath = dbPath;
  return dbInstance;
}

const UPSERT_SQL = `
INSERT INTO markets (slug, market_id, condition_id, question, outcomes,
                      outcome_prices, current_price, no_price, min_price, max_price,
                      volume, liquidity, resolution_date, active, closed,
                      yes_token_id, tags, event_id, event_slug, event_title, last_updated)
VALUES (@slug, @market_id, @condition_id, @question, @outcomes,
        @outcome_prices, @current_price, @no_price, @min_price, @max_price,
        @volume, @liquidity, @resolution_date, @active, @closed,
        @yes_token_id, @tags, @event_id, @event_slug, @event_title, @last_updated)
ON CONFLICT(slug) DO UPDATE SET
  market_id=excluded.market_id,
  condition_id=excluded.condition_id,
  question=excluded.question,
  outcomes=excluded.outcomes,
  outcome_prices=excluded.outcome_prices,
  current_price=excluded.current_price,
  no_price=excluded.no_price,
  min_price=COALESCE(excluded.min_price, markets.min_price),
  max_price=COALESCE(excluded.max_price, markets.max_price),
  volume=excluded.volume,
  liquidity=excluded.liquidity,
  resolution_date=excluded.resolution_date,
  active=excluded.active,
  closed=excluded.closed,
  yes_token_id=COALESCE(excluded.yes_token_id, markets.yes_token_id),
  tags=excluded.tags,
  event_id=excluded.event_id,
  event_slug=excluded.event_slug,
  event_title=excluded.event_title,
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
    no_price: market.noPrice ?? null,
    min_price: minPrice,
    max_price: maxPrice,
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    resolution_date: market.resolutionDate ?? null,
    active: market.active ? 1 : 0,
    closed: market.closed ? 1 : 0,
    yes_token_id: market.yesTokenId ?? null,
    tags: JSON.stringify(market.tags ?? []),
    event_id: market.eventId ?? null,
    event_slug: market.eventSlug ?? null,
    event_title: market.eventTitle ?? null,
    last_updated: new Date().toISOString(),
  });
}

const SORTABLE = new Set(["volume", "liquidity", "current_price", "resolution_date"]);

/** Returns { rows, total, page, pageSize } — `total` is the count matching
 * the filters across all pages, for the grid's pagination controls. */
export function queryMarkets(
  db,
  {
    search,
    status,
    sortBy = "volume",
    minVolume = 0,
    minPrice,
    maxPrice,
    tag,
    page = 1,
    pageSize = 50,
  } = {}
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

  const total = db.prepare(`SELECT COUNT(*) AS count FROM markets ${where}`).get(params).count;

  const pageSizeSafe = Math.max(1, Math.min(500, pageSize));
  const pageSafe = Math.max(1, page);
  const offset = (pageSafe - 1) * pageSizeSafe;
  const sql = `SELECT * FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST LIMIT @pageSize OFFSET @offset`;
  const rows = db.prepare(sql).all({ ...params, pageSize: pageSizeSafe, offset });

  return { rows, total, page: pageSafe, pageSize: pageSizeSafe };
}

/** Sibling markets under the same Polymarket event (e.g. other candidates in
 * the same election), for the detail panel's "related markets" list. */
export function getMarketsByEvent(db, eventId, excludeSlug) {
  return db
    .prepare(
      `SELECT slug, question, current_price, no_price, volume
       FROM markets WHERE event_id = ? AND slug != ?
       ORDER BY volume DESC NULLS LAST`
    )
    .all(eventId, excludeSlug);
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

/** Small generic key/value store — currently used to let the app's settings
 * window save the DeepSeek API key without an environment variable. */
export function getSetting(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function deleteSetting(db, key) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
