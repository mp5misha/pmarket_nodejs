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

/** market is the normalized shape from polymarket.js (normalizeMarket).
 * The markets catalog is shared across every account (it mirrors
 * Polymarket's own public data), so unlike everything below it carries no
 * user_id. */
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
 * the two filter sets from drifting apart. `hasTrade`'s clause references
 * @userId, which every caller already binds (for LATEST_TRADE_SELECT), so
 * it doesn't need to appear in this function's own params. `slugs` is a
 * generic "restrict to exactly these slugs" filter — queryMarketsGrouped
 * uses it for the "Whales trades" grid filter, passing the currently
 * whale-held slugs fetched from whales.js (not a DB-native concept, so it
 * arrives here as plain data rather than a subquery like hasTrade's). */
function buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag, hasTrade, slugs }) {
  const clauses = [];
  const params = {};
  if (search) {
    clauses.push("(question LIKE @search OR slug LIKE @search)");
    params.search = `%${search}%`;
  }
  // A market is treated as resolved once its resolution date has passed,
  // regardless of the stored `closed` flag — that flag only updates when
  // the market is actually re-synced, so it goes stale forever once a
  // market stops being returned by an "active only" sync (see
  // Sidebar.jsx's sync status default). Resolution date is the more
  // reliable signal since it doesn't depend on re-syncing at all.
  if (status === "active") {
    clauses.push("(IFNULL(closed, 0) = 0) AND (resolution_date IS NULL OR resolution_date >= @statusNow)");
    params.statusNow = new Date().toISOString();
  } else if (status === "closed") {
    clauses.push("(closed = 1 OR (resolution_date IS NOT NULL AND resolution_date < @statusNow))");
    params.statusNow = new Date().toISOString();
  }
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
  if (hasTrade) {
    clauses.push("EXISTS (SELECT 1 FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId)");
  }
  if (slugs) {
    // `slugs` provided (even empty) means "restrict to exactly these" — an
    // empty list must produce zero matches, not silently skip the filter.
    if (slugs.length) {
      const names = slugs.map((_, idx) => `@slug${idx}`);
      clauses.push(`markets.slug IN (${names.join(", ")})`);
      slugs.forEach((s, idx) => {
        params[`slug${idx}`] = s;
      });
    } else {
      clauses.push("0 = 1");
    }
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
    userId,
  } = {}
) {
  const { clauses, params } = buildMarketFilters({ search, status, minVolume, minPrice, maxPrice, tag });
  const sortCol = SORTABLE.has(sortBy) ? sortBy : "volume";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS count FROM markets ${where}`).get(params).count;

  const pageSizeSafe = Math.max(1, Math.min(500, pageSize));
  const pageSafe = Math.max(1, page);
  const offset = (pageSafe - 1) * pageSizeSafe;
  const sql = `SELECT markets.*, ${LATEST_ANALYSIS_SELECT}
               FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST LIMIT @pageSize OFFSET @offset`;
  const rows = db.prepare(sql).all({ ...params, pageSize: pageSizeSafe, offset, userId });

  return { rows, total, page: pageSafe, pageSize: pageSizeSafe };
}

/** Correlated subqueries pulling in each market's most recent analysis (an
 * original run or a follow-up, whichever is newer — a follow-up is just
 * another row in the same table) for the grid's "AI analysis results"
 * column. `ai_analysis` is scoped by user_id (unlike `markets`, shared
 * across accounts), so this needs the caller's userId bound as @userId. */
const LATEST_ANALYSIS_SELECT = `
  (SELECT result_text FROM ai_analysis WHERE ai_analysis.market_slug = markets.slug AND ai_analysis.user_id = @userId
     ORDER BY created_at DESC LIMIT 1) AS last_analysis_text,
  (SELECT created_at FROM ai_analysis WHERE ai_analysis.market_slug = markets.slug AND ai_analysis.user_id = @userId
     ORDER BY created_at DESC LIMIT 1) AS last_analysis_at
`;

/** Same correlated-subquery approach as LATEST_ANALYSIS_SELECT, but for this
 * user's own most recent trade (by placed_at) on each market — powers the
 * grid's "My trade price"/"My trade date"/"My trade profit" columns and its
 * row highlighting. `trades` is scoped by user_id, so needs @userId bound
 * same as above. Profit/highlighting for an *open* trade is computed
 * client-side from the live current_price/no_price already in the row
 * (my_trade_profit here is only the stored, resolution-time figure). */
const LATEST_TRADE_SELECT = `
  (SELECT id FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_id,
  (SELECT side FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_side,
  (SELECT entry_price FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_entry_price,
  (SELECT stake FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_stake,
  (SELECT placed_at FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_placed_at,
  (SELECT status FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_status,
  (SELECT profit FROM trades WHERE trades.market_slug = markets.slug AND trades.user_id = @userId
     ORDER BY placed_at DESC, id DESC LIMIT 1) AS my_trade_profit
`;

/** Same filters as queryMarkets, but groups the matching markets by their
 * Polymarket event (a standalone market with no event is its own
 * single-market group) and paginates over GROUPS rather than raw rows —
 * powers the Phase 1 grid's "event row containing its markets" layout.
 * Grouping happens in JS after fetching all matching rows: simplest correct
 * option at this app's scale (a personal tracker, not a high-volume system),
 * and it keeps a group's sort position tied to its best-ranked market. */
export function queryMarketsGrouped(
  db,
  {
    search,
    status,
    sortBy = "volume",
    minVolume = 0,
    minPrice,
    maxPrice,
    tag,
    hasTrade,
    // Slugs any top-50 leaderboard trader currently holds (from
    // whales.js's getWhaleSlugSet — this function has no knowledge of the
    // external whale API itself, just plain data). Always used to annotate
    // each row's is_whale_market for the grid's purple highlight; only used
    // as a WHERE filter when onlyWhaleMarkets is also set (the "Whales
    // trades" checkbox).
    whaleSlugs,
    onlyWhaleMarkets,
    page = 1,
    pageSize = 25,
    userId,
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
  const rows = db
    .prepare(
      `SELECT markets.*, ${LATEST_ANALYSIS_SELECT}, ${LATEST_TRADE_SELECT}
       FROM markets ${where} ORDER BY ${sortCol} DESC NULLS LAST`
    )
    .all({ ...params, userId });

  if (whaleSlugs) {
    const whaleSet = new Set(whaleSlugs);
    for (const row of rows) row.is_whale_market = whaleSet.has(row.slug) ? 1 : 0;
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

/** Bulk-deletes markets from the local catalog by slug (e.g. clearing out
 * resolved markets you no longer want cluttering the grid) — doesn't touch
 * any trades recorded against those slugs, which keep their own history. */
export function deleteMarkets(db, slugs) {
  const del = db.transaction((values) => {
    const stmt = db.prepare("DELETE FROM markets WHERE slug = ?");
    let count = 0;
    for (const slug of values) count += stmt.run(slug).changes;
    return count;
  });
  return del(slugs);
}

export function getStats(db) {
  return db
    .prepare("SELECT COUNT(*) as count, MAX(last_updated) as lastUpdated FROM markets")
    .get();
}

export function getAllForExport(db) {
  return db.prepare("SELECT * FROM markets ORDER BY volume DESC NULLS LAST").all();
}

// ---------------------------------------------------------------------------
// Auth (Phase 8) — users, sessions, and the various single-use tokens/codes.
// ---------------------------------------------------------------------------

export function createUser(db, { email, passwordHash }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO users (email, password_hash, email_verified, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`
    )
    .run(email.toLowerCase(), passwordHash, now, now);
  return getUserById(db, result.lastInsertRowid);
}

export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
}

export function markEmailVerified(db, userId) {
  db.prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    userId
  );
}

export function updateUserPassword(db, userId, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
    passwordHash,
    new Date().toISOString(),
    userId
  );
}

export function createSession(db, { userId, tokenHash, expiresAt }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tokenHash, userId, expiresAt, now, now);
}

/** Returns the session row joined with its user, or undefined if the token
 * doesn't exist or has expired (expired rows are lazily swept here). */
export function getSessionByTokenHash(db, tokenHash) {
  const row = db
    .prepare(
      `SELECT sessions.*, users.email, users.email_verified
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?`
    )
    .get(tokenHash);
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return undefined;
  }
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
    new Date().toISOString(),
    tokenHash
  );
  return row;
}

export function deleteSession(db, tokenHash) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteAllSessionsForUser(db, userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function createEmailVerificationToken(db, { userId, tokenHash, expiresAt }) {
  db.prepare(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(userId, tokenHash, expiresAt, new Date().toISOString());
}

/** Consumes a verification token if valid (unused, unexpired) — returns the
 * owning user_id, or null. Single-use: marks it used_at in the same call. */
export function consumeEmailVerificationToken(db, tokenHash) {
  const row = db
    .prepare(
      "SELECT * FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL"
    )
    .get(tokenHash);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  db.prepare("UPDATE email_verification_tokens SET used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );
  return row.user_id;
}

export function createPasswordResetToken(db, { userId, tokenHash, expiresAt }) {
  db.prepare(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(userId, tokenHash, expiresAt, new Date().toISOString());
}

export function consumePasswordResetToken(db, tokenHash) {
  const row = db
    .prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL")
    .get(tokenHash);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );
  return row.user_id;
}

export function createTwoFactorCode(db, { userId, codeHash, pendingTokenHash, expiresAt }) {
  db.prepare(
    `INSERT INTO two_factor_codes (user_id, code_hash, pending_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, codeHash, pendingTokenHash, expiresAt, new Date().toISOString());
}

export function getActiveTwoFactorCode(db, pendingTokenHash) {
  return db
    .prepare(
      "SELECT * FROM two_factor_codes WHERE pending_token_hash = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1"
    )
    .get(pendingTokenHash);
}

export function incrementTwoFactorAttempts(db, id) {
  db.prepare("UPDATE two_factor_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
}

export function markTwoFactorCodeUsed(db, id) {
  db.prepare("UPDATE two_factor_codes SET used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function createRememberedDevice(db, { userId, tokenHash, expiresAt }) {
  db.prepare(
    `INSERT INTO remembered_devices (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(userId, tokenHash, expiresAt, new Date().toISOString());
}

/** Returns the owning user_id if this device token is a still-valid
 * "remember this device" grant, else null — used to skip the 2FA prompt. */
export function checkRememberedDevice(db, tokenHash) {
  const row = db
    .prepare("SELECT * FROM remembered_devices WHERE token_hash = ?")
    .get(tokenHash);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.user_id;
}

/** Reassigns every row currently owned by the placeholder legacy account
 * (see migration 008) to `newUserId` — the migration path a real user takes
 * to inherit this app's pre-auth single-tenant data. No-op (returns false)
 * if there's no legacy account, e.g. a fresh install that never had any
 * pre-existing data. */
export function claimLegacyData(db, newUserId) {
  const legacy = getUserByEmail(db, "legacy@local.invalid");
  if (!legacy || legacy.id === newUserId) return false;

  const ownedTables = ["saved_searches", "fetch_runs", "ai_analysis", "prompt_templates", "trades", "bankroll_ledger"];
  const claim = db.transaction(() => {
    for (const table of ownedTables) {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(newUserId, legacy.id);
    }
    for (const row of db.prepare("SELECT key, value FROM user_settings WHERE user_id = ?").all(legacy.id)) {
      db.prepare(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
      ).run(newUserId, row.key, row.value);
    }
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(legacy.id);
  });
  claim();
  return true;
}

// ---------------------------------------------------------------------------
// Per-user settings (replaces the old global `settings` key/value store).
// ---------------------------------------------------------------------------

export function getSetting(db, userId, key) {
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(userId, key);
  return row ? row.value : null;
}

export function setSetting(db, userId, key, value) {
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
  ).run(userId, key, value);
}

export function deleteSetting(db, userId, key) {
  db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?").run(userId, key);
}

const SYNC_CURSOR_SETTING = "sync_cursors";

/** Where a catalog sync left off for a given filter combination (see
 * server/src/polymarket.js's syncFilterSignature) — lets a fresh "Run
 * sync"/"Fetch now" continue into markets it hasn't seen yet instead of
 * re-fetching the same top-of-list results every time (Gamma's ranking is
 * fairly stable run to run for a given sort order). Stored as one JSON blob
 * mapping signature -> offset rather than one settings row per signature,
 * since there are only ever a handful of distinct filter combos in
 * practice; per-user like every other setting here, even though the
 * underlying markets catalog itself is shared. */
export function getSyncCursor(db, userId, signature) {
  const raw = getSetting(db, userId, SYNC_CURSOR_SETTING);
  if (!raw) return 0;
  try {
    return JSON.parse(raw)[signature] ?? 0;
  } catch {
    return 0;
  }
}

export function setSyncCursor(db, userId, signature, offset) {
  const raw = getSetting(db, userId, SYNC_CURSOR_SETTING);
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
  setSetting(db, userId, SYNC_CURSOR_SETTING, JSON.stringify(cursors));
}

/** Named, re-runnable Market Discovery filter configurations (Phase 2). */
export function listSavedSearches(db, userId) {
  return db.prepare("SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC").all(userId);
}

export function getSavedSearch(db, userId, id) {
  return db.prepare("SELECT * FROM saved_searches WHERE id = ? AND user_id = ?").get(id, userId);
}

export function createSavedSearch(db, userId, params) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO saved_searches
         (user_id, name, status, tag, resolution_from, resolution_to, min_volume, min_liquidity, keyword, schedule_minutes, created_at, updated_at)
       VALUES (@userId, @name, @status, @tag, @resolutionFrom, @resolutionTo, @minVolume, @minLiquidity, @keyword, @scheduleMinutes, @now, @now)`
    )
    .run({
      userId,
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
  return getSavedSearch(db, userId, result.lastInsertRowid);
}

export function updateSavedSearch(db, userId, id, params) {
  db.prepare(
    `UPDATE saved_searches SET
       name = @name, status = @status, tag = @tag,
       resolution_from = @resolutionFrom, resolution_to = @resolutionTo,
       min_volume = @minVolume, min_liquidity = @minLiquidity, keyword = @keyword,
       schedule_minutes = @scheduleMinutes,
       updated_at = @now
     WHERE id = @id AND user_id = @userId`
  ).run({
    id,
    userId,
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
  return getSavedSearch(db, userId, id);
}

export function deleteSavedSearch(db, userId, id) {
  db.prepare("DELETE FROM saved_searches WHERE id = ? AND user_id = ?").run(id, userId);
}

// Saved searches whose schedule_minutes has elapsed since last_run_at (or
// that have never run) — polled by the in-process scheduler in index.js
// across EVERY account, so this intentionally isn't scoped to one user.
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

export function findCachedAnalysis(db, userId, inputHash) {
  return db
    .prepare(
      "SELECT * FROM ai_analysis WHERE input_hash = ? AND user_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
    )
    .get(inputHash, userId);
}

export function createAnalysis(
  db,
  userId,
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
    parentAnalysisId = null,
  }
) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO ai_analysis
         (user_id, market_slug, prompt_template_id, prompt_text, input_hash, model_name, reasoning_effort,
          result_text, prompt_tokens, completion_tokens, tokens_used, cost_estimate, status, error,
          parent_analysis_id, created_at)
       VALUES (@userId, @marketSlug, @promptTemplateId, @promptText, @inputHash, @modelName, @reasoningEffort,
               @resultText, @promptTokens, @completionTokens, @tokensUsed, @costEstimate, @status, @error,
               @parentAnalysisId, @now)`
    )
    .run({
      userId,
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
      parentAnalysisId,
      now,
    });
  return getAnalysis(db, userId, result.lastInsertRowid);
}

export function getAnalysis(db, userId, id) {
  return db.prepare("SELECT * FROM ai_analysis WHERE id = ? AND user_id = ?").get(id, userId);
}

export function listAnalysesForMarket(db, userId, marketSlug) {
  return db
    .prepare("SELECT * FROM ai_analysis WHERE market_slug = ? AND user_id = ? ORDER BY created_at DESC")
    .all(marketSlug, userId);
}

// Walks an analysis's parent_analysis_id chain from the root down to `id`
// itself (inclusive) — reconstructs a follow-up thread (Phase 4) for
// rebuilding multi-turn DeepSeek context or rendering a conversation view.
// Ownership is checked once at the root call (`id` must belong to userId);
// every ancestor in the chain is always the same user's by construction
// (a follow-up's parentAnalysisId is only ever set from that user's own
// analysis), so the walk itself doesn't re-check per row.
export function getAnalysisThread(db, userId, id) {
  const root = getAnalysis(db, userId, id);
  if (!root) return [];
  const byId = db.prepare("SELECT * FROM ai_analysis WHERE id = ?");
  const chain = [];
  let current = root;
  while (current) {
    chain.unshift(current);
    current = current.parent_analysis_id ? byId.get(current.parent_analysis_id) : null;
  }
  return chain;
}

// Reusable prompt templates (Phase 4) — named, editable, selectable per
// analysis; replaces Phase 3's single settings-stored prompt string on the
// Express/SQLite backend (migration 005 seeds one from that old value).
export function listPromptTemplates(db, userId) {
  return db.prepare("SELECT * FROM prompt_templates WHERE user_id = ? ORDER BY name ASC").all(userId);
}

export function getPromptTemplate(db, userId, id) {
  return db.prepare("SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?").get(id, userId);
}

export function createPromptTemplate(db, userId, { name, template }) {
  const now = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO prompt_templates (user_id, name, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, name, template, now, now);
  return getPromptTemplate(db, userId, result.lastInsertRowid);
}

export function updatePromptTemplate(db, userId, id, { name, template }) {
  db.prepare(
    "UPDATE prompt_templates SET name = ?, template = ?, updated_at = ? WHERE id = ? AND user_id = ?"
  ).run(name, template, new Date().toISOString(), id, userId);
  return getPromptTemplate(db, userId, id);
}

export function deletePromptTemplate(db, userId, id) {
  db.prepare("DELETE FROM prompt_templates WHERE id = ? AND user_id = ?").run(id, userId);
}

// Manually-recorded trades (Phase 5) — created via "Mark as traded", then
// resolved automatically once their market closes (see the in-process
// resolution-checker in index.js, which iterates every account's open
// trades — hence listTrades/listOpenTradeSlugs below support an
// unscoped/global mode for that internal use, while every HTTP route
// passes a concrete userId).
export function createTrade(
  db,
  userId,
  { marketSlug, side, entryPrice, stake, placedAt, note = null, estimatedProb = null }
) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO trades (user_id, market_slug, side, entry_price, stake, placed_at, note, estimated_prob, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(userId, marketSlug, side, entryPrice, stake, placedAt || now, note, estimatedProb, now, now);
  return getTrade(db, userId, result.lastInsertRowid);
}

export function getTrade(db, userId, id) {
  return db.prepare("SELECT * FROM trades WHERE id = ? AND user_id = ?").get(id, userId);
}

/** `userId` is optional — omit it only for internal system use (the
 * resolution-checker scheduler), never from an HTTP route. */
export function listTrades(db, { status, marketSlug, userId } = {}) {
  const clauses = [];
  const params = [];
  if (userId != null) {
    clauses.push("user_id = ?");
    params.push(userId);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (marketSlug) {
    clauses.push("market_slug = ?");
    params.push(marketSlug);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM trades ${where} ORDER BY placed_at DESC`).all(params);
}

// Global across every account on purpose — the resolution-checker batches
// one shared Polymarket price refresh per slug regardless of who holds a
// trade on it.
export function listOpenTradeSlugs(db) {
  return db
    .prepare("SELECT DISTINCT market_slug FROM trades WHERE status = 'open'")
    .all()
    .map((r) => r.market_slug);
}

export function deleteTrade(db, userId, id) {
  db.prepare("DELETE FROM trades WHERE id = ? AND user_id = ?").run(id, userId);
}

// Internal/system use only (called by the resolution-checker with a trade
// row it already found via the unscoped listTrades) — not exposed as its
// own route, so no separate ownership check is needed here.
export function resolveTrade(db, id, { status, payout, profit }) {
  db.prepare(
    `UPDATE trades SET status = ?, payout = ?, profit = ?, resolved_at = ?, updated_at = ? WHERE id = ?`
  ).run(status, payout, profit, new Date().toISOString(), new Date().toISOString(), id);
  return db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
}

// Bankroll ledger (Phase 7) — layered on top of each user's starting
// bankroll amount (a per-user setting, see index.js): current balance =
// starting amount + sum(deposit/credit) - sum(withdrawal/debit).
export function createLedgerEntry(db, userId, { entryType, amount, tradeId = null, note = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO bankroll_ledger (user_id, entry_type, amount, trade_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, entryType, amount, tradeId, note, now);
  return getLedgerEntry(db, result.lastInsertRowid);
}

export function getLedgerEntry(db, id) {
  return db.prepare("SELECT * FROM bankroll_ledger WHERE id = ?").get(id);
}

export function listLedgerEntries(db, userId, { limit = 100 } = {}) {
  return db
    .prepare("SELECT * FROM bankroll_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit);
}

export function getLedgerNetDelta(db, userId) {
  const rows = db.prepare("SELECT entry_type, amount FROM bankroll_ledger WHERE user_id = ?").all(userId);
  let net = 0;
  for (const r of rows) {
    if (r.entry_type === "deposit" || r.entry_type === "credit") net += r.amount;
    else net -= r.amount;
  }
  return net;
}

// id-based internal helpers used only by the resolution-checker/trade
// deletion — the trade row they act on was already fetched/owned-checked
// by the caller (or, for the scheduler, is intentionally cross-account).
export function hasDebitForTrade(db, tradeId) {
  return !!db.prepare("SELECT 1 FROM bankroll_ledger WHERE trade_id = ? AND entry_type = 'debit'").get(tradeId);
}

export function deleteLedgerEntriesForTrade(db, tradeId) {
  db.prepare("DELETE FROM bankroll_ledger WHERE trade_id = ?").run(tradeId);
}

/** Audit trail of catalog fetches (ad hoc or from a saved search), Phase 2. */
export function createFetchRun(db, userId, { savedSearchId = null, filters }) {
  const result = db
    .prepare(
      `INSERT INTO fetch_runs (user_id, saved_search_id, filters_json, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`
    )
    .run(userId, savedSearchId, JSON.stringify(filters ?? {}), new Date().toISOString());
  return result.lastInsertRowid;
}

// id-based (no ownership check) — called right after createFetchRun with an
// id the caller already knows it owns, and by the saved-search scheduler.
export function completeFetchRun(db, id, { marketsAdded = 0, marketsUpdated = 0, status = "completed", error = null }) {
  db.prepare(
    `UPDATE fetch_runs SET finished_at = ?, markets_added = ?, markets_updated = ?, status = ?, error = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), marketsAdded, marketsUpdated, status, error, id);
}

export function listFetchRuns(db, userId, { savedSearchId, limit = 50 } = {}) {
  if (savedSearchId != null) {
    return db
      .prepare(
        "SELECT * FROM fetch_runs WHERE saved_search_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?"
      )
      .all(savedSearchId, userId, limit);
  }
  return db
    .prepare("SELECT * FROM fetch_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(userId, limit);
}

// Profitability tracking (Phase 9) — aggregate metrics and chart data over
// every resolved (won/lost) trade. Per-trade payout/profit are already
// computed at resolution time (Phase 5); this aggregates across trades.
export function getProfitabilityAnalytics(db, userId) {
  const resolved = db
    .prepare(
      `SELECT t.*, m.tags AS market_tags
       FROM trades t LEFT JOIN markets m ON m.slug = t.market_slug
       WHERE t.user_id = ? AND t.status IN ('won', 'lost')
       ORDER BY t.resolved_at ASC`
    )
    .all(userId);

  const totalStaked = resolved.reduce((sum, t) => sum + t.stake, 0);
  const totalProfit = resolved.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  const wonCount = resolved.filter((t) => t.status === "won").length;

  const withEstimate = resolved.filter((t) => t.estimated_prob != null);
  const avgEdge = withEstimate.length
    ? withEstimate.reduce((sum, t) => sum + (t.estimated_prob - t.entry_price), 0) / withEstimate.length
    : null;
  // Brier score: mean squared error between forecasted probability and the
  // actual binary outcome — 0 is perfect, 0.25 is what a constant 50%
  // forecast scores against a 50/50 population, 1 is maximally wrong.
  const brierScore = withEstimate.length
    ? withEstimate.reduce((sum, t) => {
        const outcome = t.status === "won" ? 1 : 0;
        return sum + (t.estimated_prob - outcome) ** 2;
      }, 0) / withEstimate.length
    : null;

  let cumulative = 0;
  const pnlOverTime = resolved.map((t) => {
    cumulative += t.profit ?? 0;
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
    byCategory.set(category, (byCategory.get(category) || 0) + (t.profit ?? 0));
  }
  const pnlByCategory = [...byCategory.entries()]
    .map(([category, profit]) => ({ category, profit }))
    .sort((a, b) => b.profit - a.profit);

  // Calibration: bucket trades with an estimate into 10 probability
  // deciles, comparing each bucket's average forecast to its actual win rate.
  const buckets = Array.from({ length: 10 }, () => ({ estimates: [], wins: 0, count: 0 }));
  for (const t of withEstimate) {
    const idx = Math.min(9, Math.max(0, Math.floor(t.estimated_prob * 10)));
    buckets[idx].estimates.push(t.estimated_prob);
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
