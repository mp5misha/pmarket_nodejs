import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.join(__dirname, "..", "polymarket.db");

let dbInstance = null;
let dbInstancePath = null;

/** Returns a cached connection for dbPath, running any pending migrations
 * (see server/migrations/) on first use. */
export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (dbInstance && dbInstancePath === dbPath) return dbInstance;
  if (dbInstance) dbInstance.close();
  dbInstance = new Database(dbPath);
  runMigrations(dbInstance);
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

const SORTABLE = new Set(["volume", "liquidity", "current_price", "resolution_date", "closed"]);

/** Shared WHERE-clause builder for queryMarkets/queryMarketsGrouped — keeps
 * the two filter sets from drifting apart. */
function buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag }) {
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
  return { clauses, params };
}

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
  const { clauses, params } = buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag });
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

/** Same filters as queryMarkets, but groups the matching markets by their
 * Polymarket event (a standalone market with no event is its own
 * single-market group) and paginates over GROUPS rather than raw rows —
 * powers the Phase 1 grid's "event row containing its markets" layout.
 * Grouping happens in JS after fetching all matching rows: simplest correct
 * option at this app's scale (a personal tracker, not a high-volume system),
 * and it keeps a group's sort position tied to its best-ranked market. */
export function queryMarketsGrouped(
  db,
  { search, status, sortBy = "volume", minVolume = 0, minPrice, maxPrice, tag, page = 1, pageSize = 25 } = {}
) {
  const { clauses, params } = buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag });
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST`)
    .all(params);

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

/** Named, re-runnable Market Discovery filter configurations (Phase 2). */
export function listSavedSearches(db) {
  return db.prepare("SELECT * FROM saved_searches ORDER BY created_at DESC").all();
}

export function getSavedSearch(db, id) {
  return db.prepare("SELECT * FROM saved_searches WHERE id = ?").get(id);
}

export function createSavedSearch(db, params) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO saved_searches
         (name, status, tag, resolution_from, resolution_to, min_volume, min_liquidity, keyword, schedule_minutes, created_at, updated_at)
       VALUES (@name, @status, @tag, @resolutionFrom, @resolutionTo, @minVolume, @minLiquidity, @keyword, @scheduleMinutes, @now, @now)`
    )
    .run({
      name: params.name,
      status: params.status || "active",
      tag: params.tag || null,
      resolutionFrom: params.resolutionFrom || null,
      resolutionTo: params.resolutionTo || null,
      minVolume: params.minVolume ?? null,
      minLiquidity: params.minLiquidity ?? null,
      keyword: params.keyword || null,
      scheduleMinutes: params.scheduleMinutes ?? null,
      now,
    });
  return getSavedSearch(db, result.lastInsertRowid);
}

export function updateSavedSearch(db, id, params) {
  db.prepare(
    `UPDATE saved_searches SET
       name = @name, status = @status, tag = @tag,
       resolution_from = @resolutionFrom, resolution_to = @resolutionTo,
       min_volume = @minVolume, min_liquidity = @minLiquidity, keyword = @keyword,
       schedule_minutes = @scheduleMinutes,
       updated_at = @now
     WHERE id = @id`
  ).run({
    id,
    name: params.name,
    status: params.status || "active",
    tag: params.tag || null,
    resolutionFrom: params.resolutionFrom || null,
    resolutionTo: params.resolutionTo || null,
    minVolume: params.minVolume ?? null,
    minLiquidity: params.minLiquidity ?? null,
    keyword: params.keyword || null,
    scheduleMinutes: params.scheduleMinutes ?? null,
    now: new Date().toISOString(),
  });
  return getSavedSearch(db, id);
}

export function deleteSavedSearch(db, id) {
  db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
}

// Saved searches whose schedule_minutes has elapsed since last_run_at (or
// that have never run) — polled by the in-process scheduler in index.js.
export function listDueSavedSearches(db) {
  return db
    .prepare(
      `SELECT * FROM saved_searches
       WHERE schedule_minutes IS NOT NULL AND schedule_minutes > 0
         AND (last_run_at IS NULL OR datetime(last_run_at, '+' || schedule_minutes || ' minutes') <= datetime('now'))`
    )
    .all();
}

export function markSavedSearchRun(db, id) {
  db.prepare("UPDATE saved_searches SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

// AI analysis history (Phase 3) — every DeepSeek call persisted as its own
// row, keyed for cache/dedup lookups by a hash of exactly what would be
// sent (market + prompt + model + reasoning effort).
export function computeInputHash({ marketSlug, promptText, modelName, reasoningEffort }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ marketSlug, promptText, modelName, reasoningEffort }))
    .digest("hex");
}

export function findCachedAnalysis(db, inputHash) {
  return db
    .prepare(
      "SELECT * FROM ai_analysis WHERE input_hash = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
    )
    .get(inputHash);
}

export function createAnalysis(
  db,
  {
    marketSlug,
    promptTemplateId = null,
    promptText,
    inputHash,
    modelName,
    reasoningEffort = null,
    resultText = null,
    promptTokens = null,
    completionTokens = null,
    tokensUsed = null,
    costEstimate = null,
    status = "completed",
    error = null,
  }
) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO ai_analysis
         (market_slug, prompt_template_id, prompt_text, input_hash, model_name, reasoning_effort,
          result_text, prompt_tokens, completion_tokens, tokens_used, cost_estimate, status, error, created_at)
       VALUES (@marketSlug, @promptTemplateId, @promptText, @inputHash, @modelName, @reasoningEffort,
               @resultText, @promptTokens, @completionTokens, @tokensUsed, @costEstimate, @status, @error, @now)`
    )
    .run({
      marketSlug,
      promptTemplateId,
      promptText,
      inputHash,
      modelName,
      reasoningEffort,
      resultText,
      promptTokens,
      completionTokens,
      tokensUsed,
      costEstimate,
      status,
      error,
      now,
    });
  return getAnalysis(db, result.lastInsertRowid);
}

export function getAnalysis(db, id) {
  return db.prepare("SELECT * FROM ai_analysis WHERE id = ?").get(id);
}

export function listAnalysesForMarket(db, marketSlug) {
  return db
    .prepare("SELECT * FROM ai_analysis WHERE market_slug = ? ORDER BY created_at DESC")
    .all(marketSlug);
}

/** Audit trail of catalog fetches (ad hoc or from a saved search), Phase 2. */
export function createFetchRun(db, { savedSearchId = null, filters }) {
  const result = db
    .prepare(
      `INSERT INTO fetch_runs (saved_search_id, filters_json, started_at, status)
       VALUES (?, ?, ?, 'running')`
    )
    .run(savedSearchId, JSON.stringify(filters ?? {}), new Date().toISOString());
  return result.lastInsertRowid;
}

export function completeFetchRun(db, id, { marketsAdded = 0, marketsUpdated = 0, status = "completed", error = null }) {
  db.prepare(
    `UPDATE fetch_runs SET finished_at = ?, markets_added = ?, markets_updated = ?, status = ?, error = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), marketsAdded, marketsUpdated, status, error, id);
}

export function listFetchRuns(db, { savedSearchId, limit = 50 } = {}) {
  if (savedSearchId != null) {
    return db
      .prepare("SELECT * FROM fetch_runs WHERE saved_search_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(savedSearchId, limit);
  }
  return db.prepare("SELECT * FROM fetch_runs ORDER BY started_at DESC LIMIT ?").all(limit);
}
