// Baseline schema as of the migration system's introduction. Runs once
// against databases in two possible prior states: completely fresh, or
// already carrying this exact shape from the old hand-rolled migration
// logic in db.js — hence the defensive CREATE TABLE IF NOT EXISTS / PRAGMA
// column check below. Migrations after this one don't need that
// defensiveness: schema_migrations makes "have we applied this" an exact,
// tracked fact instead of a guess.
//
// A plain .sql file can't express this: SQLite's ALTER TABLE ADD COLUMN has
// no IF NOT EXISTS clause (unlike Postgres), so retrofitting a column onto
// a pre-existing table needs the PRAGMA table_info check done here in JS.
exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      slug            TEXT PRIMARY KEY,
      market_id       TEXT,
      condition_id    TEXT,
      question        TEXT,
      outcomes        TEXT,
      outcome_prices  TEXT,
      current_price   REAL,
      min_price       REAL,
      max_price       REAL,
      volume          REAL,
      liquidity       REAL,
      resolution_date TEXT,
      active          INTEGER,
      closed          INTEGER,
      yes_token_id    TEXT,
      last_updated    TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const columns = db.prepare("PRAGMA table_info(markets)").all().map((c) => c.name);
  const addColumnIfMissing = (name, ddl) => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE markets ADD COLUMN ${ddl}`);
  };
  addColumnIfMissing("tags", "tags TEXT");
  addColumnIfMissing("no_price", "no_price REAL");
  addColumnIfMissing("event_id", "event_id TEXT");
  addColumnIfMissing("event_slug", "event_slug TEXT");
  addColumnIfMissing("event_title", "event_title TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume);
    CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution_date);
    CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
  `);
};
