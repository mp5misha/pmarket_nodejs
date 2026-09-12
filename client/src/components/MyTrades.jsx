import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";
import { api } from "../api.js";

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

function fmtMoney(v, currency = "USD") {
  if (v === null || v === undefined) return "—";
  return `${currency === "USD" ? "$" : currency + " "}${Number(v).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

// Phase 5: manually-recorded trades, resolved automatically by the server's
// in-process checker once their market closes. Phase 7 adds the bankroll
// dashboard and ledger above the trades table — both draw on the same
// trades/ledger data, just from a market-independent, filter-independent
// angle (the dashboard always reflects every trade, not just the current
// status tab).
export default function MyTrades() {
  const [status, setStatus] = useState("");
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState(null);

  const [analytics, setAnalytics] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [showLedger, setShowLedger] = useState(false);
  const [ledgerType, setLedgerType] = useState("deposit");
  const [ledgerAmount, setLedgerAmount] = useState("");
  const [ledgerNote, setLedgerNote] = useState("");
  const [savingLedger, setSavingLedger] = useState(false);
  const [ledgerError, setLedgerError] = useState(null);

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

  const refreshDashboard = async () => {
    try {
      setDashboard(await api.getBankrollDashboard());
    } catch {
      setDashboard(null);
    }
  };

  const refreshAnalytics = async () => {
    try {
      setAnalytics(await api.getTradeAnalytics());
    } catch {
      setAnalytics(null);
    }
  };

  const refreshLedger = async () => {
    try {
      setLedger(await api.listBankrollLedger(50));
    } catch {
      setLedger([]);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    refreshDashboard();
    refreshLedger();
    refreshAnalytics();
  }, []);

  const checkNow = async () => {
    setChecking(true);
    setCheckNote(null);
    try {
      const result = await api.checkTradeResolutions();
      setCheckNote(`Checked ${result.checked} market(s), resolved ${result.resolved} trade(s).`);
      await Promise.all([refresh(), refreshDashboard(), refreshLedger(), refreshAnalytics()]);
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
      await Promise.all([refreshDashboard(), refreshLedger(), refreshAnalytics()]);
    } catch {
      /* non-fatal */
    }
  };

  const addLedgerEntry = async () => {
    const amount = Number(ledgerAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setLedgerError("Amount must be a positive number");
      return;
    }
    setSavingLedger(true);
    setLedgerError(null);
    try {
      await api.addLedgerEntry({ entryType: ledgerType, amount, note: ledgerNote.trim() || undefined });
      setLedgerAmount("");
      setLedgerNote("");
      await Promise.all([refreshDashboard(), refreshLedger()]);
    } catch (err) {
      setLedgerError(err.message);
    } finally {
      setSavingLedger(false);
    }
  };

  const currency = dashboard?.currency || "USD";

  return (
    <div className="my-trades">
      <h2>My Trades</h2>

      {dashboard && (
        <div className="bankroll-dashboard">
          <div className="bankroll-metric">
            <div className="label">Bankroll</div>
            <div className="value">{fmtMoney(dashboard.balance, currency)}</div>
          </div>
          <div className="bankroll-metric">
            <div className="label">Staked ({dashboard.openTradeCount} open)</div>
            <div className="value">{fmtMoney(dashboard.staked, currency)}</div>
          </div>
          <div className="bankroll-metric">
            <div className="label">Realized P&amp;L</div>
            <div className={`value ${dashboard.realizedPnl >= 0 ? "trades-profit-positive" : "trades-profit-negative"}`}>
              {fmtMoney(dashboard.realizedPnl, currency)}
            </div>
          </div>
          <div className="bankroll-metric">
            <div className="label">Exposure</div>
            <div className="value">{dashboard.exposurePct.toFixed(1)}%</div>
          </div>
          <div className="bankroll-actions">
            <button className="btn btn-small btn-ghost" onClick={checkNow} disabled={checking}>
              {checking ? "Checking…" : "Check resolutions now"}
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => setShowLedger((v) => !v)}>
              {showLedger ? "Hide ledger" : "Show ledger"}
            </button>
          </div>
        </div>
      )}
      {checkNote && <p className="discovery-note">{checkNote}</p>}

      {showLedger && (
        <div className="bankroll-ledger-panel">
          <div className="discovery-form" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
            <div className="field">
              <label>Type</label>
              <select value={ledgerType} onChange={(e) => setLedgerType(e.target.value)}>
                <option value="deposit">Deposit</option>
                <option value="withdrawal">Withdrawal</option>
              </select>
            </div>
            <div className="field">
              <label>Amount ($)</label>
              <input type="number" min={0} value={ledgerAmount} onChange={(e) => setLedgerAmount(e.target.value)} />
            </div>
            <div className="field">
              <label>Note (optional)</label>
              <input type="text" value={ledgerNote} onChange={(e) => setLedgerNote(e.target.value)} />
            </div>
            <div className="discovery-actions">
              <button className="btn btn-small" onClick={addLedgerEntry} disabled={savingLedger || !ledgerAmount}>
                {savingLedger ? "Saving…" : "Add entry"}
              </button>
            </div>
          </div>
          {ledgerError && <p className="sync-error">{ledgerError}</p>}

          {ledger.length === 0 ? (
            <p className="discovery-note">No ledger entries yet.</p>
          ) : (
            <table className="discovery-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Trade</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td>{new Date(l.created_at).toLocaleString()}</td>
                    <td>{l.entry_type}</td>
                    <td>{fmtMoney(l.amount, currency)}</td>
                    <td>{l.trade_id ?? "—"}</td>
                    <td className="discovery-filters-cell" title={l.note || ""}>
                      {l.note || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {analytics && analytics.totalTrades > 0 && (
        <div className="profitability-section">
          <div className="profitability-header">
            <h3>Profitability</h3>
            <a className="btn btn-small btn-ghost" href={api.tradesExportUrl()}>
              Export CSV
            </a>
          </div>

          <div className="bankroll-dashboard">
            <div className="bankroll-metric">
              <div className="label">ROI</div>
              <div className={`value ${analytics.roi >= 0 ? "trades-profit-positive" : "trades-profit-negative"}`}>
                {analytics.roi != null ? `${(analytics.roi * 100).toFixed(1)}%` : "—"}
              </div>
            </div>
            <div className="bankroll-metric">
              <div className="label">Win rate</div>
              <div className="value">
                {analytics.winRate != null ? `${(analytics.winRate * 100).toFixed(1)}%` : "—"}
              </div>
            </div>
            <div className="bankroll-metric">
              <div className="label">Avg. edge ({analytics.withEstimateCount} w/ estimate)</div>
              <div className="value">
                {analytics.avgEdge != null ? `${(analytics.avgEdge * 100).toFixed(1)}pp` : "—"}
              </div>
            </div>
            <div className="bankroll-metric">
              <div className="label">Brier score</div>
              <div className="value">{analytics.brierScore != null ? analytics.brierScore.toFixed(3) : "—"}</div>
            </div>
          </div>

          {analytics.pnlOverTime.length > 1 && (
            <div className="chart-block">
              <p className="chart-title">Cumulative P&amp;L over time</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={analytics.pnlOverTime}>
                  <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(d) => new Date(d).toLocaleDateString()}
                    minTickGap={40}
                  />
                  <YAxis tick={{ fontSize: 11 }} width={50} />
                  <Tooltip
                    labelFormatter={(d) => new Date(d).toLocaleString()}
                    formatter={(v) => [`$${Number(v).toFixed(2)}`, "Cumulative P&L"]}
                  />
                  <Line type="monotone" dataKey="cumulativeProfit" stroke="var(--accent)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {analytics.pnlByCategory.length > 0 && (
            <div className="chart-block">
              <p className="chart-title">P&amp;L by category</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.pnlByCategory}>
                  <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
                  <XAxis dataKey="category" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={50} />
                  <Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, "P&L"]} />
                  <Bar dataKey="profit">
                    {analytics.pnlByCategory.map((entry, i) => (
                      <Cell key={i} fill={entry.profit >= 0 ? "var(--up)" : "var(--down)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {analytics.calibration.length > 0 && (
            <div className="chart-block">
              <p className="chart-title">
                Calibration — predicted vs. actual win rate by estimated-probability bucket
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={analytics.calibration}>
                  <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} width={40} />
                  <Tooltip formatter={(v) => `${(Number(v) * 100).toFixed(0)}%`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="predicted" name="Predicted (avg. estimate)" stroke="var(--accent)" strokeWidth={2} />
                  <Line type="monotone" dataKey="actual" name="Actual win rate" stroke="var(--up)" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

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
                <td>{fmtMoney(t.stake, currency)}</td>
                <td>{t.status}</td>
                <td>{fmtMoney(t.payout, currency)}</td>
                <td className={t.profit > 0 ? "trades-profit-positive" : t.profit < 0 ? "trades-profit-negative" : ""}>
                  {t.profit != null ? fmtMoney(t.profit, currency) : "—"}
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
