import { useEffect, useRef } from "react";

function fmtPrice(v) {
  return v === null || v === undefined ? "—" : Number(v).toFixed(3);
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

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function SelectAllCheckbox({ checked, indeterminate, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input type="checkbox" ref={ref} checked={checked} onChange={onChange} />;
}

export default function MarketTable({
  markets,
  selectedSlug,
  onSelect,
  selectedSlugs,
  onToggleSelect,
  onToggleSelectAll,
}) {
  const allSelected = markets.length > 0 && markets.every((m) => selectedSlugs.has(m.slug));
  const someSelected = markets.some((m) => selectedSlugs.has(m.slug));

  return (
    <table className="ledger">
      <thead>
        <tr>
          <th className="select-col">
            <SelectAllCheckbox
              checked={allSelected}
              indeterminate={someSelected && !allSelected}
              onChange={onToggleSelectAll}
            />
          </th>
          <th>Market</th>
          <th>Tags</th>
          <th className="num">Price</th>
          <th className="num">Min</th>
          <th className="num">Max</th>
          <th className="num">Volume</th>
          <th className="num">Liquidity</th>
          <th>Resolves</th>
        </tr>
      </thead>
      <tbody>
        {markets.map((m) => (
          <tr
            key={m.slug}
            className={m.slug === selectedSlug ? "selected" : ""}
            onClick={() => onSelect(m.slug)}
          >
            <td className="select-col" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selectedSlugs.has(m.slug)}
                onChange={() => onToggleSelect(m.slug)}
              />
            </td>
            <td className="q-cell">
              <div className="q-title">{m.question}</div>
              <div className="q-slug">{m.slug}</div>
            </td>
            <td className="tags-cell">
              {parseTags(m.tags).map((t) => (
                <span className="tag-badge" key={t}>
                  {t}
                </span>
              ))}
            </td>
            <td className="num">{fmtPrice(m.current_price)}</td>
            <td className="num">{fmtPrice(m.min_price)}</td>
            <td className="num">{fmtPrice(m.max_price)}</td>
            <td className="num">{fmtMoney(m.volume)}</td>
            <td className="num">{fmtMoney(m.liquidity)}</td>
            <td>{fmtDate(m.resolution_date)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
