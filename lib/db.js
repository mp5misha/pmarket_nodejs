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
-- Phase 3/4 parity for this deploy target: persisted AI analysis history and
-- follow-up threads. No user_id — this deploy predates accounts, same as
-- everything else here.
CREATE TABLE IF NOT EXISTS analyses (
  id                 SERIAL PRIMARY KEY,
  market_slug        TEXT NOT NULL,
  parent_analysis_id INTEGER REFERENCES analyses(id) ON DELETE SET NULL,
  prompt_text        TEXT NOT NULL,
  result_text        TEXT NOT NULL,
  model_name         TEXT NOT NULL,
  tokens_used        INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analyses_slug ON analyses(market_slug);
CREATE INDEX IF NOT EXISTS idx_analyses_parent ON analyses(parent_analysis_id);
-- Phase 2 parity: saved search configurations. schedule_minutes is stored
-- for round-tripping the UI's "auto re-run" field, but nothing executes it
-- on this deploy target — there's no background job runner in a serverless
-- deployment without a separately-configured Vercel Cron job, so a saved
-- schedule here is informational only until one is added.
CREATE TABLE IF NOT EXISTS saved_searches (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  tag             TEXT,
  resolution_from TEXT,
  resolution_to   TEXT,
  min_volume      DOUBLE PRECISION,
  min_liquidity   DOUBLE PRECISION,
  keyword         TEXT,
  schedule_minutes INTEGER,
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Phase 5/9 parity: manually-recorded trades. No bankroll ledger/auto-deduct
-- on this deploy target (Phase 7, still Express/SQLite only) — stake/max-
-- per-bet enforcement isn't applied here.
CREATE TABLE IF NOT EXISTS trades (
  id             SERIAL PRIMARY KEY,
  market_slug    TEXT NOT NULL,
  side           TEXT NOT NULL,
  entry_price    DOUBLE PRECISION NOT NULL,
  stake          DOUBLE PRECISION NOT NULL,
  placed_at      TIMESTAMPTZ NOT NULL,
  note           TEXT,
  estimated_prob DOUBLE PRECISION,
  status         TEXT NOT NULL DEFAULT 'open',
  resolved_at    TIMESTAMPTZ,
  payout         DOUBLE PRECISION,
  profit         DOUBLE PRECISION,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trades_slug ON trades(market_slug);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
-- Mirrors server/src/db.js's whale_positions (see its migration's comment
-- for why this is one denormalized table rather than a joined pair).
CREATE TABLE IF NOT EXISTS whale_positions (
  id                       SERIAL PRIMARY KEY,
  condition_id             TEXT,
  slug                     TEXT,
  event_slug               TEXT,
  title                    TEXT,
  outcome                  TEXT,
  size                     DOUBLE PRECISION,
  avg_price                DOUBLE PRECISION,
  cur_price                DOUBLE PRECISION,
  current_value            DOUBLE PRECISION,
  cash_pnl                 DOUBLE PRECISION,
  percent_pnl              DOUBLE PRECISION,
  trader_wallet            TEXT,
  trader_name              TEXT,
  trader_pnl               DOUBLE PRECISION,
  trader_volume            DOUBLE PRECISION,
  scan_trader_count        INTEGER NOT NULL,
  scan_failed_wallet_count INTEGER NOT NULL,
  fetched_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whale_positions_slug ON whale_positions(slug);
CREATE INDEX IF NOT EXISTS idx_whale_positions_fetched_at ON whale_positions(fetched_at);
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
function buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag, hasTrade, slugs }, startIndex = 1) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  if (search) {
    clauses.push(`(question ILIKE $${i} OR slug ILIKE $${i})`);
    params.push(`%${search}%`);
    i += 1;
  }
  // A market is treated as resolved once its resolution date has passed,
  // regardless of the stored `closed` flag — that flag only updates when
  // the market is actually re-synced, so it goes stale forever once a
  // market stops being returned by an "active only" sync (see
  // Sidebar.jsx's sync status default). Resolution date is the more
  // reliable signal since it doesn't depend on re-syncing at all.
  if (status === "active" || status === "closed") {
    const nowIso = new Date().toISOString();
    if (status === "active") {
      clauses.push(`(closed IS NOT TRUE) AND (resolution_date IS NULL OR resolution_date >= $${i})`);
    } else {
      clauses.push(`(closed IS TRUE OR (resolution_date IS NOT NULL AND resolution_date < $${i}))`);
    }
    params.push(nowIso);
    i += 1;
  }
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
  if (hasTrade) {
    // No accounts on this deploy target, so trades aren't user-scoped here —
    // unlike server/src/db.js's equivalent clause, this needs no bound param.
    clauses.push(`EXISTS (SELECT 1 FROM trades WHERE trades.market_slug = markets.slug)`);
  }
  if (slugs) {
    // `slugs` provided (even empty) means "restrict to exactly these" — an
    // empty list must produce zero matches, not silently skip the filter.
    if (slugs.length) {
      clauses.push(`markets.slug = ANY($${i})`);
      params.push(slugs);
      i += 1;
    } else {
      clauses.push("1 = 0");
    }
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
    `SELECT markets.*, ${LATEST_ANALYSIS_SELECT}
     FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, pageSizeSafe, offset]
  );
  return { rows, total, page: pageSafe, pageSize: pageSizeSafe };
}

/** Correlated subqueries pulling in each market's most recent analysis (an
 * original run or a follow-up, whichever is newer — a follow-up is just
 * another row in the same table) for the grid's "AI analysis results"
 * column. Cheap at this app's scale; see queryMarketsGrouped's own doc
 * comment on why grouping/paginating already happens over every matching
 * row rather than a LIMITed page. */
const LATEST_ANALYSIS_SELECT = `
  (SELECT result_text FROM analyses WHERE analyses.market_slug = markets.slug
     ORDER BY created_at DESC LIMIT 1) AS last_analysis_text,
  (SELECT created_at FROM analyses WHERE analyses.market_slug = markets.slug
     ORDER BY created_at DESC LIMIT 1) AS last_analysis_at
`;

/** Mirrors server/src/db.js's LATEST_TRADE_SELECT for the grid's "My trade
 * price"/"My trade date"/"My trade profit" columns and row highlighting —
 * no user scoping here since this deploy target has no accounts (every
 * trade is visible to every visitor, same as the rest of this backend). */
const LATEST_TRADE_SELECT = `
  (SELECT id FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_id,
  (SELECT side FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_side,
  (SELECT entry_price FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_entry_price,
  (SELECT stake FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_stake,
  (SELECT placed_at FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_placed_at,
  (SELECT status FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_status,
  (SELECT profit FROM trades WHERE trades.market_slug = markets.slug
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_profit
`;

/** Same filters as queryMarkets, but groups the matching markets by their
 * Polymarket event (a standalone market with no event is its own
 * single-market group) and paginates over GROUPS rather than raw rows —
 * mirrors server/src/db.js's queryMarketsGrouped for the Vercel/Postgres
 * deploy target. Grouping happens in JS after fetching all matching rows:
 * simplest correct option at this app's scale. */
export async function queryMarketsGrouped(
  pool,
  {
    search,
    status,
    sortBy = "volume",
    minVolume = 0,
    minPrice,
    maxPrice,
    tag,
    hasTrade,
    // See server/src/db.js's queryMarketsGrouped for what these do — same
    // plain-data whale-slugs-in, is_whale_market-annotated-out contract.
    whaleSlugs,
    onlyWhaleMarkets,
    page = 1,
    pageSize = 25,
  } = {}
) {
  const { clauses, params } = buildMarketFilters({
    search,
    status,
    minVolume,
    minPrice,
    maxPrice,
    tag,
    hasTrade,
    slugs: onlyWhaleMarkets ? whaleSlugs ?? [] : undefined,
  });
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT markets.*, ${LATEST_ANALYSIS_SELECT}, ${LATEST_TRADE_SELECT}
     FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST`,
    params
  );

  if (whaleSlugs) {
    const whaleSet = new Set(whaleSlugs);
    for (const row of rows) row.is_whale_market = whaleSet.has(row.slug);
  }

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

/** Bulk-deletes markets from the catalog by slug (e.g. clearing out
 * resolved markets you no longer want cluttering the grid) — doesn't touch
 * any trades recorded against those slugs, which keep their own history. */
export async function deleteMarkets(pool, slugs) {
  const { rowCount } = await pool.query("DELETE FROM markets WHERE slug = ANY($1)", [slugs]);
  return rowCount;
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

const SYNC_CURSOR_SETTING = "sync_cursors";

/** Where a catalog sync left off for a given filter combination (see
 * lib/polymarket.js's syncFilterSignature) — lets a fresh "Run sync"/"Fetch
 * now" continue into markets it hasn't seen yet instead of re-fetching the
 * same top-of-list results every time (Gamma's ranking is fairly stable
 * run to run for a given sort order). Stored as one JSON blob mapping
 * signature -> offset rather than one settings row per signature, since
 * there are only ever a handful of distinct filter combos in practice. */
export async function getSyncCursor(pool, signature) {
  const raw = await getSetting(pool, SYNC_CURSOR_SETTING);
  if (!raw) return 0;
  try {
    return JSON.parse(raw)[signature] ?? 0;
  } catch {
    return 0;
  }
}

export async function setSyncCursor(pool, signature, offset) {
  const raw = await getSetting(pool, SYNC_CURSOR_SETTING);
  let cursors = {};
  if (raw) {
    try {
      cursors = JSON.parse(raw);
    } catch {
      cursors = {};
    }
  }
  if (offset > 0) cursors[signature] = offset;
  else delete cursors[signature];
  await setSetting(pool, SYNC_CURSOR_SETTING, JSON.stringify(cursors));
}

export async function deleteSetting(pool, key) {
  await pool.query("DELETE FROM settings WHERE key = $1", [key]);
}

// AI analysis history + follow-up threads (Phase 3/4 parity).
export async function createAnalysis(
  pool,
  { marketSlug, parentAnalysisId = null, promptText, resultText, modelName, tokensUsed = null }
) {
  const { rows } = await pool.query(
    `INSERT INTO analyses (market_slug, parent_analysis_id, prompt_text, result_text, model_name, tokens_used)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [marketSlug, parentAnalysisId, promptText, resultText, modelName, tokensUsed]
  );
  return rows[0];
}

export async function getAnalysis(pool, id) {
  const { rows } = await pool.query("SELECT * FROM analyses WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listAnalysesForMarket(pool, marketSlug) {
  const { rows } = await pool.query(
    "SELECT * FROM analyses WHERE market_slug = $1 ORDER BY created_at DESC",
    [marketSlug]
  );
  return rows;
}

// Walks an analysis's parent_analysis_id chain from the root down to `id`
// itself (inclusive) — reconstructs a follow-up thread for rebuilding
// multi-turn DeepSeek context. Mirrors server/src/db.js's getAnalysisThread.
export async function getAnalysisThread(pool, id) {
  const root = await getAnalysis(pool, id);
  if (!root) return [];
  const chain = [];
  let current = root;
  while (current) {
    chain.unshift(current);
    current = current.parent_analysis_id ? await getAnalysis(pool, current.parent_analysis_id) : null;
  }
  return chain;
}

// Saved search configurations (Phase 2 parity). No scheduled execution on
// this deploy target — see the schema comment on saved_searches.
export async function listSavedSearches(pool) {
  const { rows } = await pool.query("SELECT * FROM saved_searches ORDER BY created_at DESC");
  return rows;
}

export async function getSavedSearch(pool, id) {
  const { rows } = await pool.query("SELECT * FROM saved_searches WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function createSavedSearch(pool, params) {
  const { rows } = await pool.query(
    `INSERT INTO saved_searches
       (name, status, tag, resolution_from, resolution_to, min_volume, min_liquidity, keyword, schedule_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      params.name,
      params.status || "active",
      params.tag || null,
      params.resolutionFrom || null,
      params.resolutionTo || null,
      params.minVolume ?? null,
      params.minLiquidity ?? null,
      params.keyword || null,
      params.scheduleMinutes ?? null,
    ]
  );
  return rows[0];
}

export async function updateSavedSearch(pool, id, params) {
  const { rows } = await pool.query(
    `UPDATE saved_searches SET
       name = $1, status = $2, tag = $3, resolution_from = $4, resolution_to = $5,
       min_volume = $6, min_liquidity = $7, keyword = $8, schedule_minutes = $9, updated_at = now()
     WHERE id = $10 RETURNING *`,
    [
      params.name,
      params.status || "active",
      params.tag || null,
      params.resolutionFrom || null,
      params.resolutionTo || null,
      params.minVolume ?? null,
      params.minLiquidity ?? null,
      params.keyword || null,
      params.scheduleMinutes ?? null,
      id,
    ]
  );
  return rows[0] ?? null;
}

export async function deleteSavedSearch(pool, id) {
  await pool.query("DELETE FROM saved_searches WHERE id = $1", [id]);
}

// Manually-recorded trades (Phase 5/9 parity).
export async function createTrade(
  pool,
  { marketSlug, side, entryPrice, stake, placedAt, note = null, estimatedProb = null }
) {
  const { rows } = await pool.query(
    `INSERT INTO trades (market_slug, side, entry_price, stake, placed_at, note, estimated_prob, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open') RETURNING *`,
    [marketSlug, side, entryPrice, stake, placedAt || new Date().toISOString(), note, estimatedProb]
  );
  return rows[0];
}

export async function getTrade(pool, id) {
  const { rows } = await pool.query("SELECT * FROM trades WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listTrades(pool, { status, marketSlug } = {}) {
  const clauses = [];
  const params = [];
  let i = 1;
  if (status) {
    clauses.push(`status = $${i}`);
    params.push(status);
    i += 1;
  }
  if (marketSlug) {
    clauses.push(`market_slug = $${i}`);
    params.push(marketSlug);
    i += 1;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT * FROM trades ${where} ORDER BY placed_at DESC`, params);
  return rows;
}

export async function listOpenTradeSlugs(pool) {
  const { rows } = await pool.query("SELECT DISTINCT market_slug FROM trades WHERE status = 'open'");
  return rows.map((r) => r.market_slug);
}

export async function deleteTrade(pool, id) {
  await pool.query("DELETE FROM trades WHERE id = $1", [id]);
}

export async function resolveTrade(pool, id, { status, payout, profit }) {
  const { rows } = await pool.query(
    `UPDATE trades SET status = $1, payout = $2, profit = $3, resolved_at = now(), updated_at = now()
     WHERE id = $4 RETURNING *`,
    [status, payout, profit, id]
  );
  return rows[0];
}

/** Aggregate profitability metrics + chart data over every resolved trade —
 * mirrors server/src/db.js's getProfitabilityAnalytics. */
export async function getProfitabilityAnalytics(pool) {
  const { rows: resolved } = await pool.query(
    `SELECT t.*, m.tags AS market_tags
     FROM trades t LEFT JOIN markets m ON m.slug = t.market_slug
     WHERE t.status IN ('won', 'lost')
     ORDER BY t.resolved_at ASC`
  );

  const totalStaked = resolved.reduce((sum, t) => sum + Number(t.stake), 0);
  const totalProfit = resolved.reduce((sum, t) => sum + Number(t.profit ?? 0), 0);
  const wonCount = resolved.filter((t) => t.status === "won").length;

  const withEstimate = resolved.filter((t) => t.estimated_prob != null);
  const avgEdge = withEstimate.length
    ? withEstimate.reduce((sum, t) => sum + (Number(t.estimated_prob) - Number(t.entry_price)), 0) /
      withEstimate.length
    : null;
  const brierScore = withEstimate.length
    ? withEstimate.reduce((sum, t) => {
        const outcome = t.status === "won" ? 1 : 0;
        return sum + (Number(t.estimated_prob) - outcome) ** 2;
      }, 0) / withEstimate.length
    : null;

  let cumulative = 0;
  const pnlOverTime = resolved.map((t) => {
    cumulative += Number(t.profit ?? 0);
    return { date: t.resolved_at, cumulativeProfit: cumulative };
  });

  const byCategory = new Map();
  for (const t of resolved) {
    let category = "Uncategorized";
    try {
      const tags = JSON.parse(t.market_tags || "[]");
      if (tags.length) category = tags[0];
    } catch {
      // keep "Uncategorized"
    }
    byCategory.set(category, (byCategory.get(category) || 0) + Number(t.profit ?? 0));
  }
  const pnlByCategory = [...byCategory.entries()]
    .map(([category, profit]) => ({ category, profit }))
    .sort((a, b) => b.profit - a.profit);

  const buckets = Array.from({ length: 10 }, () => ({ estimates: [], wins: 0, count: 0 }));
  for (const t of withEstimate) {
    const idx = Math.min(9, Math.max(0, Math.floor(Number(t.estimated_prob) * 10)));
    buckets[idx].estimates.push(Number(t.estimated_prob));
    buckets[idx].count += 1;
    if (t.status === "won") buckets[idx].wins += 1;
  }
  const calibration = buckets
    .map((b, i) => ({
      bucket: `${i * 10}-${(i + 1) * 10}%`,
      predicted: b.count ? b.estimates.reduce((sum, e) => sum + e, 0) / b.count : null,
      actual: b.count ? b.wins / b.count : null,
      count: b.count,
    }))
    .filter((b) => b.count > 0);

  return {
    totalTrades: resolved.length,
    totalStaked,
    totalProfit,
    winRate: resolved.length ? wonCount / resolved.length : null,
    roi: totalStaked ? totalProfit / totalStaked : null,
    avgEdge,
    brierScore,
    withEstimateCount: withEstimate.length,
    pnlOverTime,
    pnlByCategory,
    calibration,
  };
}

// Whale positions (top-50 leaderboard traders' current holdings) — mirrors
// server/src/db.js's replaceWhalePositions/getStoredWhalePositions. No
// pool-level transaction helper is used here, consistent with the rest of
// this file's writes (a brief window between the DELETE and INSERT below
// isn't a concern for this best-effort, externally-sourced cache data).
export async function replaceWhalePositions(pool, { positions, traderCount, failedWalletCount, fetchedAt }) {
  await pool.query("DELETE FROM whale_positions");
  if (!positions.length) return;

  const cols = 18;
  const valuesSql = positions.map((_, i) => {
    const base = i * cols;
    const placeholders = Array.from({ length: cols }, (_, j) => `$${base + j + 1}`);
    return `(${placeholders.join(", ")})`;
  });
  const params = positions.flatMap((p) => [
    p.conditionId ?? null,
    p.slug ?? null,
    p.eventSlug ?? null,
    p.title ?? null,
    p.outcome ?? null,
    p.size ?? null,
    p.avgPrice ?? null,
    p.curPrice ?? null,
    p.currentValue ?? null,
    p.cashPnl ?? null,
    p.percentPnl ?? null,
    p.traderWallet ?? null,
    p.traderName ?? null,
    p.traderPnl ?? null,
    p.traderVolume ?? null,
    traderCount,
    failedWalletCount,
    fetchedAt,
  ]);
  await pool.query(
    `INSERT INTO whale_positions (
      condition_id, slug, event_slug, title, outcome, size, avg_price, cur_price,
      current_value, cash_pnl, percent_pnl, trader_wallet, trader_name, trader_pnl, trader_volume,
      scan_trader_count, scan_failed_wallet_count, fetched_at
    ) VALUES ${valuesSql.join(", ")}`,
    params
  );
}

/** The last successfully-persisted whale-positions snapshot, or null if
 * none has ever been stored. */
export async function getStoredWhalePositions(pool) {
  const { rows } = await pool.query("SELECT * FROM whale_positions ORDER BY current_value DESC NULLS LAST");
  if (!rows.length) return null;
  return {
    positions: rows.map((r) => ({
      conditionId: r.condition_id,
      slug: r.slug,
      eventSlug: r.event_slug,
      title: r.title,
      outcome: r.outcome,
      size: r.size,
      avgPrice: r.avg_price,
      curPrice: r.cur_price,
      currentValue: r.current_value,
      cashPnl: r.cash_pnl,
      percentPnl: r.percent_pnl,
      traderWallet: r.trader_wallet,
      traderName: r.trader_name,
      traderPnl: r.trader_pnl,
      traderVolume: r.trader_volume,
    })),
    traderCount: rows[0].scan_trader_count,
    failedWalletCount: rows[0].scan_failed_wallet_count,
    fetchedAt: rows[0].fetched_at,
  };
}
