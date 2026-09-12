import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { api } from "../api.js";

export default function MarketDetail({ market }) {
  const [history, setHistory] = useState(null);
  const [loadingHist, setLoadingHist] = useState(false);
  const [histError, setHistError] = useState(null);

  // Reset the chart whenever a different market is selected
  useEffect(() => {
    setHistory(null);
    setHistError(null);
  }, [market.slug]);

  const loadHistory = async () => {
    setLoadingHist(true);
    setHistError(null);
    try {
      const raw = await api.history(market.slug, "max");
      setHistory(raw.map((p) => ({ time: new Date(p.t * 1000).toLocaleDateString(), price: p.p })));
    } catch (err) {
      setHistError(err.message);
    } finally {
      setLoadingHist(false);
    }
  };

  return (
    <section className="detail">
      <h3>{market.question}</h3>

      <div className="metrics">
        <div className="metric">
          <div className="label">Current price</div>
          <div className="value">
            {market.current_price != null ? Number(market.current_price).toFixed(3) : "—"}
          </div>
        </div>
        <div className="metric">
          <div className="label">Volume</div>
          <div className="value">
            {market.volume != null ? `$${Number(market.volume).toLocaleString()}` : "—"}
          </div>
        </div>
        <div className="metric">
          <div className="label">Liquidity</div>
          <div className="value">
            {market.liquidity != null ? `$${Number(market.liquidity).toLocaleString()}` : "—"}
          </div>
        </div>
        <div className="metric">
          <div className="label">Resolves</div>
          <div className="value" style={{ fontSize: 15 }}>
            {market.resolution_date ? new Date(market.resolution_date).toLocaleDateString() : "—"}
          </div>
        </div>
      </div>

      {market.min_price != null && market.max_price != null && (
        <p className="range-note">
          Stored range: {Number(market.min_price).toFixed(3)} – {Number(market.max_price).toFixed(3)}
        </p>
      )}

      {!history && (
        <button className="btn" onClick={loadHistory} disabled={loadingHist}>
          {loadingHist ? "Loading…" : "Load price history chart"}
        </button>
      )}
      {histError && <p className="sync-error">{histError}</p>}

      {history && history.length > 0 && (
        <div style={{ width: "100%", height: 240, marginTop: 16 }}>
          <ResponsiveContainer>
            <LineChart data={history}>
              <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={30} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} width={36} />
              <Tooltip />
              <Line type="monotone" dataKey="price" stroke="var(--accent)" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
