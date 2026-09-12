import { useEffect, useState } from "react";
import { api } from "../api.js";

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// Phase 5: manually-recorded trades, resolved automatically by the server's
// in-process checker once their market closes. This view lists them with
// their P&L and lets you trigger an immediate resolution check instead of
// waiting for the next scheduled poll.
export default function MyTrades() {
  const [status, setStatus] = useState("");
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setTrades(await api.listTrades({ status: status || undefined }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const checkNow = async () => {
    setChecking(true);
    setCheckNote(null);
    try {
      const result = await api.checkTradeResolutions();
      setCheckNote(`Checked ${result.checked} market(s), resolved ${result.resolved} trade(s).`);
      refresh();
    } catch (err) {
      setCheckNote(err.message);
    } finally {
      setChecking(false);
    }
  };

  const removeTrade = async (id) => {
    try {
      await api.deleteTrade(id);
      setTrades((prev) => prev.filter((t) => t.id !== id));
    } catch {
      /* non-fatal */
    }
  };

  const openCount = trades.filter((t) => t.status === "open").length;
  const totalProfit = trades.reduce((sum, t) => sum + (t.profit ?? 0), 0);

  return (
    <div className="my-trades">
      <h2>My Trades</h2>

      <div className="view-switcher trades-status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            className={`view-tab ${status === t.value ? "active" : ""}`}
            onClick={() => setStatus(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="trades-summary">
        <span>{trades.length} trade(s)</span>
        <span>{openCount} open</span>
        <span className={totalProfit >= 0 ? "trades-profit-positive" : "trades-profit-negative"}>
          Net P&amp;L: {fmtMoney(totalProfit)}
        </span>
        <button className="btn btn-small btn-ghost" onClick={checkNow} disabled={checking}>
          {checking ? "Checking…" : "Check resolutions now"}
        </button>
      </div>
      {checkNote && <p className="discovery-note">{checkNote}</p>}
      {error && <p className="sync-error">{error}</p>}

      {loading ? (
        <p className="discovery-note">Loading…</p>
      ) : trades.length === 0 ? (
        <div className="empty-state">
          No trades recorded yet. Use <strong>Mark as traded</strong> on a market's detail panel.
        </div>
      ) : (
        <table className="discovery-table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Side</th>
              <th>Entry price</th>
              <th>Stake</th>
              <th>Status</th>
              <th>Payout</th>
              <th>Profit</th>
              <th>Placed</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id}>
                <td>{t.market_slug}</td>
                <td>{t.side.toUpperCase()}</td>
                <td>{Number(t.entry_price).toFixed(3)}</td>
                <td>{fmtMoney(t.stake)}</td>
                <td>{t.status}</td>
                <td>{fmtMoney(t.payout)}</td>
                <td className={t.profit > 0 ? "trades-profit-positive" : t.profit < 0 ? "trades-profit-negative" : ""}>
                  {t.profit != null ? fmtMoney(t.profit) : "—"}
                </td>
                <td>{new Date(t.placed_at).toLocaleString()}</td>
                <td className="discovery-filters-cell" title={t.note || ""}>
                  {t.note || "—"}
                </td>
                <td>
                  <button className="btn btn-small btn-ghost" onClick={() => removeTrade(t.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
