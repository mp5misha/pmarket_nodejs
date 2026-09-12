// In dev, Vite proxies "/api" to the local Express server (see vite.config.js).
// In production on a split deploy (client on Vercel, API on Render/Railway/etc.),
// set VITE_API_BASE to the deployed API's full URL, e.g.
// https://polymarket-tracker-api.onrender.com/api
const BASE = import.meta.env.VITE_API_BASE || "/api";


async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  stats: () => fetch(`${BASE}/stats`).then(handle),
  markets: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return fetch(`${BASE}/markets${qs ? `?${qs}` : ""}`).then(handle);
  },
  market: (slug) => fetch(`${BASE}/markets/${encodeURIComponent(slug)}`).then(handle),
  // Same filters as markets(), but grouped by Polymarket event and paginated
  // over groups instead of raw rows — powers <MarketGrid>.
  groupedMarkets: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return fetch(`${BASE}/markets/grouped${qs ? `?${qs}` : ""}`).then(handle);
  },
  history: (slug, interval = "max") =>
    fetch(`${BASE}/markets/${encodeURIComponent(slug)}/history?interval=${interval}`).then(handle),
  // Sibling markets under the same Polymarket event (e.g. other candidates
  // in the same election), for the detail panel's "related markets" list.
  related: (slug) => fetch(`${BASE}/markets/${encodeURIComponent(slug)}/related`).then(handle),
  tags: () => fetch(`${BASE}/tags`).then(handle),
  // Asks DeepSeek to analyze one market's real probability and background —
  // can take a while (up to a minute or so), so no client-side timeout here.
  // Without force, a completed analysis with identical inputs (market +
  // prompt + model + reasoning effort) is served from history instead of
  // billing DeepSeek again; force: true always creates a new record.
  analyzeMarket: (slug, { force = false } = {}) =>
    fetch(`${BASE}/markets/${encodeURIComponent(slug)}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    }).then(handle),
  // Full history of past analyses for one market (Phase 3), newest first.
  listAnalyses: (slug) => fetch(`${BASE}/markets/${encodeURIComponent(slug)}/analyses`).then(handle),
  getAnalysis: (id) => fetch(`${BASE}/analyses/${id}`).then(handle),
  // Bulk-refreshes current price/volume/liquidity for the given slugs from
  // Polymarket, in place of a full sync — used by the table's "Update
  // selected" action.
  refreshMarkets: (slugs) =>
    fetch(`${BASE}/markets/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slugs }),
    }).then(handle),
  // One bounded chunk of a sync — the caller loops this, advancing offset,
  // until `done` comes back true. Same contract on both deploy targets
  // (Express /api/sync/step and the Vercel function of the same name).
  syncStep: (opts) =>
    fetch(`${BASE}/sync/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then(handle),
  exportUrl: () => `${BASE}/export`,
  // Settings: the DeepSeek API key, configurable from the app itself instead
  // of only via the DEEPSEEK_API_KEY environment variable. The key itself is
  // never sent back — only whether one is set and where it came from.
  getDeepSeekKeyStatus: () => fetch(`${BASE}/settings/deepseek-key`).then(handle),
  setDeepSeekKey: (apiKey) =>
    fetch(`${BASE}/settings/deepseek-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }).then(handle),
  clearDeepSeekKey: () =>
    fetch(`${BASE}/settings/deepseek-key`, { method: "DELETE" }).then(handle),
  // The DeepSeek analysis prompt template — user-editable, supports
  // {slug}/{yes_price}/{no_price}/{end_date}/{liquidity} placeholders.
  getPromptTemplate: () => fetch(`${BASE}/settings/deepseek-prompt`).then(handle),
  setPromptTemplate: (template) =>
    fetch(`${BASE}/settings/deepseek-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template }),
    }).then(handle),
  resetPromptTemplate: () =>
    fetch(`${BASE}/settings/deepseek-prompt`, { method: "DELETE" }).then(handle),
  // DeepSeek model + reasoning effort (Phase 3): deepseek-flash/deepseek-v4-pro,
  // non-thinking/thinking/thinking (max).
  getDeepSeekModelStatus: () => fetch(`${BASE}/settings/deepseek-model`).then(handle),
  setDeepSeekModelStatus: (params) =>
    fetch(`${BASE}/settings/deepseek-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),

  // Market Discovery (Phase 2): saved search configurations and an audit
  // trail of catalog fetches. Not available on the frozen Vercel deploy
  // yet — callers should treat rejection as "feature unavailable here"
  // rather than a hard failure.
  listSavedSearches: () => fetch(`${BASE}/saved-searches`).then(handle),
  createSavedSearch: (params) =>
    fetch(`${BASE}/saved-searches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  updateSavedSearch: (id, params) =>
    fetch(`${BASE}/saved-searches/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  deleteSavedSearch: (id) =>
    fetch(`${BASE}/saved-searches/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    }),
  listFetchRuns: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return fetch(`${BASE}/fetch-runs${qs ? `?${qs}` : ""}`).then(handle);
  },
  createFetchRun: (params) =>
    fetch(`${BASE}/fetch-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
  completeFetchRun: (id, params) =>
    fetch(`${BASE}/fetch-runs/${id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(handle),
};
