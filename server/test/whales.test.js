import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, replaceWhalePositions, getStoredWhalePositions } from "../src/db.js";
import { fetchWhalePositions } from "../src/whales.js";

const dbPath = path.join(os.tmpdir(), `whales-test-${Date.now()}-${process.pid}.db`);
let db;
let realFetch;

before(() => {
  db = getDb(dbPath);
  realFetch = global.fetch;
});

after(() => {
  global.fetch = realFetch;
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
});

afterEach(() => {
  global.fetch = realFetch;
});

const SAMPLE_RESULT = {
  positions: [
    {
      conditionId: "cond-1",
      slug: "sample-market",
      eventSlug: "sample-market",
      title: "Sample Market",
      outcome: "Yes",
      size: 100,
      avgPrice: 0.4,
      curPrice: 0.6,
      currentValue: 60,
      cashPnl: 20,
      percentPnl: 0.5,
      traderWallet: "0xsample",
      traderName: "sample_trader",
      traderPnl: 1000,
      traderVolume: 50000,
    },
  ],
  traderCount: 1,
  failedWalletCount: 0,
  fetchedAt: "2024-06-01T00:00:00.000Z",
};

test("getStoredWhalePositions returns null before anything has ever been stored", () => {
  assert.equal(getStoredWhalePositions(db), null);
});

test("replaceWhalePositions persists a snapshot that getStoredWhalePositions round-trips", () => {
  replaceWhalePositions(db, SAMPLE_RESULT);
  const stored = getStoredWhalePositions(db);
  assert.equal(stored.positions.length, 1);
  assert.equal(stored.positions[0].slug, "sample-market");
  assert.equal(stored.positions[0].traderName, "sample_trader");
  assert.equal(stored.traderCount, 1);
  assert.equal(stored.failedWalletCount, 0);
  assert.equal(stored.fetchedAt, "2024-06-01T00:00:00.000Z");
});

test("replaceWhalePositions fully replaces the previous snapshot rather than appending", () => {
  replaceWhalePositions(db, SAMPLE_RESULT);
  replaceWhalePositions(db, {
    positions: [{ ...SAMPLE_RESULT.positions[0], slug: "second-market" }],
    traderCount: 1,
    failedWalletCount: 0,
    fetchedAt: "2024-06-02T00:00:00.000Z",
  });
  const stored = getStoredWhalePositions(db);
  assert.equal(stored.positions.length, 1);
  assert.equal(stored.positions[0].slug, "second-market");
});

test("replaceWhalePositions with zero positions clears the table (getStoredWhalePositions then returns null)", () => {
  replaceWhalePositions(db, SAMPLE_RESULT);
  replaceWhalePositions(db, { positions: [], traderCount: 1, failedWalletCount: 1, fetchedAt: "2024-06-03T00:00:00.000Z" });
  assert.equal(getStoredWhalePositions(db), null);
});

function stubFetch(handler) {
  global.fetch = async (url) => handler(new URL(url));
}

test("fetchWhalePositions persists a fresh rescan to the DB", async () => {
  stubFetch((u) => {
    if (u.pathname === "/v1/leaderboard") {
      return { status: 200, ok: true, json: async () => [{ proxyWallet: "0xfresh", name: "fresh_trader", pnl: 10, vol: 20 }] };
    }
    if (u.pathname === "/positions") {
      return {
        status: 200,
        ok: true,
        json: async () => [
          { conditionId: "c-fresh", slug: "fresh-market", title: "Fresh Market", outcome: "Yes", size: 5, avgPrice: 0.5, curPrice: 0.5, currentValue: 2.5, cashPnl: 0, percentPnl: 0 },
        ],
      };
    }
    throw new Error(`unexpected path ${u.pathname}`);
  });

  const result = await fetchWhalePositions(db, { limit: 1, timePeriod: "TESTA" });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].slug, "fresh-market");

  const stored = getStoredWhalePositions(db);
  assert.equal(stored.positions.length, 1);
  assert.equal(stored.positions[0].slug, "fresh-market");
});

// The "leaderboard/positions call fails outright" fallback paths in
// fetchWhalePositions are exercised via polymarket.js's real getJson, which
// retries 3x with several seconds of backoff on any error — correct, but
// far too slow to run as part of the normal test suite (adds ~10+s per
// failure scenario). That behavior is instead verified with a mocked
// (import-rewritten) copy of whales.js during manual verification passes;
// see the PR/commit notes. What's covered here is the fast, deterministic
// success-path persistence behavior above.
