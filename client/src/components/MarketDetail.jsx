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

export default function MarketDetail({ market, onOpenSettings }) {
  const [history, setHistory] = useState(null);
  const [loadingHist, setLoadingHist] = useState(false);
  const [histError, setHistError] = useState(null);

  const [analysis, setAnalysis] = useState(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);

  // Reset the chart and any AI analysis whenever a different market is selected
  useEffect(() => {
    setHistory(null);
    setHistError(null);
    setAnalysis(null);
    setAnalysisError(null);
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

  const runAnalysis = async () => {
    setLoadingAnalysis(true);
    setAnalysisError(null);
    try {
      const { analysis } = await api.analyzeMarket(market.slug);
      setAnalysis(analysis);
    } catch (err) {
      setAnalysisError(err.message);
    } finally {
      setLoadingAnalysis(false);
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

      <div className="ai-analysis">
        <div className="ai-analysis-header">
          <h4>AI analysis (DeepSeek)</h4>
          <button className="btn btn-small" onClick={runAnalysis} disabled={loadingAnalysis}>
            {loadingAnalysis ? "Analyzing…" : analysis ? "Re-analyze" : "Analyze with DeepSeek"}
          </button>
        </div>
        {analysisError && (
          <p className="sync-error">
            {analysisError}{" "}
            {onOpenSettings && (
              <button className="link-button" onClick={onOpenSettings}>
                Open settings
              </button>
            )}
          </p>
        )}
        {analysis && <div className="ai-analysis-text">{analysis}</div>}
      </div>
    </section>
  );
}
