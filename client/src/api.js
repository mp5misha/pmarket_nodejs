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
  history: (slug, interval = "max") =>
    fetch(`${BASE}/markets/${encodeURIComponent(slug)}/history?interval=${interval}`).then(handle),
  tags: () => fetch(`${BASE}/tags`).then(handle),
  // Asks DeepSeek to analyze one market's real probability and background —
  // can take a while (up to a minute or so), so no client-side timeout here.
  analyzeMarket: (slug) =>
    fetch(`${BASE}/markets/${encodeURIComponent(slug)}/analyze`, { method: "POST" }).then(handle),
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
};
