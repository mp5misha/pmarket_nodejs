import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTradeOutcome, winningSideFromPrice } from "../src/pnl.js";

test("resolveTradeOutcome: a Yes buy that wins", () => {
  const result = resolveTradeOutcome({ side: "yes", entryPrice: 0.5, stake: 100, winningSide: "yes" });
  assert.equal(result.status, "won");
  assert.equal(result.payout, 200);
  assert.equal(result.profit, 100);
});

test("resolveTradeOutcome: a Yes buy that loses", () => {
  const result = resolveTradeOutcome({ side: "yes", entryPrice: 0.5, stake: 100, winningSide: "no" });
  assert.equal(result.status, "lost");
  assert.equal(result.payout, 0);
  assert.equal(result.profit, -100);
});

test("resolveTradeOutcome: a No buy that wins", () => {
  const result = resolveTradeOutcome({ side: "no", entryPrice: 0.4, stake: 80, winningSide: "no" });
  assert.equal(result.status, "won");
  assert.equal(result.payout, 200);
  assert.equal(result.profit, 120);
});

test("resolveTradeOutcome: a No buy that loses", () => {
  const result = resolveTradeOutcome({ side: "no", entryPrice: 0.4, stake: 80, winningSide: "yes" });
  assert.equal(result.status, "lost");
  assert.equal(result.payout, 0);
  assert.equal(result.profit, -80);
});

test("winningSideFromPrice: settled to Yes", () => {
  assert.equal(winningSideFromPrice(1.0), "yes");
  assert.equal(winningSideFromPrice(0.995), "yes");
});

test("winningSideFromPrice: settled to No", () => {
  assert.equal(winningSideFromPrice(0.0), "no");
  assert.equal(winningSideFromPrice(0.005), "no");
});

test("winningSideFromPrice: not yet settled (or unknown)", () => {
  assert.equal(winningSideFromPrice(0.5), null);
  assert.equal(winningSideFromPrice(null), null);
});
