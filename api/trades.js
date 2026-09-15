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
} from "../lib/db.js";
import { fetchMarketBySlug, normalizeMarket } from "../lib/polymarket.js";
import { resolveTradeOutcome, winningSideFromPrice } from "../lib/pnl.js";

// Phase 5/9 parity: manually-recorded trades, resolved automatically once
// their market closes. A single flat file with NO dynamic path segment —
// list/create live on GET/POST here, and delete/check-resolutions/
// analytics/export are dispatched via ?id=/?action= query params instead of
// /trades/:id-style sub-paths, purely to stay a plain static file (the most
// reliable routing shape Vercel supports outside Next.js — see README's
// "Function count" section for why catch-all and nested dynamic segments
// are avoided here). Express answers the same query-param shape alongside
// its own path-based routes (server/src/index.js). No bankroll ledger/
// auto-deduct on this deploy target (Phase 7, still Express/SQLite only).

async function handleList(req, res, pool) {
  const { status, marketSlug } = req.query;
  res.status(200).json(await listTrades(pool, { status, marketSlug }));
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

// Manually kicks the same resolution check a background scheduler would run
// on the Express backend — refreshes prices for every open trade's market,
// then resolves any trade whose market has settled to (near) 0 or 1.
async function handleCheckResolutions(req, res, pool) {
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

// Single-trade version of handleCheckResolutions above, for the My Trades
// grid's per-row "Resolve" button — refreshes just that one trade's market
// price, then resolves the trade if (and only if) the market has cleanly
// settled, reporting why not otherwise rather than silently no-opping.
// Mirrors server/src/index.js's resolveSingleTrade; no ledger crediting
// here, matching this file's own "no bankroll ledger on this deploy
// target" note above.
async function handleResolve(req, res, pool) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id is required" });
  const trade = await getTrade(pool, id);
  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (trade.status !== "open") {
    return res.status(200).json({ trade, resolved: false, message: "This trade is already resolved." });
  }
  try {
    const raw = await fetchMarketBySlug(trade.market_slug);
    if (raw) await upsertMarket(pool, normalizeMarket(raw));
  } catch {
    // Best-effort refresh — fall back to whatever price is already stored.
  }
  const market = await getMarket(pool, trade.market_slug);
  if (!market || !market.closed || market.current_price == null) {
    return res.status(200).json({ trade, resolved: false, message: "This market hasn't closed yet." });
  }
  const winningSide = winningSideFromPrice(market.current_price);
  if (!winningSide) {
    return res
      .status(200)
      .json({ trade, resolved: false, message: "This market is closed but hasn't cleanly settled to 0 or 1 yet." });
  }
  const { status, payout, profit } = resolveTradeOutcome({
    side: trade.side,
    entryPrice: Number(trade.entry_price),
    stake: Number(trade.stake),
    winningSide,
  });
  const updated = await resolveTrade(pool, trade.id, { status, payout, profit });
  res.status(200).json({ trade: updated, resolved: true });
}

async function handleDelete(req, res, pool) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id is required" });
  const existing = await getTrade(pool, id);
  if (!existing) return res.status(404).json({ error: "Trade not found" });
  await deleteTrade(pool, id);
  res.status(204).end();
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    if (req.method === "GET") {
      if (req.query.action === "analytics") return await handleAnalytics(req, res, pool);
      if (req.query.action === "export") return await handleExport(req, res, pool);
      return await handleList(req, res, pool);
    }
    if (req.method === "POST") {
      if (req.query.action === "check-resolutions") return await handleCheckResolutions(req, res, pool);
      if (req.query.action === "resolve") return await handleResolve(req, res, pool);
      return await handleCreate(req, res, pool);
    }
    if (req.method === "DELETE") return await handleDelete(req, res, pool);

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
