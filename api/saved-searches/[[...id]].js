import {
  getPool,
  ensureSchema,
  listSavedSearches,
  getSavedSearch,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
} from "../../lib/db.js";

// Phase 2 parity: saved search configurations, as a single catch-all
// covering /api/saved-searches (list/create) and /api/saved-searches/:id
// (update/delete) — see api/markets/[slug]/[[...action]].js for why this
// repo consolidates routes this way (Vercel Hobby's 12-function cap).
//
// schedule_minutes round-trips through the form but nothing executes it
// here — there's no background job runner on this deploy target without a
// separately-configured Vercel Cron job hitting a "run due searches"
// endpoint, which doesn't exist yet. Manual "Run" (via /api/sync/step)
// still works.

async function handleCollection(req, res, pool) {
  if (req.method === "GET") {
    return res.status(200).json(await listSavedSearches(pool));
  }
  if (req.method === "POST") {
    const { name } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const created = await createSavedSearch(pool, { ...req.body, name: name.trim() });
    return res.status(201).json(created);
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleOne(req, res, pool, id) {
  if (req.method === "PUT") {
    const existing = await getSavedSearch(pool, id);
    if (!existing) return res.status(404).json({ error: "Saved search not found" });
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : existing.name;
    const updated = await updateSavedSearch(pool, id, { ...existing, ...req.body, name });
    return res.status(200).json(updated);
  }
  if (req.method === "DELETE") {
    await deleteSavedSearch(pool, id);
    return res.status(204).end();
  }
  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    const [id] = req.query.id || [];
    if (!id) return await handleCollection(req, res, pool);
    return await handleOne(req, res, pool, id);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
