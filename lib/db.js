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
  min_price       DOUBLE PRECISION,
  max_price       DOUBLE PRECISION,
  volume          DOUBLE PRECISION,
  liquidity       DOUBLE PRECISION,
  resolution_date TEXT,
  active          BOOLEAN,
  closed          BOOLEAN,
  yes_token_id    TEXT,
  last_updated    TEXT
);
CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume);
CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution_date);
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
                          current_price, min_price, max_price, volume, liquidity,
                          resolution_date, active, closed, yes_token_id, last_updated)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (slug) DO UPDATE SET
      market_id=EXCLUDED.market_id,
      condition_id=EXCLUDED.condition_id,
      question=EXCLUDED.question,
      outcomes=EXCLUDED.outcomes,
      outcome_prices=EXCLUDED.outcome_prices,
      current_price=EXCLUDED.current_price,
      min_price=COALESCE(EXCLUDED.min_price, markets.min_price),
      max_price=COALESCE(EXCLUDED.max_price, markets.max_price),
      volume=EXCLUDED.volume,
      liquidity=EXCLUDED.liquidity,
      resolution_date=EXCLUDED.resolution_date,
      active=EXCLUDED.active,
      closed=EXCLUDED.closed,
      yes_token_id=COALESCE(EXCLUDED.yes_token_id, markets.yes_token_id),
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
      minPrice,
      maxPrice,
      m.volume ?? null,
      m.liquidity ?? null,
      m.resolutionDate ?? null,
      Boolean(m.active),
      Boolean(m.closed),
      m.yesTokenId ?? null,
      new Date().toISOString(),
    ]
  );
}

const SORTABLE = new Set(["volume", "liquidity", "current_price", "resolution_date"]);

export async function queryMarkets(pool, { search, status, sortBy = "volume", minVolume = 0 } = {}) {
  const clauses = [];
  const params = [];
  let i = 1;
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
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST`,
    params
  );
  return rows;
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
