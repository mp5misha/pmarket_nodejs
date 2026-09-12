// Per-trade profit & loss (Phase 9, formula fixed since Phase 5): a share
// bought at `entryPrice` pays out $1 on a win, so staking `stake` buys
// stake/entryPrice shares — payout = stake/entryPrice if the trade's side
// won, else 0; profit = payout - stake.
export function resolveTradeOutcome({ side, entryPrice, stake, winningSide }) {
  const won = side === winningSide;
  const payout = won ? stake / entryPrice : 0;
  const profit = payout - stake;
  return { status: won ? "won" : "lost", payout, profit };
}

// A market is treated as resolved once its Yes price has settled to (near)
// 0 or 1, matching how Polymarket's Gamma API represents a final outcome.
export function winningSideFromPrice(currentPrice) {
  if (currentPrice == null) return null;
  if (currentPrice >= 0.99) return "yes";
  if (currentPrice <= 0.01) return "no";
  return null;
}
