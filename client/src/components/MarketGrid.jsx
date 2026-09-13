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
  const highlighted = highlightThreshold != null && impliedYes != null && impliedYes >= highlightThreshold;
  const classes = [
    market.slug === selectedSlug ? "selected" : "",
    isNested ? "nested-row" : "",
    highlighted ? "highlighted-row" : "",
  ]
    .filter(Boolean)
    .join(" ");

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
      <td className="updated-cell">
        {market.closed ? <span className="resolved-badge">Resolved</span> : fmtTime(market.last_updated)}
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
          <td colSpan={7} className="event-header-cell">
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
              <th>Updated</th>
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
