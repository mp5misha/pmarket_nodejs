import { test } from "node:test";
import assert from "node:assert/strict";
import { kellyStake, flatStake, fixedPercentageStake } from "./kelly.js";

test("kellyStake computes edge, full-Kelly fraction, and the suggested stake", () => {
  const result = kellyStake({ estimatedProb: 0.75, price: 0.62, bankroll: 1000, kellyFraction: 0.25 });
  assert.ok(Math.abs(result.edge - 0.13) < 1e-9);
  assert.ok(Math.abs(result.fullKellyFraction - 0.34210526315789475) < 1e-9);
  assert.ok(Math.abs(result.appliedFraction - 0.08552631578947369) < 1e-9);
  assert.ok(Math.abs(result.stake - 85.52631578947368) < 1e-6);
});

test("kellyStake clamps a negative edge to a $0 suggestion instead of betting against your own edge", () => {
  const result = kellyStake({ estimatedProb: 0.5, price: 0.62, bankroll: 1000, kellyFraction: 0.25 });
  assert.ok(result.edge < 0);
  assert.equal(result.appliedFraction, 0);
  assert.equal(result.stake, 0);
});

test("kellyStake with zero edge (estimate equals price) suggests zero stake", () => {
  const result = kellyStake({ estimatedProb: 0.62, price: 0.62, bankroll: 1000, kellyFraction: 0.25 });
  assert.equal(result.edge, 0);
  assert.equal(result.stake, 0);
});

test("kellyStake scales linearly with kellyFraction", () => {
  const quarter = kellyStake({ estimatedProb: 0.75, price: 0.62, bankroll: 1000, kellyFraction: 0.25 });
  const half = kellyStake({ estimatedProb: 0.75, price: 0.62, bankroll: 1000, kellyFraction: 0.5 });
  assert.ok(Math.abs(half.stake - quarter.stake * 2) < 1e-6);
});

test("flatStake always returns the configured amount regardless of other inputs", () => {
  assert.equal(flatStake({ flatStakeAmount: 50 }).stake, 50);
  assert.equal(flatStake({ flatStakeAmount: 0 }).stake, 0);
});

test("fixedPercentageStake computes a percentage of bankroll", () => {
  const result = fixedPercentageStake({ bankroll: 1000, fixedPercentagePct: 2 });
  assert.equal(result.appliedFraction, 0.02);
  assert.equal(result.stake, 20);
});
