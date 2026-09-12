function fmtPrice(v) {
  return v === null || v === undefined ? "—" : Number(v).toFixed(3);
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

export default function MarketTable({ markets, selectedSlug, onSelect }) {
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Market</th>
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
            <td className="q-cell">
              <div className="q-title">{m.question}</div>
              <div className="q-slug">{m.slug}</div>
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
