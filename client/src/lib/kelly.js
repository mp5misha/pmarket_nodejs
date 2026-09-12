// Phase 6: bet-size suggestions. All three methods return the same shape
// so the UI can render an auditable breakdown regardless of which is used.

// Fractional Kelly for a prediction-market share bought at `price` (0-1),
// believed to resolve true with probability `estimatedProb` (0-1):
//   full Kelly fraction f* = (estimatedProb - price) / (1 - price)
// (the standard binary-Kelly formula f* = (bp - q) / b collapses to this
// when the payout odds b = (1 - price) / price, i.e. a $1 payout per share
// bought at `price`). `kellyFraction` (e.g. 0.25) scales the full-Kelly
// fraction down; negative edges clamp to a $0 suggestion rather than
// suggesting betting against your own edge.
export function kellyStake({ estimatedProb, price, bankroll, kellyFraction }) {
  const edge = estimatedProb - price;
  const fullKellyFraction = price >= 1 ? 0 : edge / (1 - price);
  const appliedFraction = Math.max(0, fullKellyFraction * kellyFraction);
  const stake = appliedFraction * bankroll;
  return {
    method: "kelly",
    edge,
    fullKellyFraction,
    appliedFraction,
    stake,
  };
}

export function flatStake({ flatStakeAmount }) {
  return { method: "flat", stake: flatStakeAmount };
}

export function fixedPercentageStake({ bankroll, fixedPercentagePct }) {
  const appliedFraction = fixedPercentagePct / 100;
  return { method: "fixed-percentage", appliedFraction, stake: appliedFraction * bankroll };
}
