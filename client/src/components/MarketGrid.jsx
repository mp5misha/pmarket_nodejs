import { useEffect, useRef } from "react";

function fmtPrice(v) {
  return v === null || v === undefined ? "—" : Number(v).toFixed(3);
}

function fmtPct(v) {
  return v === null || v === undefined ? "—" : `${(Number(v) * 100).toFixed(1)}%`;
}

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Same as fmtMoney but keeps cents (a trade's profit is often a few dollars
// and needs the precision) and puts a "-" before the "$" for a loss instead
// of after it.
function fmtTradeMoney(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleTimeString();
}

// "YYYY/MM/DD, HH:MM" in the viewer's local timezone (not toLocaleString(),
// which varies by locale/browser) — used by the grid's own "Updated" column
// so a market's last-synced time is unambiguous at a glance.
function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Same as fmtDateTime but "YYYY/MM/DD HH:MM" (no comma) — the format asked
// for specifically for the "My trade date" column.
function fmtTradeDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The market's live price for whichever side (Yes/No) a trade was placed on
// — needed to compare against the trade's entry price and to mark an open
// trade's position to market.
function priceForSide(market, side) {
  return (side || "").toLowerCase() === "no" ? market.no_price : market.current_price;
}

// "'No' @ $0.654 by $20.00 amount" — side, entry price, and stake for this
// market's most recent trade (see LATEST_TRADE_SELECT in db.js/lib/db.js).
function fmtTradeSummary(market) {
  if (market.my_trade_id == null) return null;
  const side = market.my_trade_side || "";
  const label = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
  const price = Number(market.my_trade_entry_price).toFixed(3);
  const stake = Number(market.my_trade_stake).toFixed(2);
  return `'${label}' @ $${price} by $${stake} amount`;
}

// A resolved trade's profit is whatever was locked in at resolution; an
// still-open one is marked to the market's current live price for that side
// (shares bought = stake / entry price, same formula the server uses for a
// won trade's payout).
function tradeProfit(market) {
  if (market.my_trade_id == null) return null;
  if (market.my_trade_status && market.my_trade_status !== "open") {
    return market.my_trade_profit;
  }
  const entryPrice = Number(market.my_trade_entry_price);
  const stake = Number(market.my_trade_stake);
  const currentPrice = priceForSide(market, market.my_trade_side);
  if (!entryPrice || currentPrice == null) return null;
  const shares = stake / entryPrice;
  return shares * currentPrice - stake;
}

const ANALYSIS_PREVIEW_LENGTH = 140;

// The most recent analysis or follow-up result for a market (whichever is
// newer — a follow-up is just another row in the same table), truncated
// for the grid cell; hovering shows the full text via the `title` attribute.
function fmtAnalysisPreview(text) {
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed.length > ANALYSIS_PREVIEW_LENGTH
    ? `${trimmed.slice(0, ANALYSIS_PREVIEW_LENGTH).trimEnd()}…`
    : trimmed;
}

function parseTags(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function SelectAllCheckbox({ checked, indeterminate, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input type="checkbox" ref={ref} checked={checked} onChange={onChange} />;
}

function MarketRow({ market, isNested, selectedSlug, onSelectMarket, selectedSlugs, onToggleSelect, highlightThreshold }) {
  const impliedYes = market.current_price;
  const hasTrade = market.my_trade_id != null;
  const isWhaleMarket = Boolean(market.is_whale_market);
  // Precedence when more than one highlight would apply to the same row,
  // most specific/personal first: your own trade's price comparison, then
  // "a whale currently holds this" (purple), then the generic
  // implied-probability threshold.
  const highlighted =
    !hasTrade && !isWhaleMarket && highlightThreshold != null && impliedYes != null && impliedYes >= highlightThreshold;
  let tradeRowClass = "";
  if (hasTrade) {
    const entryPrice = Number(market.my_trade_entry_price);
    const currentPrice = priceForSide(market, market.my_trade_side);
    if (currentPrice != null) {
      if (entryPrice < currentPrice) tradeRowClass = "trade-row-up";
      else if (entryPrice > currentPrice) tradeRowClass = "trade-row-down";
    }
  }
  const classes = [
    market.slug === selectedSlug ? "selected" : "",
    isNested ? "nested-row" : "",
    highlighted ? "highlighted-row" : "",
    !hasTrade && isWhaleMarket ? "whale-row" : "",
    tradeRowClass,
  ]
    .filter(Boolean)
    .join(" ");
  const profit = tradeProfit(market);

  return (
    <tr className={classes} onClick={() => onSelectMarket(market.slug)}>
      <td className="select-col" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selectedSlugs.has(market.slug)}
          onChange={() => onToggleSelect(market.slug)}
        />
      </td>
      <td className="q-cell">
        <div className="q-title">{market.question}</div>
        <div className="q-slug">{market.slug}</div>
        <div className="tags-cell">
          {parseTags(market.tags).map((t) => (
            <span className="tag-badge" key={t}>
              {t}
            </span>
          ))}
        </div>
      </td>
      <td className="num">{fmtPrice(market.current_price)}</td>
      <td className="num">{fmtPrice(market.no_price)}</td>
      <td className="num">{fmtPct(impliedYes)}</td>
      <td className="num">{fmtMoney(market.volume)}</td>
      <td className="num">{fmtMoney(market.liquidity)}</td>
      <td>{fmtDate(market.resolution_date)}</td>
      <td
        className="analysis-cell"
        title={
          market.last_analysis_text
            ? `${market.last_analysis_text}${
                market.last_analysis_at ? `\n\n(as of ${fmtDateTime(market.last_analysis_at)})` : ""
              }`
            : undefined
        }
      >
        {fmtAnalysisPreview(market.last_analysis_text) || "—"}
      </td>
      <td className="num">{fmtPct(market.fair_prob_yes)}</td>
      <td className="num">{market.fair_prob_yes != null ? fmtPct(1 - Number(market.fair_prob_yes)) : "—"}</td>
      <td className="updated-cell">
        {market.closed ? <span className="resolved-badge">Resolved</span> : fmtDateTime(market.last_updated)}
      </td>
      <td className="my-trade-cell">{fmtTradeSummary(market) || "—"}</td>
      <td>{hasTrade ? fmtTradeDateTime(market.my_trade_placed_at) : "—"}</td>
      <td className={profit > 0 ? "trades-profit-positive" : profit < 0 ? "trades-profit-negative" : ""}>
        {profit != null ? fmtTradeMoney(profit) : "—"}
      </td>
    </tr>
  );
}

function GroupRows({ group, ...rowProps }) {
  const isMultiMarket = group.markets.length > 1;
  return (
    <>
      {isMultiMarket && (
        <tr className="event-header-row">
          <td />
          <td colSpan={8} className="event-header-cell">
            {group.eventTitle}
            <span className="event-count"> · {group.markets.length} markets</span>
          </td>
        </tr>
      )}
      {group.markets.map((market) => (
        <MarketRow key={market.slug} market={market} isNested={isMultiMarket} {...rowProps} />
      ))}
    </>
  );
}

const SORT_OPTIONS = [
  { value: "volume", label: "Volume" },
  { value: "liquidity", label: "Liquidity" },
  { value: "current_price", label: "Implied probability (Yes)" },
  { value: "resolution_date", label: "Event date" },
  { value: "closed", label: "Resolved first" },
];

const REFRESH_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
];

/** Reusable event/market grid: a row per event (nesting its markets) or per
 * standalone market, each outcome showing Yes/No price + implied
 * probability, with sorting, pagination, and an auto-refresh interval that
 * re-polls stored data (not a live Polymarket hit) so "last updated"
 * reflects whatever sync/refresh has last written to the DB. Data fetching
 * lives in the caller (see useMarketGroups) so this same component can back
 * "All Markets" today and "Watchlist"/"My Trades" later with different
 * filters. */
export default function MarketGrid({
  groups,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  sortBy,
  onSortByChange,
  loading,
  error,
  lastFetchedAt,
  refreshIntervalSec,
  onRefreshIntervalChange,
  selectedSlug,
  onSelectMarket,
  selectedSlugs,
  onToggleSelect,
  onToggleSelectAll,
  highlightThreshold,
  statusFilter,
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allMarkets = groups.flatMap((g) => g.markets);
  const allSelected = allMarkets.length > 0 && allMarkets.every((m) => selectedSlugs.has(m.slug));
  const someSelected = allMarkets.some((m) => selectedSlugs.has(m.slug));

  return (
    <div className="market-grid">
      <div className="grid-toolbar">
        <div className="grid-toolbar-group">
          <label className="grid-inline-label">
            Sort
            <select value={sortBy} onChange={(e) => onSortByChange(e.target.value)}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid-inline-label">
            Auto-refresh
            <select
              value={refreshIntervalSec}
              onChange={(e) => onRefreshIntervalChange(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="grid-last-updated">
          {loading ? "Refreshing…" : lastFetchedAt ? `Last updated ${fmtTime(lastFetchedAt)}` : ""}
        </span>
      </div>

      {error && <p className="sync-error">{error}</p>}

      {!loading && total === 0 ? (
        <div className="empty-state">
          No markets match these filters yet.
          {statusFilter === "closed" && (
            <>
              {" "}
              If you expect resolved markets here, try <strong>Run sync</strong> in the sidebar with
              status set to <strong>All</strong> or <strong>Closed only</strong> — a market's stored
              status only updates when it's actually re-synced.
            </>
          )}
        </div>
      ) : (
        <div className="grid-table-wrap">
          <table className="ledger grid-table">
            <thead>
              <tr>
                <th className="select-col">
                  <SelectAllCheckbox
                    checked={allSelected}
                    indeterminate={someSelected && !allSelected}
                    onChange={onToggleSelectAll}
                  />
                </th>
                <th>Event / Market</th>
                <th className="num">Yes price</th>
                <th className="num">No price</th>
                <th className="num">Implied prob.</th>
                <th className="num">Volume</th>
                <th className="num">Liquidity</th>
                <th>Resolves</th>
                <th>AI analysis results</th>
                <th className="num">AI fair YES %</th>
                <th className="num">AI fair NO %</th>
                <th>Updated</th>
                <th>My trade price</th>
                <th>My trade date</th>
                <th>My trade profit</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <GroupRows
                  key={group.key}
                  group={group}
                  selectedSlug={selectedSlug}
                  onSelectMarket={onSelectMarket}
                  selectedSlugs={selectedSlugs}
                  onToggleSelect={onToggleSelect}
                  highlightThreshold={highlightThreshold}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="pagination">
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            <option value={10}>10 / page</option>
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
          <button
            className="btn btn-ghost btn-small"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            ← Prev
          </button>
          <span className="page-indicator">
            Page {page} of {totalPages} · {total} event{total === 1 ? "" : "s"}/markets
          </span>
          <button
            className="btn btn-ghost btn-small"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
