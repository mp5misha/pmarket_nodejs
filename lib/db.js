import { Pool } from "@neondatabase/serverless";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS markets (
  slug            TEXT PRIMARY KEY,
  market_id       TEXT,
  condition_id    TEXT,
  question        TEXT,
  outcomes        TEXT,
  outcome_prices  TEXT,
  current_price   DOUBLE PRECISION,
  no_price        DOUBLE PRECISION,
  min_price       DOUBLE PRECISION,
  max_price       DOUBLE PRECISION,
  volume          DOUBLE PRECISION,
  liquidity       DOUBLE PRECISION,
  resolution_date TEXT,
  active          BOOLEAN,
  closed          BOOLEAN,
  yes_token_id    TEXT,
  tags            TEXT,
  event_id        TEXT,
  event_slug      TEXT,
  event_title     TEXT,
  last_updated    TEXT
);
-- These ALTER TABLEs must run before the CREATE INDEXes below — on a
-- database created before a column existed, CREATE TABLE IF NOT EXISTS is a
-- no-op, so an index on that column would otherwise fail with
-- "column ... does not exist".
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS no_price DOUBLE PRECISION;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS event_id TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS event_slug TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS event_title TEXT;
CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume);
CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution_date);
CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let pool;

/** Reused across warm invocations of the same function instance. */
export function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "No database connection string found. Set DATABASE_URL (or POSTGRES_URL) in your Vercel " +
          "project's environment variables — see README for how to provision a free Neon database."
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

let schemaReady = false;

/** Idempotent — cheap to call on every request; only actually runs once per warm instance. */
export async function ensureSchema(pool) {
  if (schemaReady) return;
  await pool.query(SCHEMA_SQL);
  schemaReady = true;
}

export async function upsertMarket(pool, m, { minPrice = null, maxPrice = null } = {}) {
  await pool.query(
    `
    INSERT INTO markets (slug, market_id, condition_id, question, outcomes, outcome_prices,
                          current_price, no_price, min_price, max_price, volume, liquidity,
                          resolution_date, active, closed, yes_token_id, tags,
                          event_id, event_slug, event_title, last_updated)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21)
    ON CONFLICT (slug) DO UPDATE SET
      market_id=EXCLUDED.market_id,
      condition_id=EXCLUDED.condition_id,
      question=EXCLUDED.question,
      outcomes=EXCLUDED.outcomes,
      outcome_prices=EXCLUDED.outcome_prices,
      current_price=EXCLUDED.current_price,
      no_price=EXCLUDED.no_price,
      min_price=COALESCE(EXCLUDED.min_price, markets.min_price),
      max_price=COALESCE(EXCLUDED.max_price, markets.max_price),
      volume=EXCLUDED.volume,
      liquidity=EXCLUDED.liquidity,
      resolution_date=EXCLUDED.resolution_date,
      active=EXCLUDED.active,
      closed=EXCLUDED.closed,
      yes_token_id=COALESCE(EXCLUDED.yes_token_id, markets.yes_token_id),
      tags=EXCLUDED.tags,
      event_id=EXCLUDED.event_id,
      event_slug=EXCLUDED.event_slug,
      event_title=EXCLUDED.event_title,
      last_updated=EXCLUDED.last_updated
    `,
    [
      m.slug,
      m.marketId ?? null,
      m.conditionId ?? null,
      m.question ?? null,
      JSON.stringify(m.outcomes ?? []),
      JSON.stringify(m.outcomePrices ?? []),
      m.currentPrice ?? null,
      m.noPrice ?? null,
      minPrice,
      maxPrice,
      m.volume ?? null,
      m.liquidity ?? null,
      m.resolutionDate ?? null,
      Boolean(m.active),
      Boolean(m.closed),
      m.yesTokenId ?? null,
      JSON.stringify(m.tags ?? []),
      m.eventId ?? null,
      m.eventSlug ?? null,
      m.eventTitle ?? null,
      new Date().toISOString(),
    ]
  );
}

const SORTABLE = new Set(["volume", "liquidity", "current_price", "resolution_date", "closed"]);

/** Shared WHERE-clause builder for queryMarkets/queryMarketsGrouped — keeps
 * the two filter sets from drifting apart. Postgres placeholders ($1, $2,
 * ...) start from `startIndex` so callers can append LIMIT/OFFSET after. */
function buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag }, startIndex = 1) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  if (search) {
    clauses.push(`(question ILIKE $${i} OR slug ILIKE $${i})`);
    params.push(`%${search}%`);
    i += 1;
  }
  if (status === "active") clauses.push("active = true");
  if (status === "closed") clauses.push("closed = true");
  if (minVolume) {
    clauses.push(`COALESCE(volume, 0) >= $${i}`);
    params.push(minVolume);
    i += 1;
  }
  if (minPrice != null) {
    clauses.push(`current_price >= $${i}`);
    params.push(minPrice);
    i += 1;
  }
  if (maxPrice != null) {
    clauses.push(`current_price <= $${i}`);
    params.push(maxPrice);
    i += 1;
  }
  if (tag) {
    clauses.push(`tags LIKE $${i}`);
    params.push(`%"${tag}"%`);
    i += 1;
  }
  return { clauses, params, nextIndex: i };
}

/** Returns { rows, total, page, pageSize } — `total` is the count matching
 * the filters across all pages, for the grid's pagination controls. */
export async function queryMarkets(
  pool,
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
  const { clauses, params, nextIndex } = buildMarketFilters({
    search,
    status,
    minVolume,
    minPrice,
    maxPrice,
    tag,
  });
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM markets ${where}`,
    params
  );
  const total = Number(countRows[0].count);

  const pageSizeSafe = Math.max(1, Math.min(500, pageSize));
  const pageSafe = Math.max(1, page);
  const offset = (pageSafe - 1) * pageSizeSafe;
  const { rows } = await pool.query(
    `SELECT * FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, pageSizeSafe, offset]
  );
  return { rows, total, page: pageSafe, pageSize: pageSizeSafe };
}

/** Same filters as queryMarkets, but groups the matching markets by their
 * Polymarket event (a standalone market with no event is its own
 * single-market group) and paginates over GROUPS rather than raw rows —
 * mirrors server/src/db.js's queryMarketsGrouped for the Vercel/Postgres
 * deploy target. Grouping happens in JS after fetching all matching rows:
 * simplest correct option at this app's scale. */
export async function queryMarketsGrouped(
  pool,
  { search, status, sortBy = "volume", minVolume = 0, minPrice, maxPrice, tag, page = 1, pageSize = 25 } = {}
) {
  const { clauses, params } = buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag });
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST`,
    params
  );

  const groupOrder = [];
  const groupsByKey = new Map();
  for (const row of rows) {
    const key = row.event_id || `standalone:${row.slug}`;
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        eventId: row.event_id,
        eventSlug: row.event_slug,
        eventTitle: row.event_title || row.question,
        markets: [],
      };
      groupsByKey.set(key, group);
      groupOrder.push(group);
    }
    group.markets.push(row);
  }

  const total = groupOrder.length;
  const pageSizeSafe = Math.max(1, Math.min(200, pageSize));
  const pageSafe = Math.max(1, page);
  const offset = (pageSafe - 1) * pageSizeSafe;
  const groups = groupOrder.slice(offset, offset + pageSizeSafe);

  return { groups, total, page: pageSafe, pageSize: pageSizeSafe };
}

/** Sibling markets under the same Polymarket event (e.g. other candidates in
 * the same election), for the detail panel's "related markets" list. */
export async function getMarketsByEvent(pool, eventId, excludeSlug) {
  const { rows } = await pool.query(
    `SELECT slug, question, current_price, no_price, volume
     FROM markets WHERE event_id = $1 AND slug <> $2
     ORDER BY volume DESC NULLS LAST`,
    [eventId, excludeSlug]
  );
  return rows;
}

/** Distinct tag labels across all stored markets, sorted, for the category filter dropdown. */
export async function getTags(pool) {
  const { rows } = await pool.query(
    "SELECT tags FROM markets WHERE tags IS NOT NULL AND tags <> '[]'"
  );
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

export async function getMarket(pool, slug) {
  const { rows } = await pool.query("SELECT * FROM markets WHERE slug = $1", [slug]);
  return rows[0] ?? null;
}

export async function getStats(pool) {
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS count, MAX(last_updated) AS last_updated FROM markets"
  );
  return rows[0];
}

export async function getAllForExport(pool) {
  const { rows } = await pool.query("SELECT * FROM markets ORDER BY volume DESC NULLS LAST");
  return rows;
}

/** Small generic key/value store — currently used to let the app's settings
 * window save the DeepSeek API key without an environment variable. */
export async function getSetting(pool, key) {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

export async function deleteSetting(pool, key) {
  await pool.query("DELETE FROM settings WHERE key = $1", [key]);
}
