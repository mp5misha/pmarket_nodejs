import { getPool, ensureSchema, getAllForExport } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);
    const rows = await getAllForExport(pool);
    if (!rows.length) return res.status(404).send("No data to export yet");

    const cols = Object.keys(rows[0]);
    const escape = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=markets.csv");
    res.status(200).send(lines.join("\n"));
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
