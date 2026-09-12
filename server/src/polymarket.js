const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
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
  });
}

/** Looks up one market by its exact slug — used for the "update selected
 * markets" bulk price refresh, where we already know which slugs to target
 * instead of paging through the whole catalog. */
export async function fetchMarketBySlug(slug) {
  const data = await getJson(`${GAMMA_BASE}/markets`, { slug, limit: 1 });
  return Array.isArray(data) && data.length ? data[0] : null;
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

  return {
    slug: raw.slug ?? null,
    marketId: raw.id ?? null,
    conditionId: raw.conditionId ?? null,
    question: raw.question ?? null,
    outcomes,
    outcomePrices: prices,
    currentPrice: yesPrice,
    yesTokenId,
    volume: safeFloat(raw.volume),
    liquidity: safeFloat(raw.liquidity),
    resolutionDate: raw.endDate ?? null,
    active: Boolean(raw.active),
    closed: Boolean(raw.closed),
    tags: extractTags(raw),
  };
}
