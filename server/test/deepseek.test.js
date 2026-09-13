import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFairProbability,
  buildAnalysisPrompt,
  buildWhaleAnalysisPrompt,
  DEFAULT_WHALE_PROMPT_TEMPLATE,
} from "../src/deepseek.js";

test("extractFairProbability parses a well-formed line", () => {
  assert.equal(extractFairProbability("Some analysis text.\n\nFAIR_PROBABILITY_YES: 0.62"), 0.62);
});

test("extractFairProbability is case-insensitive and tolerates surrounding text", () => {
  assert.equal(extractFairProbability("blah\nfair_probability_yes: 0.4\nmore"), 0.4);
});

test("extractFairProbability accepts 0 and 1 exactly", () => {
  assert.equal(extractFairProbability("FAIR_PROBABILITY_YES: 0"), 0);
  assert.equal(extractFairProbability("FAIR_PROBABILITY_YES: 1"), 1);
});

test("extractFairProbability accepts a leading-dot decimal", () => {
  assert.equal(extractFairProbability("FAIR_PROBABILITY_YES: .35"), 0.35);
});

test("extractFairProbability returns null when the line is missing", () => {
  assert.equal(extractFairProbability("Just a normal analysis with no marker line."), null);
});

test("extractFairProbability returns null for out-of-range or malformed numbers", () => {
  assert.equal(extractFairProbability("FAIR_PROBABILITY_YES: 1.5"), null);
  assert.equal(extractFairProbability("FAIR_PROBABILITY_YES: -0.2"), null);
});

test("extractFairProbability returns null for empty/null input", () => {
  assert.equal(extractFairProbability(""), null);
  assert.equal(extractFairProbability(null), null);
  assert.equal(extractFairProbability(undefined), null);
});

test("buildAnalysisPrompt appends the fair-probability instruction regardless of template content", () => {
  const prompt = buildAnalysisPrompt({ slug: "test-market", current_price: 0.5, no_price: 0.5 }, "Analyze {slug}.");
  assert.ok(prompt.includes("Analyze test-market."));
  assert.ok(prompt.includes("FAIR_PROBABILITY_YES"));
});

test("buildWhaleAnalysisPrompt substitutes {slug} and numbers each whale position consistently across all four lists", () => {
  const market = { slug: "whale-test-market" };
  const positions = [
    { traderName: "orca_capital", outcome: "Yes", currentValue: 11600, cashPnl: 4600, percentPnl: 0.657 },
    { traderWallet: "0x1234567890abcdef1234567890abcdef12345678", traderName: null, outcome: "No", currentValue: 2100, cashPnl: -900, percentPnl: -0.3 },
  ];
  const prompt = buildWhaleAnalysisPrompt(market, positions, DEFAULT_WHALE_PROMPT_TEMPLATE);

  assert.ok(prompt.includes("whale-test-market"));
  // Row 1: named trader.
  assert.ok(prompt.includes("1. orca_capital"));
  // Row 2: no display name -> shortened wallet fallback, same numbering.
  assert.ok(prompt.includes("2. 0x1234…5678"));
  assert.ok(prompt.includes("1. Yes"));
  assert.ok(prompt.includes("2. No"));
  assert.ok(prompt.includes("1. $11,600"));
  assert.ok(prompt.includes("2. $2,100"));
  assert.ok(prompt.includes("1. $4,600 (65.7%)"));
  assert.ok(prompt.includes("2. $-900 (-30.0%)"));
});

test("buildWhaleAnalysisPrompt handles a single whale position", () => {
  const market = { slug: "single-whale-market" };
  const positions = [{ traderName: "macro_mike", outcome: "Yes", currentValue: 1260, cashPnl: 0, percentPnl: 0 }];
  const prompt = buildWhaleAnalysisPrompt(market, positions);
  assert.ok(prompt.includes("1. macro_mike"));
  assert.ok(prompt.includes("1. Yes"));
  assert.ok(prompt.includes("1. $1,260"));
  assert.ok(prompt.includes("1. $0 (0.0%)"));
});
