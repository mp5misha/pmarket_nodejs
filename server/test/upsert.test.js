import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getDb,
  upsertMarket,
  getMarket,
  getStats,
  deleteMarkets,
  queryMarketsGrouped,
  createAnalysis,
  getAnalysis,
  updateAnalysisFairProb,
  createUser,
  createTrade,
  resolveTrade,
  computeInputHash,
  findCachedAnalysis,
  listAnalysesForMarket,
  listTrades,
} from "../src/db.js";

const dbPath = path.join(os.tmpdir(), `upsert-test-${Date.now()}-${process.pid}.db`);
let db;

before(() => {
  db = getDb(dbPath);
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
});

test("upsertMarket inserts a new market", () => {
  upsertMarket(db, {
    slug: "test-slug",
    question: "Q1",
    currentPrice: 0.5,
    noPrice: 0.5,
    volume: 100,
    liquidity: 50,
    active: true,
    closed: false,
    tags: ["a"],
  });
  const row = getMarket(db, "test-slug");
  assert.equal(row.question, "Q1");
  assert.equal(row.current_price, 0.5);
  assert.equal(getStats(db).count, 1);
});

test("upsertMarket on the same slug updates in place — no duplicate row", () => {
  upsertMarket(db, {
    slug: "test-slug",
    question: "Q1 updated",
    currentPrice: 0.7,
    noPrice: 0.3,
    volume: 200,
    liquidity: 75,
    active: true,
    closed: false,
    tags: ["a", "b"],
  });
  assert.equal(getStats(db).count, 1); // still just one row for this slug
  const row = getMarket(db, "test-slug");
  assert.equal(row.question, "Q1 updated");
  assert.equal(row.current_price, 0.7);
  assert.equal(row.volume, 200);
});

test("upsertMarket preserves existing min/max price via COALESCE when not given", () => {
  upsertMarket(
    db,
    { slug: "test-slug", question: "Q1", currentPrice: 0.7, noPrice: 0.3, active: true, closed: false },
    { minPrice: 0.1, maxPrice: 0.9 }
  );
  let row = getMarket(db, "test-slug");
  assert.equal(row.min_price, 0.1);
  assert.equal(row.max_price, 0.9);

  // Re-upsert without passing min/max — the previously-computed range must survive.
  upsertMarket(db, { slug: "test-slug", question: "Q1", currentPrice: 0.8, noPrice: 0.2, active: true, closed: false });
  row = getMarket(db, "test-slug");
  assert.equal(row.min_price, 0.1);
  assert.equal(row.max_price, 0.9);
});

test("upsertMarket preserves yes_token_id via COALESCE when not given", () => {
  upsertMarket(db, {
    slug: "test-slug-2",
    question: "Q2",
    currentPrice: 0.5,
    noPrice: 0.5,
    active: true,
    closed: false,
    yesTokenId: "tok123",
  });
  let row = getMarket(db, "test-slug-2");
  assert.equal(row.yes_token_id, "tok123");

  upsertMarket(db, { slug: "test-slug-2", question: "Q2", currentPrice: 0.6, noPrice: 0.4, active: true, closed: false });
  row = getMarket(db, "test-slug-2");
  assert.equal(row.yes_token_id, "tok123");
});

test("upsertMarket is idempotent when re-run with identical data", () => {
  const before = getStats(db).count;
  for (let i = 0; i < 3; i++) {
    upsertMarket(db, { slug: "test-slug", question: "Q1 updated", currentPrice: 0.7, noPrice: 0.3, active: true, closed: false });
  }
  assert.equal(getStats(db).count, before);
});

test("deleteMarkets removes the given slugs and leaves others untouched", () => {
  upsertMarket(db, { slug: "delete-me-1", question: "D1", currentPrice: 0.5, noPrice: 0.5, active: false, closed: true });
  upsertMarket(db, { slug: "delete-me-2", question: "D2", currentPrice: 0.5, noPrice: 0.5, active: false, closed: true });
  upsertMarket(db, { slug: "keep-me", question: "K", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const deleted = deleteMarkets(db, ["delete-me-1", "delete-me-2"]);
  assert.equal(deleted, 2);
  assert.equal(getMarket(db, "delete-me-1"), undefined);
  assert.equal(getMarket(db, "delete-me-2"), undefined);
  assert.ok(getMarket(db, "keep-me"));
});

test("deleteMarkets on an already-missing slug is a harmless no-op", () => {
  const deleted = deleteMarkets(db, ["never-existed"]);
  assert.equal(deleted, 0);
});

test("status filter treats a past resolution_date as resolved even when closed is stale", () => {
  upsertMarket(db, {
    slug: "stale-resolved",
    question: "Stale resolved market",
    currentPrice: 0.5,
    noPrice: 0.5,
    active: true,
    closed: false, // stale — never re-synced since it resolved
    resolutionDate: "2020-01-01T00:00:00.000Z",
  });
  upsertMarket(db, {
    slug: "truly-active",
    question: "Truly active market",
    currentPrice: 0.5,
    noPrice: 0.5,
    active: true,
    closed: false,
    resolutionDate: "2099-01-01T00:00:00.000Z",
  });

  const activeSlugs = queryMarketsGrouped(db, { status: "active" }).groups.flatMap((g) =>
    g.markets.map((m) => m.slug)
  );
  const resolvedSlugs = queryMarketsGrouped(db, { status: "closed" }).groups.flatMap((g) =>
    g.markets.map((m) => m.slug)
  );
  assert.ok(!activeSlugs.includes("stale-resolved"));
  assert.ok(activeSlugs.includes("truly-active"));
  assert.ok(resolvedSlugs.includes("stale-resolved"));
  assert.ok(!resolvedSlugs.includes("truly-active"));
});

test("queryMarketsGrouped surfaces each market's newest analysis (including follow-ups), scoped per user", () => {
  const owner = createUser(db, { email: "grid-analysis-owner@example.com", passwordHash: "x" });
  const otherUser = createUser(db, { email: "grid-analysis-other@example.com", passwordHash: "x" });

  upsertMarket(db, { slug: "grid-with-analysis", question: "Q1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  upsertMarket(db, { slug: "grid-without-analysis", question: "Q2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  createAnalysis(db, owner.id, {
    marketSlug: "grid-with-analysis",
    promptText: "p1",
    inputHash: "gh1",
    modelName: "m",
    resultText: "Original analysis",
  });
  createAnalysis(db, owner.id, {
    marketSlug: "grid-with-analysis",
    promptText: "p2",
    inputHash: "gh2",
    modelName: "m",
    resultText: "Follow-up final verdict",
  });
  // Another user's analysis on the *other* market must not leak into owner's view.
  createAnalysis(db, otherUser.id, {
    marketSlug: "grid-without-analysis",
    promptText: "p3",
    inputHash: "gh3",
    modelName: "m",
    resultText: "Not this user's",
  });

  const rows = queryMarketsGrouped(db, { userId: owner.id }).groups.flatMap((g) => g.markets);
  const withAnalysis = rows.find((m) => m.slug === "grid-with-analysis");
  const withoutAnalysis = rows.find((m) => m.slug === "grid-without-analysis");

  assert.equal(withAnalysis.last_analysis_text, "Follow-up final verdict");
  assert.equal(withoutAnalysis.last_analysis_text, null);
});

test("queryMarketsGrouped surfaces each market's most recent trade, scoped per user", () => {
  const owner = createUser(db, { email: "grid-trade-owner@example.com", passwordHash: "x" });
  const otherUser = createUser(db, { email: "grid-trade-other@example.com", passwordHash: "x" });

  upsertMarket(db, { slug: "grid-with-trade", question: "Q1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  upsertMarket(db, { slug: "grid-without-trade", question: "Q2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  createTrade(db, owner.id, {
    marketSlug: "grid-with-trade",
    side: "no",
    entryPrice: 0.4,
    stake: 20,
    placedAt: "2024-01-01T00:00:00.000Z",
  });
  createTrade(db, owner.id, {
    marketSlug: "grid-with-trade",
    side: "no",
    entryPrice: 0.654,
    stake: 20,
    placedAt: "2024-02-01T00:00:00.000Z",
  });
  // Another user's trade on the *other* market must not leak into owner's view.
  createTrade(db, otherUser.id, {
    marketSlug: "grid-without-trade",
    side: "yes",
    entryPrice: 0.3,
    stake: 10,
    placedAt: "2024-01-01T00:00:00.000Z",
  });

  const rows = queryMarketsGrouped(db, { userId: owner.id }).groups.flatMap((g) => g.markets);
  const withTrade = rows.find((m) => m.slug === "grid-with-trade");
  const withoutTrade = rows.find((m) => m.slug === "grid-without-trade");

  // The later of the two trades on the same market wins.
  assert.equal(withTrade.my_trade_side, "no");
  assert.equal(withTrade.my_trade_entry_price, 0.654);
  assert.equal(withTrade.my_trade_stake, 20);
  assert.equal(withoutTrade.my_trade_id, null);

  const onlyMine = queryMarketsGrouped(db, { userId: owner.id, hasTrade: true }).groups.flatMap((g) => g.markets);
  assert.ok(onlyMine.some((m) => m.slug === "grid-with-trade"));
  assert.ok(!onlyMine.some((m) => m.slug === "grid-without-trade"));
});

test("queryMarketsGrouped reports a resolved trade's stored profit rather than a live estimate", () => {
  const owner = createUser(db, { email: "grid-trade-resolved@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "grid-resolved-trade", question: "Q3", currentPrice: 0.9, noPrice: 0.1, active: false, closed: true });

  const trade = createTrade(db, owner.id, {
    marketSlug: "grid-resolved-trade",
    side: "yes",
    entryPrice: 0.5,
    stake: 10,
    placedAt: "2024-01-01T00:00:00.000Z",
  });
  resolveTrade(db, trade.id, { status: "won", payout: 20, profit: 10 });

  const rows = queryMarketsGrouped(db, { userId: owner.id }).groups.flatMap((g) => g.markets);
  const row = rows.find((m) => m.slug === "grid-resolved-trade");
  assert.equal(row.my_trade_status, "won");
  assert.equal(row.my_trade_profit, 10);
});

test("queryMarketsGrouped annotates is_whale_market on every row when whaleSlugs is given, without filtering", () => {
  upsertMarket(db, { slug: "whale-held-market", question: "WQ1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  upsertMarket(db, { slug: "whale-free-market", question: "WQ2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const rows = queryMarketsGrouped(db, { whaleSlugs: ["whale-held-market", "some-other-slug"] }).groups.flatMap(
    (g) => g.markets
  );
  const held = rows.find((m) => m.slug === "whale-held-market");
  const free = rows.find((m) => m.slug === "whale-free-market");
  assert.equal(held.is_whale_market, 1);
  assert.equal(free.is_whale_market, 0);
});

test("queryMarketsGrouped's onlyWhaleMarkets filters to just the given slugs", () => {
  upsertMarket(db, { slug: "whale-filter-held", question: "WF1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  upsertMarket(db, { slug: "whale-filter-free", question: "WF2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const filtered = queryMarketsGrouped(db, { whaleSlugs: ["whale-filter-held"], onlyWhaleMarkets: true }).groups.flatMap(
    (g) => g.markets
  );
  assert.ok(filtered.some((m) => m.slug === "whale-filter-held"));
  assert.ok(!filtered.some((m) => m.slug === "whale-filter-free"));
});

test("queryMarketsGrouped's onlyWhaleMarkets with an empty whaleSlugs list returns zero matches, not everything", () => {
  upsertMarket(db, { slug: "whale-empty-check", question: "WE1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  const filtered = queryMarketsGrouped(db, { whaleSlugs: [], onlyWhaleMarkets: true }).groups.flatMap((g) => g.markets);
  assert.equal(filtered.length, 0);
});

test("queryMarketsGrouped without whaleSlugs leaves is_whale_market unset (backwards compatible)", () => {
  upsertMarket(db, { slug: "no-whale-param-market", question: "NW1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  const rows = queryMarketsGrouped(db, {}).groups.flatMap((g) => g.markets);
  const row = rows.find((m) => m.slug === "no-whale-param-market");
  assert.equal(row.is_whale_market, undefined);
});

test("createAnalysis/findCachedAnalysis/listAnalysesForMarket keep 'market' and 'whales' kinds in separate streams", () => {
  const owner = createUser(db, { email: "analysis-kind-owner@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "kind-test-market", question: "K1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const marketHash = computeInputHash({ marketSlug: "kind-test-market", promptText: "same text", modelName: "m", kind: "market" });
  const whaleHash = computeInputHash({ marketSlug: "kind-test-market", promptText: "same text", modelName: "m", kind: "whales" });
  assert.notEqual(marketHash, whaleHash, "the kind must be part of the cache key, even with identical prompt text");

  createAnalysis(db, owner.id, {
    marketSlug: "kind-test-market",
    promptText: "same text",
    inputHash: marketHash,
    modelName: "m",
    resultText: "market-kind result",
    kind: "market",
  });
  createAnalysis(db, owner.id, {
    marketSlug: "kind-test-market",
    promptText: "same text",
    inputHash: whaleHash,
    modelName: "m",
    resultText: "whales-kind result",
    kind: "whales",
  });

  const marketList = listAnalysesForMarket(db, owner.id, "kind-test-market", "market");
  const whaleList = listAnalysesForMarket(db, owner.id, "kind-test-market", "whales");
  assert.equal(marketList.length, 1);
  assert.equal(marketList[0].result_text, "market-kind result");
  assert.equal(whaleList.length, 1);
  assert.equal(whaleList[0].result_text, "whales-kind result");

  // A cache lookup for one kind must never be satisfied by the other kind's
  // row, even though they'd otherwise share every other input.
  assert.equal(findCachedAnalysis(db, owner.id, marketHash, "market").result_text, "market-kind result");
  assert.equal(findCachedAnalysis(db, owner.id, whaleHash, "whales").result_text, "whales-kind result");
  assert.equal(findCachedAnalysis(db, owner.id, marketHash, "whales"), undefined);
});

test("listAnalysesForMarket defaults to kind='market', matching createAnalysis's default", () => {
  const owner = createUser(db, { email: "analysis-kind-default@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "kind-default-market", question: "K2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });
  createAnalysis(db, owner.id, {
    marketSlug: "kind-default-market",
    promptText: "p",
    inputHash: "kd1",
    modelName: "m",
    resultText: "default-kind result",
  });
  const rows = listAnalysesForMarket(db, owner.id, "kind-default-market");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "market");
});

test("queryMarketsGrouped surfaces the latest market-kind analysis's fair_prob_yes, ignoring whale-kind rows", () => {
  const owner = createUser(db, { email: "fair-prob-owner@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "fair-prob-market", question: "F1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  createAnalysis(db, owner.id, {
    marketSlug: "fair-prob-market",
    promptText: "p1",
    inputHash: "fp1",
    modelName: "m",
    resultText: "r1",
    kind: "market",
    fairProbYes: 0.42,
  });
  // A whale-kind analysis (even with a later timestamp implicitly, since
  // it's inserted after) must never leak into the market-kind fair-prob column.
  createAnalysis(db, owner.id, {
    marketSlug: "fair-prob-market",
    promptText: "p2",
    inputHash: "fp2",
    modelName: "m",
    resultText: "r2",
    kind: "whales",
    fairProbYes: 0.99,
  });

  const rows = queryMarketsGrouped(db, { userId: owner.id }).groups.flatMap((g) => g.markets);
  const row = rows.find((m) => m.slug === "fair-prob-market");
  assert.equal(row.fair_prob_yes, 0.42);
});

test("queryMarketsGrouped's fair_prob_yes survives a follow-up that didn't restate one", () => {
  const owner = createUser(db, { email: "fair-prob-followup@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "fair-prob-followup-market", question: "F2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const original = createAnalysis(db, owner.id, {
    marketSlug: "fair-prob-followup-market",
    promptText: "p1",
    inputHash: "fpf1",
    modelName: "m",
    resultText: "original, with a fair prob",
    kind: "market",
    fairProbYes: 0.7,
  });
  // A follow-up row — fairProbYes omitted, as the real route does (see
  // server/src/index.js's follow-up route), and it's the newest row.
  createAnalysis(db, owner.id, {
    marketSlug: "fair-prob-followup-market",
    promptText: "a follow-up question",
    inputHash: "fpf2",
    modelName: "m",
    resultText: "follow-up reply, no fair prob restated",
    kind: "market",
    parentAnalysisId: original.id,
  });

  const rows = queryMarketsGrouped(db, { userId: owner.id }).groups.flatMap((g) => g.markets);
  const row = rows.find((m) => m.slug === "fair-prob-followup-market");
  // last_analysis_text reflects the newest row (the follow-up)...
  assert.equal(row.last_analysis_text, "follow-up reply, no fair prob restated");
  // ...but fair_prob_yes still reflects the last row that actually had one.
  assert.equal(row.fair_prob_yes, 0.7);
});

test("updateAnalysisFairProb overwrites fair_prob_yes on the given row and is reflected by queryMarketsGrouped", () => {
  const owner = createUser(db, { email: "parse-fair-prob@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "parse-fair-prob-market", question: "PF1", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const analysis = createAnalysis(db, owner.id, {
    marketSlug: "parse-fair-prob-market",
    promptText: "p1",
    inputHash: "pfp1",
    modelName: "m",
    resultText: "an older analysis, run before FAIR_PROBABILITY_YES existed",
    kind: "market",
    // fairProbYes omitted — the scenario "Parse the AI response" backfills.
  });
  assert.equal(analysis.fair_prob_yes, null);

  const updated = updateAnalysisFairProb(db, owner.id, analysis.id, 0.81);
  assert.equal(updated.fair_prob_yes, 0.81);
  assert.equal(getAnalysis(db, owner.id, analysis.id).fair_prob_yes, 0.81);

  const rows = queryMarketsGrouped(db, { userId: owner.id }).groups.flatMap((g) => g.markets);
  assert.equal(rows.find((m) => m.slug === "parse-fair-prob-market").fair_prob_yes, 0.81);
});

test("updateAnalysisFairProb is scoped to user_id — cannot overwrite another user's analysis", () => {
  const owner = createUser(db, { email: "parse-fair-prob-owner2@example.com", passwordHash: "x" });
  const intruder = createUser(db, { email: "parse-fair-prob-intruder@example.com", passwordHash: "x" });
  upsertMarket(db, { slug: "parse-fair-prob-market2", question: "PF2", currentPrice: 0.5, noPrice: 0.5, active: true, closed: false });

  const analysis = createAnalysis(db, owner.id, {
    marketSlug: "parse-fair-prob-market2",
    promptText: "p1",
    inputHash: "pfp2",
    modelName: "m",
    resultText: "owner's analysis",
    kind: "market",
  });

  const result = updateAnalysisFairProb(db, intruder.id, analysis.id, 0.55);
  assert.equal(result, undefined);
  assert.equal(getAnalysis(db, owner.id, analysis.id).fair_prob_yes, null);
});

test("listTrades includes the market's live current/no price and resolution date via a LEFT JOIN, surviving a deleted market", () => {
  const owner = createUser(db, { email: "listtrades-price-owner@example.com", passwordHash: "x" });
  upsertMarket(db, {
    slug: "listtrades-price-market",
    question: "L1",
    currentPrice: 0.65,
    noPrice: 0.35,
    active: true,
    closed: false,
    resolutionDate: "2026-12-31T00:00:00.000Z",
  });
  createTrade(db, owner.id, {
    marketSlug: "listtrades-price-market",
    side: "yes",
    entryPrice: 0.5,
    stake: 10,
    placedAt: "2024-01-01T00:00:00.000Z",
  });
  createTrade(db, owner.id, {
    marketSlug: "listtrades-deleted-market",
    side: "yes",
    entryPrice: 0.5,
    stake: 10,
    placedAt: "2024-01-01T00:00:00.000Z",
  });

  const rows = listTrades(db, { userId: owner.id });
  const withMarket = rows.find((t) => t.market_slug === "listtrades-price-market");
  const withoutMarket = rows.find((t) => t.market_slug === "listtrades-deleted-market");

  assert.equal(withMarket.market_current_price, 0.65);
  assert.equal(withMarket.market_no_price, 0.35);
  assert.equal(withMarket.market_resolution_date, "2026-12-31T00:00:00.000Z");
  // A trade whose market isn't in the local catalog (e.g. deleted) must
  // still be returned — just with null prices/date, not dropped by the join.
  assert.ok(withoutMarket);
  assert.equal(withoutMarket.market_current_price, null);
  assert.equal(withoutMarket.market_resolution_date, null);
});
