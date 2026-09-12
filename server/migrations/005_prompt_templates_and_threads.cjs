// Phase 4: reusable, named prompt templates (replacing the single
// settings-stored prompt string from Phase 3) and analysis threads
// (a follow-up question builds on a prior analysis's own prompt+reply).
exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      template   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const cols = db.prepare("PRAGMA table_info(ai_analysis)").all().map((c) => c.name);
  if (!cols.includes("parent_analysis_id")) {
    db.exec("ALTER TABLE ai_analysis ADD COLUMN parent_analysis_id INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_analysis_parent ON ai_analysis(parent_analysis_id)");

  const { c: templateCount } = db.prepare("SELECT COUNT(*) c FROM prompt_templates").get();
  if (templateCount === 0) {
    const DEFAULT_PROMPT_TEMPLATE =
      "Could you please analyze the real probability and analyze all the background " +
      "information available for the following event at Polymarket: {slug}\n\n" +
      "Market data:\n" +
      "- YES price: {yes_price}\n" +
      "- NO price: {no_price}\n" +
      "- Resolution date: {end_date}\n" +
      "- Liquidity: {liquidity}";

    // Carry over a previously-customized Phase 3 prompt (a single string
    // stored under this settings key) as the seeded "Default" template's
    // text, instead of silently discarding it.
    const existingSetting = db.prepare("SELECT value FROM settings WHERE key = ?").get("deepseek_prompt_template");
    const templateText = existingSetting?.value || DEFAULT_PROMPT_TEMPLATE;

    const now = new Date().toISOString();
    const result = db
      .prepare("INSERT INTO prompt_templates (name, template, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("Default", templateText, now, now);

    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('default_prompt_template_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(result.lastInsertRowid));
  }
};
