// In dev, Vite proxies "/api" to the local Express server (see vite.config.js).
// In production on a split deploy (client on Vercel, API on Render/Railway/etc.),
// set VITE_API_BASE to the deployed API's full URL, e.g.
// https://polymarket-tracker-api.onrender.com/api
const BASE = import.meta.env.VITE_API_BASE || "/api";


async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Every API call goes through here so the session cookie (Phase 8 auth) is
// always sent — required even for same-origin requests in some browser
// configurations, and essential for a cross-origin split deploy (client and
// API on different hosts).
function req(url, options) {
  return fetch(url, { ...options, credentials: "include" });
}

export const api = {
  // Served from /api/meta/stats on Vercel (merged with tags into one
  // function to fit the Hobby plan's function-count budget) and from
  // /api/stats on Express — both routes exist on Express so this URL works
  // either way.
  stats: () => req(`${BASE}/meta/stats`).then(handle),
  market: (slug) => req(`${BASE}/markets/${encodeURIComponent(slug)}`).then(handle),
  // Same filters as markets(), but grouped by Polymarket event and paginated
  // over groups instead of raw rows — powers <MarketGrid>.
  groupedMarkets: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return req(`${BASE}/markets/grouped${qs ? `?${qs}` : ""}`).then(handle);
  },
  history: (slug, interval = "max") =>
    req(`${BASE}/markets/${encodeURIComponent(slug)}/history?interval=${interval}`).then(handle),
  // Sibling markets under the same Polymarket event (e.g. other candidates
  // in the same election), for the detail panel's "related markets" list.
  related: (slug) => req(`${BASE}/markets/${encodeURIComponent(slug)}/related`).then(handle),
  // See stats() above re: /api/meta/tags vs. /api/tags.
  tags: () => req(`${BASE}/meta/tags`).then(handle),
  // Top-50 leaderboard traders' current positions, aggregated server-side
  // (see server/src/whales.js / lib/whales.js) — powers the "Whales trades"
  // tab. No Express-only alias needed here; unlike stats/tags this route
  // never had its own dedicated path, so both backends serve it at
  // /api/meta/whales.
  whales: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return req(`${BASE}/meta/whales${qs ? `?${qs}` : ""}`).then(handle);
  },
  // Asks DeepSeek to analyze one market's real probability and background —
  // can take a while (up to a minute or so), so no client-side timeout here.
  // Without force, a completed analysis with identical inputs (market +
  // prompt + model + reasoning effort) is served from history instead of
  // billing DeepSeek again; force: true always creates a new record.
  analyzeMarket: (slug, { force = false, templateId } = {}) =>
    req(`${BASE}/markets/${encodeURIComponent(slug)}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force, templateId }),
    }).then(handle),
  // Full history of past analyses for one market (Phase 3), newest first.
  listAnalyses: (slug) => req(`${BASE}/markets/${encodeURIComponent(slug)}/analyses`).then(handle),
  getAnalysis: (id) => req(`${BASE}/analyses/${id}`).then(handle),
  // Follow-up prompts layered on a stored analysis (Phase 4) — DeepSeek gets
  // the whole reconstructed thread as context, always creates a new record.
  followUpAnalysis: (id, text) =>
    req(`${BASE}/analyses/${id}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(handle),
  // Re-parses a market-kind analysis's already-stored result_text for the
  // trailing "FAIR_PROBABILITY_YES: <decimal>" line and persists whatever
  // it finds, without calling DeepSeek again — powers the "Parse the AI
  // response" button, for backfilling an analysis run before that
  // instruction existed or retrying one the model didn't follow the first
  // time. On Vercel this shares a file with followUpAnalysis's route (see
  // api/analyses/[id]/[action].js) to stay within the function budget.
  parseFairProbability: (id) =>
    req(`${BASE}/analyses/${id}/parse-fair-probability`, { method: "POST" }).then(handle),
  // "AI analysis of Whales activity" — a second, independent analysis
  // stream on the same market/route, selected via kind: "whales" (see
  // server/src/index.js's /api/markets/:slug/analyze and .../analyses).
  // followUpAnalysis() above is reused as-is for whale-analysis follow-ups
  // too — the parent analysis's own stored kind carries through server-side.
  analyzeWhales: (slug, { force = false } = {}) =>
    req(`${BASE}/markets/${encodeURIComponent(slug)}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force, kind: "whales" }),
    }).then(handle),
  listWhaleAnalyses: (slug) =>
    req(`${BASE}/markets/${encodeURIComponent(slug)}/analyses?kind=whales`).then(handle),
  // Reusable prompt templates (Phase 4). Express/SQLite only — callers
  // should treat rejection as "feature unavailable here", same as
  // saved searches/fetch runs.
  listPromptTemplates: () => req(`${BASE}/prompt-templates`).then(handle),
  createPromptTemplate: (params) =>
    req(`${BASE}/prompt-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  updatePromptTemplate: (id, params) =>
    req(`${BASE}/prompt-templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  deletePromptTemplate: (id) =>
    req(`${BASE}/prompt-templates/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    }),
  getDefaultPromptTemplate: () => req(`${BASE}/settings/default-prompt-template`).then(handle),
  setDefaultPromptTemplate: (templateId) =>
    req(`${BASE}/settings/default-prompt-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    }).then(handle),
  // Bulk-refreshes current price/volume/liquidity for the given slugs from
  // Polymarket, in place of a full sync — used by the table's "Update
  // selected" action.
  refreshMarkets: (slugs) =>
    req(`${BASE}/markets/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slugs }),
    }).then(handle),
  // Removes the given slugs from the local catalog entirely (e.g. clearing
  // out resolved markets) — used by the table's "Delete selected" action.
  // Slugs go in the query string, not a DELETE body, on both backends (see
  // api/markets/bulk.js).
  deleteMarkets: (slugs) =>
    req(`${BASE}/markets/bulk?slugs=${slugs.map(encodeURIComponent).join(",")}`, {
      method: "DELETE",
    }).then(handle),
  // One bounded chunk of a sync — the caller loops this, advancing offset,
  // until `done` comes back true. Same contract on both deploy targets
  // (Express /api/sync/step and the Vercel function of the same name).
  syncStep: (opts) =>
    req(`${BASE}/sync/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then(handle),
  // See stats()/tags() above re: /api/meta/export vs. /api/export.
  exportUrl: () => `${BASE}/meta/export`,
  // Settings: the DeepSeek API key, configurable from the app itself instead
  // of only via the DEEPSEEK_API_KEY environment variable. The key itself is
  // never sent back — only whether one is set and where it came from.
  getDeepSeekKeyStatus: () => req(`${BASE}/settings/deepseek-key`).then(handle),
  setDeepSeekKey: (apiKey) =>
    req(`${BASE}/settings/deepseek-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }).then(handle),
  clearDeepSeekKey: () =>
    req(`${BASE}/settings/deepseek-key`, { method: "DELETE" }).then(handle),
  // The DeepSeek analysis prompt template — user-editable, supports
  // {slug}/{yes_price}/{no_price}/{end_date}/{liquidity} placeholders.
  getPromptTemplate: () => req(`${BASE}/settings/deepseek-prompt`).then(handle),
  setPromptTemplate: (template) =>
    req(`${BASE}/settings/deepseek-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template }),
    }).then(handle),
  resetPromptTemplate: () =>
    req(`${BASE}/settings/deepseek-prompt`, { method: "DELETE" }).then(handle),
  // The "AI analysis of Whales activity" prompt — supports {slug}/
  // {whale_name}/{whale_position_direction}/{whale_position_value}/
  // {whale_unrealized_pnl} placeholders (see deepseek.js's
  // buildWhaleAnalysisPrompt). A single configurable prompt, same shape as
  // getPromptTemplate above, on both backends (no Phase 4 named-templates
  // system for this one).
  getWhalePromptTemplate: () => req(`${BASE}/settings/deepseek-whale-prompt`).then(handle),
  setWhalePromptTemplate: (template) =>
    req(`${BASE}/settings/deepseek-whale-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template }),
    }).then(handle),
  resetWhalePromptTemplate: () =>
    req(`${BASE}/settings/deepseek-whale-prompt`, { method: "DELETE" }).then(handle),
  // DeepSeek model + reasoning effort (Phase 3): deepseek-flash/deepseek-v4-pro,
  // non-thinking/thinking/thinking (max).
  getDeepSeekModelStatus: () => req(`${BASE}/settings/deepseek-model`).then(handle),
  setDeepSeekModelStatus: (params) =>
    req(`${BASE}/settings/deepseek-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),

  // Highlight threshold (Phase 5) — markets with implied Yes probability at
  // or above this percentage are highlighted in the grid.
  getHighlightThreshold: () => req(`${BASE}/settings/highlight-threshold`).then(handle),
  setHighlightThreshold: (thresholdPct) =>
    req(`${BASE}/settings/highlight-threshold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholdPct }),
    }).then(handle),

  // Manually-recorded trades (Phase 5) — resolved automatically once their
  // market closes (see the server's in-process resolution checker).
  listTrades: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return req(`${BASE}/trades${qs ? `?${qs}` : ""}`).then(handle);
  },
  createTrade: (params) =>
    req(`${BASE}/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  // Query-param id/action (rather than /trades/:id, /trades/analytics, ...)
  // because the Vercel deploy's mirror of this endpoint (api/trades.js) is a
  // single flat file with no dynamic path segment to capture a literal
  // sub-path — see README's "Function count" section. Express answers the
  // same query-param requests (see server/src/index.js's /api/trades
  // routes) alongside its own path-based ones.
  deleteTrade: (id) =>
    req(`${BASE}/trades?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    }),
  checkTradeResolutions: () => req(`${BASE}/trades?action=check-resolutions`, { method: "POST" }).then(handle),
  // Single-trade version of the above — the My Trades grid's per-row
  // "Resolve" button. Returns { trade, resolved, message? }: resolved is
  // false (with a message explaining why — already resolved, market still
  // open, or closed but not yet cleanly settled) rather than an error, so
  // the UI can show a plain note instead of a failure banner in that case.
  resolveTrade: (id) =>
    req(`${BASE}/trades?action=resolve&id=${encodeURIComponent(id)}`, { method: "POST" }).then(handle),
  // Profitability tracking (Phase 9) — aggregate metrics + chart data over
  // every resolved trade.
  getTradeAnalytics: () => req(`${BASE}/trades?action=analytics`).then(handle),
  tradesExportUrl: () => `${BASE}/trades?action=export`,

  // Bet-sizing configuration (Phase 6) — Kelly fraction, flat stake, fixed
  // percentage. The response's `bankrollAmount` is the live bankroll
  // balance (Phase 7's ledger-backed figure) — set the starting amount via
  // getBankroll/setBankroll instead of here.
  getBetSizing: () => req(`${BASE}/settings/bet-sizing`).then(handle),
  setBetSizing: (params) =>
    req(`${BASE}/settings/bet-sizing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),

  // Bankroll settings, dashboard, and ledger (Phase 7).
  getBankroll: () => req(`${BASE}/settings/bankroll`).then(handle),
  setBankroll: (params) =>
    req(`${BASE}/settings/bankroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  getBankrollDashboard: () => req(`${BASE}/bankroll/dashboard`).then(handle),
  listBankrollLedger: (limit) => req(`${BASE}/bankroll/ledger${limit ? `?limit=${limit}` : ""}`).then(handle),
  addLedgerEntry: (params) =>
    req(`${BASE}/bankroll/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),

  // Auth (Phase 8) — session cookie is set/cleared by the server itself on
  // login/2fa-verify/logout; nothing here touches document.cookie directly.
  register: (email, password) =>
    req(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).then(handle),
  resendVerification: (email) =>
    req(`${BASE}/auth/resend-verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).then(handle),
  verifyEmail: (token) =>
    req(`${BASE}/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(handle),
  login: (email, password) =>
    req(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).then(handle),
  verify2fa: (pendingToken, code, rememberDevice) =>
    req(`${BASE}/auth/2fa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingToken, code, rememberDevice }),
    }).then(handle),
  logout: () => req(`${BASE}/auth/logout`, { method: "POST" }).then(handle),
  // A 404 here means this backend has no auth support at all (the frozen
  // Vercel deploy, which predates accounts) — distinct from a real 200
  // {user: null} meaning "supported, just not logged in". App.jsx uses this
  // to skip the auth gate entirely on Vercel instead of showing a login
  // screen with no working login endpoint behind it.
  me: async () => {
    const res = await req(`${BASE}/auth/me`);
    if (res.status === 404) return { user: null, authSupported: false };
    return { ...(await handle(res)), authSupported: true };
  },
  forgotPassword: (email) =>
    req(`${BASE}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).then(handle),
  resetPassword: (token, newPassword) =>
    req(`${BASE}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    }).then(handle),
  // Migration path for pre-Phase-8 data (see server migration 008) — call
  // once after logging in to inherit whatever the placeholder legacy
  // account owned.
  claimLegacyData: () => req(`${BASE}/auth/claim-legacy-data`, { method: "POST" }).then(handle),
};
