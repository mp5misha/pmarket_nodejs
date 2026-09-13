import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, upsertMarket, getMarket, getStats, deleteMarkets } from "../src/db.js";

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
