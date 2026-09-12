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

// Walks an analysis's parent_analysis_id chain from root to `id`, using the
// already-fetched flat list for this market (every ancestor of a follow-up
// is always on the same market, so no extra request is needed).
function buildThread(analyses, id) {
  const byId = new Map(analyses.map((a) => [a.id, a]));
  const chain = [];
  let current = byId.get(id);
  while (current) {
    chain.unshift(current);
    current = current.parent_analysis_id ? byId.get(current.parent_analysis_id) : null;
  }
  return chain;
}

export default function MarketDetail({ market, onOpenSettings, onSelectRelated }) {
  const [history, setHistory] = useState(null);
  const [loadingHist, setLoadingHist] = useState(false);
  const [histError, setHistError] = useState(null);

  const [analyses, setAnalyses] = useState([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [lastWasCached, setLastWasCached] = useState(false);

  // Reusable prompt templates (Phase 4) — Express/SQLite only; the
  // picker is simply omitted when the endpoint isn't available (Vercel),
  // and the server falls back to whatever default it has configured.
  const [promptTemplates, setPromptTemplates] = useState(null);
  const [analyzeTemplateId, setAnalyzeTemplateId] = useState("");

  // Follow-up prompts layered on a stored analysis (Phase 4).
  const [followUpText, setFollowUpText] = useState("");
  const [loadingFollowUp, setLoadingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState(null);

  const [related, setRelated] = useState([]);

  const selectedAnalysis = analyses.find((a) => a.id === selectedAnalysisId) || null;
  const thread = selectedAnalysis ? buildThread(analyses, selectedAnalysis.id) : [];

  // Reset the chart and any AI analysis whenever a different market is selected
  useEffect(() => {
    setHistory(null);
    setHistError(null);
    setAnalyses([]);
    setSelectedAnalysisId(null);
    setAnalysisError(null);
    setLastWasCached(false);
    setFollowUpText("");
    setFollowUpError(null);
  }, [market.slug]);

  // Prompt templates don't depend on which market is selected — fetch once.
  useEffect(() => {
    let cancelled = false;
    api
      .listPromptTemplates()
      .then((rows) => {
        if (!cancelled) setPromptTemplates(rows);
      })
      .catch(() => {
        if (!cancelled) setPromptTemplates(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Past analyses for this market (Phase 3) — newest first; the most recent
  // one is shown by default, older ones stay available to view/compare.
  useEffect(() => {
    let cancelled = false;
    api
      .listAnalyses(market.slug)
      .then((rows) => {
        if (cancelled) return;
        setAnalyses(rows);
        if (rows.length) setSelectedAnalysisId(rows[0].id);
      })
      .catch(() => {
        if (!cancelled) setAnalyses([]);
      });
    return () => {
      cancelled = true;
    };
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

  const runAnalysis = async (force) => {
    setLoadingAnalysis(true);
    setAnalysisError(null);
    try {
      const { analysis, cached } = await api.analyzeMarket(market.slug, {
        force,
        templateId: analyzeTemplateId || undefined,
      });
      setLastWasCached(cached);
      setAnalyses((prev) => {
        const withoutDup = prev.filter((a) => a.id !== analysis.id);
        return [analysis, ...withoutDup];
      });
      setSelectedAnalysisId(analysis.id);
    } catch (err) {
      setAnalysisError(err.message);
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const runFollowUp = async () => {
    if (!followUpText.trim() || !selectedAnalysisId) return;
    setLoadingFollowUp(true);
    setFollowUpError(null);
    try {
      const { analysis } = await api.followUpAnalysis(selectedAnalysisId, followUpText.trim());
      setAnalyses((prev) => [analysis, ...prev]);
      setSelectedAnalysisId(analysis.id);
      setFollowUpText("");
    } catch (err) {
      setFollowUpError(err.message);
    } finally {
      setLoadingFollowUp(false);
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
          <div className="ai-analysis-actions">
            {promptTemplates && promptTemplates.length > 0 && (
              <select
                className="ai-analysis-template-picker"
                value={analyzeTemplateId}
                onChange={(e) => setAnalyzeTemplateId(e.target.value)}
                title="Prompt template to use for the next analysis"
              >
                <option value="">Default template</option>
                {promptTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn btn-small" onClick={() => runAnalysis(false)} disabled={loadingAnalysis}>
              {loadingAnalysis ? "Analyzing…" : "Analyze with DeepSeek"}
            </button>
            {analyses.length > 0 && (
              <button
                className="btn btn-small btn-ghost"
                onClick={() => runAnalysis(true)}
                disabled={loadingAnalysis}
                title="Always calls DeepSeek again, even if an identical analysis already exists"
              >
                Re-run
              </button>
            )}
          </div>
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

        {analyses.length > 1 && (
          <div className="ai-analysis-history">
            <label htmlFor="analysis-picker">History ({analyses.length})</label>
            <select
              id="analysis-picker"
              value={selectedAnalysisId ?? ""}
              onChange={(e) => setSelectedAnalysisId(Number(e.target.value))}
            >
              {analyses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.parent_analysis_id ? "↳ " : ""}
                  {new Date(a.created_at).toLocaleString()} · {a.model_name}
                  {a.reasoning_effort ? ` (${a.reasoning_effort})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {thread.map((a, i) => (
          <div key={a.id}>
            {i > 0 && <p className="ai-analysis-turn-label">Follow-up: {a.prompt_text}</p>}
            <p className="ai-analysis-meta">
              {new Date(a.created_at).toLocaleString()} · {a.model_name}
              {a.reasoning_effort ? ` (${a.reasoning_effort})` : ""}
              {a.tokens_used != null && <> · {a.tokens_used} tokens</>}
              {a.cost_estimate != null && <> · ~${a.cost_estimate.toFixed(4)} est.</>}
              {lastWasCached && a.id === analyses[0]?.id && a.id === selectedAnalysisId && (
                <> · from history (not re-billed)</>
              )}
            </p>
            <div className="ai-analysis-text">{a.result_text}</div>
          </div>
        ))}

        {selectedAnalysis && (
          <div className="ai-analysis-followup">
            <textarea
              rows={2}
              placeholder="Ask a follow-up about this analysis…"
              value={followUpText}
              onChange={(e) => setFollowUpText(e.target.value)}
            />
            <button
              className="btn btn-small"
              onClick={runFollowUp}
              disabled={loadingFollowUp || !followUpText.trim()}
            >
              {loadingFollowUp ? "Asking…" : "Ask follow-up"}
            </button>
            {followUpError && <p className="sync-error">{followUpError}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
