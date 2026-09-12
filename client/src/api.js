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
};
