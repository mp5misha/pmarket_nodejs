const crypto = require("node:crypto");

// Phase 8: full auth. Adds users/sessions/token tables, and retrofits
// user_id onto every table that holds user-owned configuration or activity
// (saved_searches, fetch_runs, ai_analysis, prompt_templates, trades,
// bankroll_ledger) plus a new user_settings table replacing the old global
// `settings` key/value store. The shared `markets` catalog is NOT given a
// user_id — it mirrors Polymarket's public data and is the same for every
// user, so there's no reason to fork it per account.
//
// Migration path for pre-existing (single-tenant) data: if any of those
// tables already have rows, they're attached to a placeholder "legacy"
// account (email legacy@local.invalid — the .invalid TLD is reserved by
// RFC 2606 so it can never collide with a real signup or receive mail, and
// its password hash is an unguessable random value, not a default anyone
// could log in with). A logged-in user can inherit that historical data via
// POST /api/auth/claim-legacy-data. On a brand-new install with no existing
// rows, no legacy account is created at all.
exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash    TEXT NOT NULL UNIQUE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_seen_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verification_tokens(user_id);

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_reset_tokens(user_id);

    CREATE TABLE IF NOT EXISTS two_factor_codes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash           TEXT NOT NULL,
      pending_token_hash  TEXT NOT NULL,
      attempts            INTEGER NOT NULL DEFAULT 0,
      expires_at          TEXT NOT NULL,
      used_at             TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_2fa_user ON two_factor_codes(user_id);

    CREATE TABLE IF NOT EXISTS remembered_devices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remembered_user ON remembered_devices(user_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT,
      PRIMARY KEY (user_id, key)
    );
  `);

  const now = new Date().toISOString();

  const userOwnedTables = [
    "saved_searches",
    "fetch_runs",
    "ai_analysis",
    "prompt_templates",
    "trades",
    "bankroll_ledger",
  ];

  const hasExistingData =
    userOwnedTables.some((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c > 0) ||
    db.prepare("SELECT COUNT(*) c FROM settings").get().c > 0;

  let legacyUserId = null;
  if (hasExistingData) {
    const randomPasswordHash = crypto.randomBytes(32).toString("hex"); // not a bcrypt hash — unusable for login on purpose
    const result = db
      .prepare(
        `INSERT INTO users (email, password_hash, email_verified, created_at, updated_at)
         VALUES ('legacy@local.invalid', ?, 1, ?, ?)`
      )
      .run(randomPasswordHash, now, now);
    legacyUserId = result.lastInsertRowid;
  }

  for (const table of userOwnedTables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes("user_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id)`);
    if (legacyUserId != null) {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(legacyUserId);
    }
  }

  if (legacyUserId != null) {
    for (const row of db.prepare("SELECT key, value FROM settings").all()) {
      db.prepare(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
      ).run(legacyUserId, row.key, row.value);
    }
  }
};
