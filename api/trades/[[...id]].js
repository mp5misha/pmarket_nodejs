import {
  getPool,
  ensureSchema,
  getMarket,
  listTrades,
  createTrade,
  getTrade,
  deleteTrade,
  listOpenTradeSlugs,
  resolveTrade,
  getProfitabilityAnalytics,
  upsertMarket,
} from "../../lib/db.js";
import { fetchMarketBySlug, normalizeMarket } from "../../lib/polymarket.js";
import { resolveTradeOutcome, winningSideFromPrice } from "../../lib/pnl.js";

// Phase 5/9 parity: manually-recorded trades, resolved automatically once
// their market closes — a single catch-all covering /api/trades (list/
// create), /api/trades/:id (delete), /api/trades/check-resolutions,
// /api/trades/analytics and /api/trades/export. See
// api/markets/[slug]/[[...action]].js for why this repo consolidates routes
// this way (Vercel Hobby's 12-function cap). No bankroll ledger/auto-deduct
// on this deploy target (Phase 7, still Express/SQLite only).

async function handleList(req, res, pool) {
  const { status, marketSlug } = req.query;
  res.status(200).json(await listTrades(pool, { status, marketSlug }));
}

async function handleCreate(req, res, pool) {
  const { marketSlug, side, entryPrice, stake, placedAt, note, estimatedProb } = req.body || {};
  if (!marketSlug || !["yes", "no"].includes(side)) {
    return res.status(400).json({ error: "marketSlug and side ('yes' or 'no') are required" });
  }
  const price = Number(entryPrice);
  const stakeAmount = Number(stake);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return res.status(400).json({ error: "entryPrice must be a number between 0 and 1" });
  }
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    return res.status(400).json({ error: "stake must be a positive number" });
  }
  let estimatedProbValue = null;
  if (estimatedProb !== undefined && estimatedProb !== null && estimatedProb !== "") {
    estimatedProbValue = Number(estimatedProb);
    if (!Number.isFinite(estimatedProbValue) || estimatedProbValue < 0 || estimatedProbValue > 1) {
      return res.status(400).json({ error: "estimatedProb must be a number between 0 and 1" });
    }
  }
  if (!(await getMarket(pool, marketSlug))) return res.status(404).json({ error: "Market not found" });

  const trade = await createTrade(pool, {
    marketSlug,
    side,
    entryPrice: price,
    stake: stakeAmount,
    placedAt: placedAt || undefined,
    note: note || null,
    estimatedProb: estimatedProbValue,
  });
  res.status(201).json(trade);
}

async function handleDelete(req, res, pool, id) {
  const existing = await getTrade(pool, id);
  if (!existing) return res.status(404).json({ error: "Trade not found" });
  await deleteTrade(pool, id);
  res.status(204).end();
}

// Manually kicks the same resolution check a background scheduler would run
// on the Express backend — refreshes prices for every open trade's market,
// then resolves any trade whose market has settled to (near) 0 or 1.
async function handleCheckResolutions(req, res, pool) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const slugs = await listOpenTradeSlugs(pool);
  if (slugs.length === 0) return res.status(200).json({ checked: 0, resolved: 0 });

  await Promise.all(
    slugs.map(async (slug) => {
      try {
        const raw = await fetchMarketBySlug(slug);
        if (raw) await upsertMarket(pool, normalizeMarket(raw));
      } catch {
        // Best-effort refresh — fall back to whatever price is already stored.
      }
    })
  );

  let resolved = 0;
  for (const slug of slugs) {
    const market = await getMarket(pool, slug);
    if (!market || !market.closed || market.current_price == null) continue;

    const winningSide = winningSideFromPrice(market.current_price);
    if (!winningSide) continue; // closed but not cleanly settled to 0/1 yet

    for (const trade of await listTrades(pool, { status: "open", marketSlug: slug })) {
      const { status, payout, profit } = resolveTradeOutcome({
        side: trade.side,
        entryPrice: Number(trade.entry_price),
        stake: Number(trade.stake),
        winningSide,
      });
      await resolveTrade(pool, trade.id, { status, payout, profit });
      resolved += 1;
    }
  }
  res.status(200).json({ checked: slugs.length, resolved });
}

async function handleAnalytics(req, res, pool) {
  res.status(200).json(await getProfitabilityAnalytics(pool));
}

async function handleExport(req, res, pool) {
  const rows = await listTrades(pool);
  if (!rows.length) return res.status(404).send("No trades to export yet");
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=trades.csv");
  res.status(200).send(lines.join("\n"));
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    const [id] = req.query.id || [];
    if (!id) {
      if (req.method === "GET") return await handleList(req, res, pool);
      if (req.method === "POST") return await handleCreate(req, res, pool);
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (id === "check-resolutions") return await handleCheckResolutions(req, res, pool);
    if (id === "analytics") return await handleAnalytics(req, res, pool);
    if (id === "export") return await handleExport(req, res, pool);
    if (req.method === "DELETE") return await handleDelete(req, res, pool, id);

    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
