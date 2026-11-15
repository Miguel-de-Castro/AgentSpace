import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../util/id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.AGENTSPACE_DATA_DIR ?? join(__dirname, "..", "..", "data");
const DB_PATH = join(DATA_DIR, "agentspace.db");

/**
 * .claude/plans/19-clone-git-repository.md — the resolved data directory, so
 * other layers (Execution Engine) can put managed clones under it
 * (`<dataDir>/repos/`) consistently with where the DB lives, honoring the same
 * AGENTSPACE_DATA_DIR override.
 */
export function getDataDir(): string {
  return DATA_DIR;
}

let db: DatabaseSync | undefined;

/**
 * Opens (and if needed, initializes) the single Workspace SQLite file.
 * One file per Workspace, per docs/07-SCHEMA_API_CONTRACT.md §1.
 *
 * Driver: Node's built-in `node:sqlite` (stable, no native compile step),
 * not `better-sqlite3` — switched 2026-08-12 because better-sqlite3 has no
 * prebuilt binary yet for Node 24 on Windows, and this machine has no local
 * C++ toolchain to compile one. Same SQLite file format either way; only the
 * driver changed, not the persistence architecture (docs/03-ARCHITECTURE.md §3).
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  migrateAddColumnIfMissing(db, "projects", "github_token", "TEXT");
  migrateAddColumnIfMissing(db, "projects", "permission_policy", `TEXT NOT NULL DEFAULT '{"mode":"read-only"}'`);
  migrateAddColumnIfMissing(db, "projects", "origin_kind", "TEXT NOT NULL DEFAULT 'local'");
  migrateAddColumnIfMissing(db, "projects", "clone_url", "TEXT");
  migrateAddColumnIfMissing(db, "executions", "branch_name", "TEXT");
  migrateAddColumnIfMissing(db, "executions", "provider", "TEXT");
  migrateAddColumnIfMissing(db, "evidence", "team_member_role", "TEXT");
  // .claude/plans/20-plano-consolidado.md item 1.6 — additive, nullable.
  migrateAddColumnIfMissing(db, "executions", "cost_usd", "REAL");
  migrateAddColumnIfMissing(db, "executions", "input_tokens", "INTEGER");
  migrateAddColumnIfMissing(db, "executions", "output_tokens", "INTEGER");
  migrateAddColumnIfMissing(db, "executions", "duration_ms", "INTEGER");
  migrateToWaitingSchema(db, schema);
  // Phase 3.3 / Phase 4 — additive, after the rebuild (a fresh or just-rebuilt
  // table already has them from schema.sql).
  migrateAddColumnIfMissing(db, "missions", "plan_checkpoint", "INTEGER NOT NULL DEFAULT 0");
  migrateAddColumnIfMissing(db, "missions", "approved_plan", "TEXT");
  migrateAddColumnIfMissing(db, "missions", "acceptance_criteria", "TEXT");
  migrateDecisionsPlanTier(db, schema);
  // Phase 7.7 — stacked Missions (additive, after the rebuilds).
  migrateAddColumnIfMissing(db, "missions", "base_mission_id", "TEXT REFERENCES missions(id)");
  migrateAddColumnIfMissing(db, "missions", "base_branch", "TEXT");
  // Phase 6 / Phase 7.1 — per-Project settings, additive.
  migrateAddColumnIfMissing(db, "projects", "auto_fix_loop", "INTEGER NOT NULL DEFAULT 0");
  migrateAddColumnIfMissing(db, "projects", "instructions", "TEXT");
  migrateAddColumnIfMissing(db, "projects", "role_instructions", "TEXT");
  // .claude/plans/24-ideias-para-analisar.md item 7 — optional weekly cost ceiling.
  migrateAddColumnIfMissing(db, "projects", "weekly_budget_usd", "REAL");
  // Item 2 — ideas a routine must not propose again (JSON array of short texts).
  migrateAddColumnIfMissing(db, "projects", "routine_exclusions", "TEXT");
  // Plan 25 — how to launch the Project's app ("Run").
  migrateAddColumnIfMissing(db, "projects", "run_command", "TEXT");
  migrateAddColumnIfMissing(db, "projects", "install_command", "TEXT");
  migrateAddColumnIfMissing(db, "projects", "preview_port", "INTEGER");

  seedWorkspace(db);

  return db;
}

/**
 * Guarded `ALTER TABLE ADD COLUMN` for columns added after a table's initial
 * `CREATE TABLE IF NOT EXISTS` — this build's SQLite doesn't support
 * `ADD COLUMN IF NOT EXISTS` (confirmed empirically 2026-08-12), so
 * `PRAGMA table_info` is checked first instead. Safe to call on every boot.
 */
function migrateAddColumnIfMissing(database: DatabaseSync, table: string, column: string, type: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3 (decision D1) — the ONE table
 * rebuild: a CHECK constraint can't be altered in SQLite, so `missions` (new
 * status 'waiting' + waiting_reason/resume_at) and `executions` (new triggers
 * 'resume-after-limit'/'resume-after-input') are recreated from their current
 * definitions in schema.sql and the rows copied over, in one transaction.
 * Idempotent: skipped once `missions` already accepts 'waiting' (a fresh DB
 * gets the new shape straight from schema.sql). Follows SQLite's documented
 * 12-step procedure: foreign keys off, rebuild, foreign_key_check, back on.
 */
function migrateToWaitingSchema(database: DatabaseSync, schemaSql: string): void {
  const current = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'missions'").get() as
    | { sql: string }
    | undefined;
  if (!current || current.sql.includes("'waiting'")) return;

  rebuildTables(database, schemaSql, [
    { table: "missions", indexes: ["CREATE INDEX IF NOT EXISTS idx_missions_project_status ON missions(project_id, status)"] },
    { table: "executions", indexes: ["CREATE INDEX IF NOT EXISTS idx_executions_mission ON executions(mission_id)"] },
  ]);
  console.log("Database migrated: Missions can now be 'waiting' (plan 20, Phase 3).");
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3.3 — `decisions` gains the
 * 'plan' tier (plan-approved / plan-revised / plan-discarded). Same guarded,
 * idempotent rebuild as above; skipped once the CHECK already names it.
 */
function migrateDecisionsPlanTier(database: DatabaseSync, schemaSql: string): void {
  const current = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get() as
    | { sql: string }
    | undefined;
  if (!current || current.sql.includes("'plan-approved'")) return;
  rebuildTables(database, schemaSql, [
    {
      table: "decisions",
      indexes: [
        "CREATE INDEX IF NOT EXISTS idx_decisions_mission ON decisions(mission_id)",
        "CREATE INDEX IF NOT EXISTS idx_decisions_tier_outcome ON decisions(tier, outcome)",
      ],
    },
  ]);
  console.log("Database migrated: Decisions can now record a plan checkpoint (plan 20, Phase 3.3).");
}

/**
 * Rebuilds tables from their CURRENT definition in schema.sql (no duplicated
 * DDL), copying the shared columns, in one transaction with foreign keys off
 * and a foreign_key_check before commit (SQLite's documented procedure for
 * changing a CHECK constraint).
 */
function rebuildTables(database: DatabaseSync, schemaSql: string, specs: { table: string; indexes: string[] }[]): void {
  const tableDdl = (name: string): string => {
    const match = schemaSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`schema.sql has no CREATE TABLE for '${name}'`);
    return match[0].replace(`CREATE TABLE IF NOT EXISTS ${name} (`, `CREATE TABLE ${name}__new (`);
  };
  const columnsOf = (table: string): string[] =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    runInTransaction(database, () => {
      for (const { table, indexes } of specs) {
        database.exec(tableDdl(table));
        const shared = columnsOf(`${table}__new`).filter((c) => columnsOf(table).includes(c));
        const cols = shared.join(", ");
        database.exec(`INSERT INTO ${table}__new (${cols}) SELECT ${cols} FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
        for (const index of indexes) database.exec(index);
      }
      const broken = database.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`Rebuild left ${broken.length} broken foreign key(s); rolled back.`);
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * node:sqlite's DatabaseSync has no built-in `.transaction()` wrapper (unlike
 * better-sqlite3) — this is the compat helper call sites use instead:
 * `runInTransaction(db, () => { ... })` in place of `db.transaction(() => {...})()`.
 */
export function runInTransaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

/**
 * v1 has exactly one Workspace (docs/02-DOMAIN.md). This creates that single
 * row on first run rather than requiring a setup step for something the
 * product doesn't expose as user-configurable in v1.
 */
function seedWorkspace(database: DatabaseSync): void {
  const existing = database.prepare("SELECT id FROM workspaces LIMIT 1").get();
  if (existing) return;

  database.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(newId(), "My Workspace");
}

export function getWorkspaceId(): string {
  const row = getDb().prepare("SELECT id FROM workspaces LIMIT 1").get() as unknown as { id: string } | undefined;
  if (!row) throw new Error("No workspace row found — database was not initialized correctly.");
  return row.id;
}
