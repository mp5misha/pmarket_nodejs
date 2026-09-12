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

function fmtRelatedPrice(v) {
  return v === null || v === undefined ? "—" : Number(v).toFixed(3);
}

export default function MarketDetail({ market, onOpenSettings, onSelectRelated }) {
  const [history, setHistory] = useState(null);
  const [loadingHist, setLoadingHist] = useState(false);
  const [histError, setHistError] = useState(null);

  const [analysis, setAnalysis] = useState(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);

  const [related, setRelated] = useState([]);

  // Reset the chart and any AI analysis whenever a different market is selected
  useEffect(() => {
    setHistory(null);
    setHistError(null);
    setAnalysis(null);
    setAnalysisError(null);
  }, [market.slug]);

  // Other markets under the same Polymarket event (e.g. other candidates in
  // the same election) — silently empty when the market isn't part of one.
  useEffect(() => {
    let cancelled = false;
    api
      .related(market.slug)
      .then((rows) => {
        if (!cancelled) setRelated(rows);
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
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
      {market.event_title && <p className="event-note">Part of: {market.event_title}</p>}

      <div className="metrics">
        <div className="metric">
          <div className="label">Yes price</div>
          <div className="value">
            {market.current_price != null ? Number(market.current_price).toFixed(3) : "—"}
          </div>
        </div>
        <div className="metric">
          <div className="label">No price</div>
          <div className="value">
            {market.no_price != null ? Number(market.no_price).toFixed(3) : "—"}
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

      {related.length > 0 && (
        <div className="related-markets">
          <h4>Related markets in this event</h4>
          <ul>
            {related.map((r) => (
              <li key={r.slug}>
                <button className="link-button" onClick={() => onSelectRelated?.(r.slug)}>
                  {r.question}
                </button>
                <span className="related-price">
                  Yes {fmtRelatedPrice(r.current_price)} · No {fmtRelatedPrice(r.no_price)}
                </span>
              </li>
            ))}
          </ul>
        </div>
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
