const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
// Polymarket's public "Data API" — powers polymarket.com's own leaderboard
// and portfolio pages. No API key needed, but (unlike Gamma/CLOB above)
// there's no official published schema for it, so every field below is read
// defensively with fallback names rather than assumed exact.
const DATA_API_BASE = "https://data-api.polymarket.com";
const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_LIMIT = 3;
const RETRY_BACKOFF_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  let lastErr;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(u, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw new Error(`GET ${url} failed after ${RETRY_LIMIT} attempts: ${lastErr}`);
}

export async function fetchMarketsPage(
  offset,
  { limit = PAGE_SIZE, active = true, closed = false, order = "volume" } = {}
) {
  return getJson(`${GAMMA_BASE}/markets`, {
    limit,
    offset,
    order,
    ascending: "false",
    active: active === null ? undefined : String(active),
    closed: closed === null ? undefined : String(closed),
    // Without this, Gamma omits each market's `events` relation entirely —
    // and event.tags is where category/tag labels actually live (a market
    // itself carries no tags of its own). See normalizeMarket/extractTags.
    include_tag: "true",
  });
}

/** Looks up one market by its exact slug — used for the "update selected
 * markets" bulk price refresh, where we already know which slugs to target
 * instead of paging through the whole catalog. */
export async function fetchMarketBySlug(slug) {
  const data = await getJson(`${GAMMA_BASE}/markets`, { slug, limit: 1, include_tag: "true" });
  return Array.isArray(data) && data.length ? data[0] : null;
}

/** Maps the sync UI's status selector to Gamma's active/closed query params.
 * "all" passes null for both, which fetchMarketsPage omits from the query
 * entirely — i.e. markets of any status. */
export function resolveStatusFilter(status) {
  if (status === "closed") return { active: false, closed: true };
  if (status === "all") return { active: null, closed: null };
  return { active: true, closed: false };
}

/** A stable key for "the set of markets this sync configuration targets" —
 * used to persist how far a sync has paged into that set (see
 * server/src/db.js's getSyncCursor/setSyncCursor) so a fresh run continues
 * into unseen markets instead of re-fetching the same top-of-list results
 * every time. Deliberately excludes batchSize/history/interval, which
 * change how a page is processed but not which markets match. */
export function syncFilterSignature({
  status = "active",
  tag = "",
  resolutionFrom = "",
  resolutionTo = "",
  minVolume = 0,
  minLiquidity = 0,
  keyword = "",
} = {}) {
  return JSON.stringify([status, tag, resolutionFrom, resolutionTo, minVolume, minLiquidity, keyword]);
}

function endOfDay(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T23:59:59.999Z` : dateStr;
}

/** True if a normalized market's resolution date falls within [from, to]
 * (inclusive; either bound optional). A market with no resolution date is
 * excluded whenever a bound is set, since membership can't be confirmed. */
export function inResolutionRange(resolutionDate, from, to) {
  if (!from && !to) return true;
  if (!resolutionDate) return false;
  const t = new Date(resolutionDate).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(from).getTime()) return false;
  if (to && t > new Date(endOfDay(to)).getTime()) return false;
  return true;
}

/** Async generator — paginates through the Gamma API, yielding raw market objects. */
export async function* fetchAllMarkets({ maxMarkets = null, active = true, closed = false } = {}) {
  let offset = 0;
  let fetched = 0;
  for (;;) {
    const page = await fetchMarketsPage(offset, { active, closed });
    if (!page || page.length === 0) return;
    for (const m of page) {
      yield m;
      fetched += 1;
      if (maxMarkets && fetched >= maxMarkets) return;
    }
    if (page.length < PAGE_SIZE) return;
    offset += PAGE_SIZE;
  }
}

/** Returns [{ t: unixSeconds, p: price }, ...] for a CLOB token id. */
export async function fetchPriceHistory(tokenId, interval = "max") {
  const data = await getJson(`${CLOB_BASE}/prices-history`, { market: tokenId, interval });
  return data.history ?? [];
}

/** Top traders by volume or P&L over a time window, from Polymarket's own
 * leaderboard — powers the "Whales trades" tab (see whales.js). `limit` is
 * capped at 50 by the API itself, conveniently matching "top-50 traders".
 * The response envelope/field names aren't officially documented, so this
 * accepts a plain array or a couple of likely wrapper shapes, and reads each
 * row's fields with fallbacks. */
export async function fetchLeaderboard({ timePeriod = "DAY", orderBy = "VOL", limit = 50 } = {}) {
  const data = await getJson(`${DATA_API_BASE}/v1/leaderboard`, { timePeriod, orderBy, limit });
  const rows = Array.isArray(data) ? data : data?.traders ?? data?.results ?? data?.leaderboard ?? [];
  return rows
    .map((r) => ({
      wallet: r.proxyWallet ?? r.wallet ?? r.address ?? r.user ?? null,
      name: r.name ?? r.userName ?? r.pseudonym ?? r.displayName ?? null,
      pnl: safeFloat(r.pnl),
      volume: safeFloat(r.vol ?? r.volume),
    }))
    .filter((r) => r.wallet);
}

/** One wallet's current open positions, biggest (by live USD value) first —
 * same undocumented Data API as fetchLeaderboard. */
export async function fetchUserPositions(wallet, { limit = 10 } = {}) {
  const data = await getJson(`${DATA_API_BASE}/positions`, {
    user: wallet,
    limit,
    sortBy: "CURRENT",
    sizeThreshold: 1,
  });
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    conditionId: r.conditionId ?? null,
    slug: r.slug ?? null,
    eventSlug: r.eventSlug ?? null,
    title: r.title ?? null,
    outcome: r.outcome ?? null,
    size: safeFloat(r.size),
    avgPrice: safeFloat(r.avgPrice),
    curPrice: safeFloat(r.curPrice),
    currentValue: safeFloat(r.currentValue),
    cashPnl: safeFloat(r.cashPnl),
    percentPnl: safeFloat(r.percentPnl),
  }));
}

function safeFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonField(raw, fallback = []) {
  if (raw == null) return fallback;
  if (Array.isArray(raw) || typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Gamma markets carry their event/category tags nested under `events[].tags`
 * (each `{ label, slug, ... }`); some responses also expose a flat `tags` or
 * `category` field. Collect whatever's present into a flat, deduped list of
 * labels for filtering/display. */
function extractTags(raw) {
  const labels = new Set();
  const addFrom = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      const label = typeof t === "string" ? t : t?.label;
      if (label) labels.add(label);
    }
  };
  if (Array.isArray(raw.events)) {
    for (const ev of raw.events) addFrom(ev?.tags);
  }
  addFrom(raw.tags);
  if (!labels.size && raw.category) labels.add(String(raw.category));
  return [...labels];
}

/** A market belongs to at most one Polymarket "event" in practice (Gamma's
 * schema allows an array, but multi-event markets aren't a real case we've
 * seen) — that event is what groups sibling markets together (e.g. each
 * candidate in an election is its own market under one election event). */
function extractEvent(raw) {
  const ev = Array.isArray(raw.events) && raw.events.length ? raw.events[0] : null;
  return {
    eventId: ev?.id ?? null,
    eventSlug: ev?.slug ?? null,
    eventTitle: ev?.title ?? null,
  };
}

/** Turns one raw Gamma API market object into our flat storage shape. */
export function normalizeMarket(raw) {
  const outcomes = parseJsonField(raw.outcomes, []);
  const prices = parseJsonField(raw.outcomePrices, []);
  const tokenIds = parseJsonField(raw.clobTokenIds, []);

  let yesPrice = null;
  let yesTokenId = null;
  const yesIdx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === "yes");
  if (yesIdx !== -1) {
    if (yesIdx < prices.length) yesPrice = safeFloat(prices[yesIdx]);
    if (yesIdx < tokenIds.length) yesTokenId = tokenIds[yesIdx];
  } else if (prices.length) {
    // Non-binary / unlabeled market: fall back to the first outcome
    yesPrice = safeFloat(prices[0]);
    yesTokenId = tokenIds[0] ?? null;
  }

  let noPrice = null;
  const noIdx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === "no");
  if (noIdx !== -1) {
    if (noIdx < prices.length) noPrice = safeFloat(prices[noIdx]);
  } else if (prices.length > 1) {
    // Non-binary / unlabeled market: fall back to the second outcome
    noPrice = safeFloat(prices[1]);
  }

  return {
    slug: raw.slug ?? null,
    marketId: raw.id ?? null,
    conditionId: raw.conditionId ?? null,
    question: raw.question ?? null,
    outcomes,
    outcomePrices: prices,
    currentPrice: yesPrice,
    noPrice,
    yesTokenId,
    volume: safeFloat(raw.volume),
    liquidity: safeFloat(raw.liquidity),
    resolutionDate: raw.endDate ?? null,
    active: Boolean(raw.active),
    closed: Boolean(raw.closed),
    tags: extractTags(raw),
    ...extractEvent(raw),
  };
}
