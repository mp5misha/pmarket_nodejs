import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchMarketBySlug } from "../src/polymarket.js";

let realFetch;

afterEach(() => {
  if (realFetch) global.fetch = realFetch;
});

function stubFetch(handler) {
  realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    return handler(new URL(url), calls);
  };
  return () => calls;
}

// The single-trade "Resolve" button passes { retries: 1 } specifically so a
// persistently-failing Polymarket call fails fast instead of paying getJson's
// full 3-retry exponential-backoff tax (worst case ~14s — long enough to
// make the button look hung, and on Vercel's Hobby plan long enough to
// outlive the serverless function's execution budget outright). This is the
// behavior that regression covers; the *default* multi-retry path is
// exercised manually rather than here — see whales.test.js's stubFetch note
// on why a real backoff-timed test is deliberately kept out of the suite.
test("fetchMarketBySlug with retries: 1 makes exactly one request and rejects immediately on persistent failure", async () => {
  const getCalls = stubFetch(() => {
    throw new Error("simulated network failure");
  });

  const start = Date.now();
  await assert.rejects(() => fetchMarketBySlug("some-slug", { retries: 1 }));
  const elapsed = Date.now() - start;

  assert.equal(getCalls(), 1);
  // No backoff sleep should occur after the only (and therefore last)
  // attempt — generous bound well under RETRY_BACKOFF_MS (2000ms).
  assert.ok(elapsed < 500, `expected a fast failure, took ${elapsed}ms`);
});

test("fetchMarketBySlug with retries: 1 still succeeds normally on a healthy response", async () => {
  const getCalls = stubFetch((u) => {
    assert.equal(u.searchParams.get("slug"), "healthy-slug");
    return { status: 200, ok: true, json: async () => [{ slug: "healthy-slug", question: "Q?" }] };
  });

  const market = await fetchMarketBySlug("healthy-slug", { retries: 1 });
  assert.equal(market.slug, "healthy-slug");
  assert.equal(getCalls(), 1);
});

test("fetchMarketBySlug with no retries option (default) still succeeds normally on a healthy response", async () => {
  const getCalls = stubFetch(() => ({
    status: 200,
    ok: true,
    json: async () => [{ slug: "default-slug" }],
  }));

  const market = await fetchMarketBySlug("default-slug");
  assert.equal(market.slug, "default-slug");
  assert.equal(getCalls(), 1);
});
