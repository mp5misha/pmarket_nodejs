import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const require = createRequire(import.meta.url);

// Migrations are numbered files in server/migrations/, applied in filename
// order exactly once, tracked in schema_migrations. Two kinds:
//  - "*.sql"  — plain DDL, executed verbatim via db.exec().
//  - "*.cjs"  — for migrations that need JS logic (e.g. backfilling data),
//               exporting `up(db)`. CommonJS specifically because this
//               project is "type": "module" and createRequire refuses to
//               require a plain .js file there — .cjs is always CommonJS
//               regardless of package.json, so it loads synchronously,
//               matching better-sqlite3's synchronous API.
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".cjs"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const fullPath = path.join(MIGRATIONS_DIR, file);

    const apply = db.transaction(() => {
      if (file.endsWith(".sql")) {
        db.exec(fs.readFileSync(fullPath, "utf8"));
      } else {
        delete require.cache[require.resolve(fullPath)];
        const migration = require(fullPath);
        migration.up(db);
      }
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString()
      );
    });

    apply();
    console.log(`Applied migration: ${file}`);
  }
}
