// SPDX-License-Identifier: MIT
import * as mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The migration SQL that ships with this build, read from the deployment.
 *
 * The manifest has exactly ONE source of truth: the `.sql` files that sit
 * next to this module. `scripts/copy-schema.js` copies them into
 * `dist/storage/migrations/`, and the runner reads them from `__dirname`,
 * so a release bundle and the database it upgrades always agree on the
 * same step list - the bundle cannot ship a step list that disagrees with
 * the SQL it carries.
 *
 * This used to be a second, hand-maintained copy of the SQL, inlined in
 * the source. It was dead the moment this module was imported (the loader
 * clears it before anything can read it), and it had already drifted: the
 * newest migration was registered by name but its SQL never made it into
 * the inline map. A second copy of anything is a thing that goes stale;
 * the only question is when it is noticed. Nothing noticed it, because
 * nothing read it.
 *
 * A deployment that ships no SQL at all reads as "nothing to check" rather
 * than as "every migration is pending" - see `loadMigrationManifest`.
 */
let MIGRATION_SQL = new Map<string, string>();

/** Every migration file this build ships, in the order it applies. Loaded
 *  from the deployment at startup; see `loadMigrationManifest`. */
let MIGRATION_FILES: readonly string[] = [];

/**
 * A migration entry as the console and the CLI need it.
 *
 * `name` is the file name without the numeric prefix and the extension —
 * it comes off the file system, so it cannot drift from what ships.
 * `kind` and `takesTableLock` are read out of the SQL itself rather than
 * kept in a parallel table: a hand-maintained list is exactly the thing
 * that goes stale the moment a migration is added, and then the console
 * tells an operator a pending step is harmless when it is not.
 */
export interface MigrationEntry {
  readonly version: string;
  readonly name: string;
  readonly file: string;
  /** `schema` — the migration changes tables or columns. `data` — it only
   *  writes rows. */
  readonly kind: "schema" | "data";
  /** True when the SQL performs a DDL operation that MySQL applies as a
   *  table rebuild: it copies the table, blocks writes while it runs, and
   *  on a library-sized install takes long enough to plan a window for. */
  readonly takesTableLock: boolean;
}

const MIGRATION_FILE_RE = /^(\d{3})_(.+)\.sql$/;

/**
 * DDL that changes an EXISTING table, so MySQL has to rebuild it. Adding a
 * column, dropping one, redefining one — all of them copy the rows.
 *
 * `CREATE TABLE` is deliberately absent: a brand-new table has nothing to
 * rebuild and nothing to lock, so a migration that only adds tables is
 * cheap even on a large install.
 */
const TABLE_REBUILDING_DDL =
  /(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX|DROP\s+INDEX)/i;

/**
 * The DDL that changes tables rather than rows.
 *
 * `CREATE TABLE` counts here even though it takes no lock: the operator
 * wants to know whether a pending step touches the schema at all, and a
 * step that adds `etl_run_dedupe` is not the same class of change as one
 * that rewrites `settings`.
 */
/** `ALTER TABLE x ADD|DROP|MODIFY|CHANGE COLUMN …` is what forces MySQL to
 *  rebuild the table. An ALTER that only adds an index is not one. */
const COLUMN_DDL = /(?:ADD|DROP|MODIFY|CHANGE)\s+(?:COLUMN\s+)?[A-Za-z_]/i;

const SCHEMA_DDL =
  /(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|(?:CREATE|DROP)\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX)/i;

function classify(sql: string): Pick<MigrationEntry, "kind" | "takesTableLock"> {
  return {
    kind: SCHEMA_DDL.test(sql) ? "schema" : "data",
    takesTableLock: TABLE_REBUILDING_DDL.test(sql) && COLUMN_DDL.test(sql),
  };
}

/** Every migration that ships with this build, in the order it applies. */
/**
 * Settles once the on-disk manifest has replaced the fallback list above.
 *
 * `loadMigrationManifest` is async, so every reader used to see the hardcoded
 * list until the directory read finished — a snapshot of the files the build
 * was written with, not of the files that shipped. That is a real hole: a
 * `migrate` run started right after import would skip the newest migration
 * (absent from the stale list), and `migrate:status` would call an
 * already-behind database current. Each async entry point below awaits this
 * promise before it reads the list, so the fallback is never observed.
 */
let manifestReady: Promise<void> = Promise.resolve();

/**
 * Read the migration SQL out of the deployment and fill `MIGRATION_SQL` /
 * `MIGRATION_FILES`.
 *
 * Called once at module load and again by `reloadMigrationManifest()` when
 * a test needs to prove the report survives a deployment that shipped no
 * SQL. Failures are not fatal: an unreadable directory leaves the manifest
 * empty, `listMigrationEntries()` returns nothing, and the report says
 * "nothing to check" — which is honest — rather than throwing from a
 * health endpoint.
 */
async function loadMigrationManifest(migrationsDir: string): Promise<void> {
  let files: string[];
  try {
    const entries = await fs.readdir(migrationsDir);
    files = entries.filter((f) => MIGRATION_FILE_RE.test(f)).sort();
  } catch {
    files = [];
  }
  const sql = new Map<string, string>();
  for (const file of files) {
    try {
      sql.set(file, await fs.readFile(path.join(migrationsDir, file), "utf8"));
    } catch {
      // A file that vanished between the listing and the read is treated
      // as absent: `listMigrationEntries` classifies it as `data`, which is
      // the conservative answer.
    }
  }
  MIGRATION_SQL.clear();
  for (const [file, text] of sql) MIGRATION_SQL.set(file, text);
  MIGRATION_FILES = files;
}

/** Re-read the manifest. Only tests need this — the production path loads
 *  the manifest once at startup and the files never change under it. */
export async function reloadMigrationManifest(): Promise<void> {
  manifestReady = loadMigrationManifest(path.join(__dirname));
  await manifestReady;
}

/** Load the manifest from an explicit directory. Test-only: it lets a test
 *  point at a directory with no migrations in it. */
export async function loadMigrationManifestFrom(migrationsDir: string): Promise<void> {
  manifestReady = loadMigrationManifest(migrationsDir);
  await manifestReady;
}

/** The list, once the on-disk manifest has been read. Every reader goes
 *  through this, so none of them can act on a half-loaded manifest. */
async function settledFiles(): Promise<readonly string[]> {
  await manifestReady;
  return MIGRATION_FILES;
}

/**
 * Every migration this build ships, in the order it applies.
 *
 * Async on purpose. The manifest is read from the disk at startup, so a
 * synchronous reader would see an empty list during the window before the
 * read settles — and "empty" is indistinguishable from "this build ships
 * no migrations". The report would then say "nothing to check" about a
 * database that is thirty steps behind.
 */
export async function listMigrationEntries(): Promise<readonly MigrationEntry[]> {
  const files = await settledFiles();
  return files.map((file) => {
    const match = MIGRATION_FILE_RE.exec(file);
    const version = match?.[1] ?? versionOf(file);
    const name = match?.[2] ?? file;
    return { version, name, file, ...classify(MIGRATION_SQL.get(file) ?? "") };
  });
}

// Load the on-disk manifest once at module load. `manifestReady` is what
// makes the async manifest observable: every reader awaits it, so nothing
// ever acts on a manifest that has not been read yet.
manifestReady = loadMigrationManifest(path.join(__dirname));
void manifestReady;

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

export async function getAppliedVersions(pool: mysql.Pool): Promise<Set<string>> {
  await pool.query(SCHEMA_MIGRATIONS_DDL);
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => String(r.version)));
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * The version a migration file claims: the numeric prefix of its name.
 *
 * The ledger stores the version as the PRIMARY KEY of `schema_migrations`,
 * so it has to be unique across the files a build ships.
 */
function versionOf(file: string): string {
  return file.slice(0, 3);
}

/**
 * The versions that more than one file claims.
 *
 * A collision is a defect in the build, not in the database: two files
 * cannot both be version 035. Left alone it plays out two ways, and both
 * are bad.
 *
 *   · On a fresh database the ledger insert fails with MySQL's
 *     `Duplicate entry '035' for key 'PRIMARY'` — which names neither of
 *     the two files, and arrives from inside the driver.
 *   · On a database that has already applied version 035, the runner sees
 *     035 in the ledger, skips BOTH files, and never runs the second one.
 *     A migration that silently never runs leaves the data in the old
 *     shape, and nothing says so.
 */
function duplicateVersions(files: readonly string[]): Map<string, string[]> {
  const byVersion = new Map<string, string[]>();
  for (const file of files) {
    const version = versionOf(file);
    const bucket = byVersion.get(version);
    if (bucket) bucket.push(file);
    else byVersion.set(version, [file]);
  }
  const duplicates = new Map<string, string[]>();
  for (const [version, list] of byVersion) {
    if (list.length > 1) duplicates.set(version, list);
  }
  return duplicates;
}

export async function runMigrations(pool: mysql.Pool): Promise<MigrationResult> {
  const files = await settledFiles();

  // Refuse a build whose step list contradicts itself BEFORE the database
  // is touched. The steps depend on each other, so applying half of them
  // and then failing leaves the database in a state no build describes.
  //
  // The error carries no driver `code`, which is what makes it a hard
  // failure: the boot path treats a coded error as "the database is
  // unreachable" and degrades to the setup wizard, and a broken step list
  // must not be mistaken for a database that is not there.
  const collisions = duplicateVersions(files);
  if (collisions.size > 0) {
    const detail = [...collisions.entries()]
      .map(([version, list]) => `${version} (${list.join(", ")})`)
      .join("; ");
    throw new Error(
      `duplicate migration version: ${detail}. Each migration file needs its own numeric prefix.`,
    );
  }

  const applied = await getAppliedVersions(pool);
  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = versionOf(file);
    if (applied.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = MIGRATION_SQL.get(file);
    if (typeof sql !== "string") {
      throw new Error(`migration ${version} is missing from this build: ${file}`);
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      await conn.commit();
      newlyApplied.push(version);
    } catch (err) {
      await conn.rollback();
      // Wrap the driver error so the message names the migration, but
      // KEEP the driver's `code` on the wrapper.
      //
      // The code is what tells the boot path whether this is "the
      // database is unreachable" (degrade and serve the wizard) or "the
      // database is reachable but the schema is broken" (a real failure
      // that must surface). A plain `new Error(message)` drops it, so
      // every migration failure would look like an unreachable database
      // and the server would quietly degrade instead of reporting the
      // actual problem.
      const driverCode = (err as { code?: unknown }).code;
      const wrapped = new Error(`migration ${version} failed: ${(err as Error).message}`);
      if (typeof driverCode === "string") {
        (wrapped as { code?: string }).code = driverCode;
      }
      (wrapped as { cause?: unknown }).cause = err;
      throw wrapped;
    } finally {
      conn.release();
    }
  }
  return { applied: newlyApplied, skipped };
}

/** A step the build ships that the database has not applied yet. */
export interface PendingMigration {
  readonly entry: MigrationEntry;
  /** The database's own account of why it cannot run the step yet, when it
   *  is more specific than "not in the ledger". */
  readonly reason: "not_applied";
}

/**
 * One place where the real table structure is not what the migrations say
 * it should be.
 *
 * `kind` is the direction: the database is MISSING something the migrations
 * establish (`missing_table`, `missing_column`), or it has a column the
 * migrations never added and the reference can therefore say nothing about
 * (`unknown_column`). The last one is the conservative direction — a column
 * added by hand is usually deliberate, so it is reported but never called
 * an error.
 */
export interface SchemaDrift {
  readonly table: string;
  readonly kind: "missing_table" | "missing_column" | "unknown_column";
  readonly column: string | null;
}

export interface SchemaReport {
  /** Entries with a row in `schema_migrations`, in file order. */
  readonly applied: readonly MigrationEntry[];
  /** Entries shipped by this build that the database has not applied. */
  readonly pending: readonly PendingMigration[];
  /** True when at least one pending step rebuilds a table. The console
   *  says "plan a window" rather than "click migrate". */
  readonly hasLockRisk: boolean;
  readonly pendingCount: number;
  /** True when nothing is pending AND the database could be read. */
  readonly isCurrent: boolean;
  /** Newest migration this build ships. */
  readonly latest: MigrationEntry | null;
  /** Newest migration the database has actually applied. */
  readonly appliedLatest: MigrationEntry | null;
  /** Set when the database could not be read: `isCurrent` is false and the
   *  console shows this instead of a count, rather than claiming a
   *  database it never saw is up to date. */
  readonly error: string | null;
  /** Places where the real structure differs from what the migrations
   *  establish. Empty when the two agree. */
  readonly drift: readonly SchemaDrift[];
  /** Set when the structure itself could not be compared. `drift` is then
   *  empty NOT because the database is clean but because nothing was
   *  checked — the console must not present that as a pass. */
  readonly structureError: string | null;
}

/**
 * What an operator needs to know before touching a deployment: is the
 * database on the schema this code expects, and if not, what is left.
 *
 * Deliberately NOT a structure diff. It compares the migrations this build
 * ships against the `schema_migrations` ledger, which is what catches the
 * ordinary failure — a deploy that skipped `migrate`. Hand-edited tables
 * are out of scope here; that needs an expected-structure manifest.
 */
/**
 * The table and column names a migration file is expected to end up with,
 * and the SQL that establishes them.
 *
 * The reference is derived from the migration SQL rather than kept as a
 * hand-written list — the same reasoning as `classify`: a hand-maintained
 * manifest is the thing that goes stale the moment a migration is added,
 * and then the drift check reports a deployment as broken when it is
 * exactly right.
 */
export interface SchemaReference {
  /** Table name → column names the migrations add to or create it with. */
  readonly tables: ReadonlyMap<string, readonly string[]>;
}

/**
 * Derive the reference from the migration SQL.
 *
 * Covers what this project actually writes:
 *   · `CREATE TABLE x ( … )` — the column list is every `name TYPE`
 *     declaration at the top level of the body, minus table options and
 *     constraints.
 *   · `ALTER TABLE x ADD COLUMN name …` — appended to whatever x already
 *     had.
 *   · `CREATE TABLE x LIKE y` — copies y's columns, which is what the ETL's
 *     scratch table does.
 *
 * Deliberately NOT a full SQL parser. A declaration it cannot recognise is
 * skipped rather than guessed, which only ever makes the reference narrower
 * — and a narrower reference reports less drift, never more.
 */
export function buildSchemaReference(entries: readonly MigrationEntry[]): SchemaReference {
  const columns = new Map<string, Set<string>>();

  const likeSources = new Map<string, string>();
  const drops: Array<[string, string]> = [];

  for (const entry of entries) {
    const sql = MIGRATION_SQL.get(entry.file) ?? empty;
    // Prose mentions DDL too: a comment can say a table lock is taken or
    // quote a statement it is about to build. Comments go first, or the
    // reference picks up table names that were never created.
    const code = stripSqlComments(sql);

    for (const m of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+LIKE\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      likeSources.set(m[1]!.toLowerCase(), m[2]!.toLowerCase());
    }

    for (const m of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?:ENGINE|;|$)/gi,
    )) {
      columns.set(m[1]!.toLowerCase(), new Set(parseColumnList(m[2] ?? empty)));
    }

    // ALTER TABLE is matched WITHOUT a trailing semicolon. Migration 020,
    // 022 and 027 build their ALTER as a CONCAT whose parts are quoted ADD
    // COLUMN fragments, and the ALTER keyword only appears at the END of
    // that CONCAT — the columns were written 1,600 characters earlier.
    // Reading only what follows the keyword therefore found nothing, and
    // the reference lost every column those migrations add.
    //
    // The statement is taken to END at the next semicolon and to START at
    // the previous one. That is not quite the statement 022 runs — it runs
    // the CONCAT of two halves — but it is the smallest span that contains
    // both halves, and nothing else in this project writes an ALTER whose
    // parts are separated by a semicolon.
    for (const m of code.matchAll(/ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      const table = m[1]!.toLowerCase();
      const body = code;
      const known = columns.get(table) ?? new Set<string>();
      for (const c of body.matchAll(/ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        const column = c[1]!;
        // 022's CONCAT names the table as its first argument:
        // CONCAT('ALTER TABLE etl_runs ', @parts). `etl_runs` there is the
        // table, not a column of itself.
        if (column.toLowerCase() === table) continue;
        known.add(column);
      }
      for (const c of body.matchAll(/DROP\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        drops.push([table, c[1]!.toLowerCase()]);
      }
      columns.set(table, known);
    }
  }

  // A DROP COLUMN anywhere in the migration history ends the column. The
  // name is recorded rather than applied in order, because a drop may be
  // written before the CREATE that re-adds it in a later migration — and
  // the reference has to describe the FINAL state, not the order of steps.
  for (const [table, column] of drops) {
    const known = columns.get(table);
    if (known) known.delete(column);
  }

  // Resolve CREATE TABLE x LIKE y last, so a copy always sees the final
  // column list of its source.
  for (const [name, source] of likeSources) {
    const from = columns.get(source);
    if (from) columns.set(name, new Set(from));
  }

  const tables = new Map<string, readonly string[]>();
  for (const [table, cols] of columns) tables.set(table, [...cols].sort());
  return { tables };
}

const empty = "";

/** Line comments and block comments. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, empty).replace(/\/\*[\s\S]*?\*\//g, empty);
}

/** Column declarations inside a CREATE TABLE body. */
function parseColumnList(body: string): string[] {
  const columns: string[] = [];
  for (const raw of body.split(",")) {
    const line = raw.trim();
    if (line === empty) continue;
    if (/^(PRIMARY\s+KEY|UNIQUE|INDEX|KEY|CONSTRAINT|FOREIGN\s+KEY|FULLTEXT|SPATIAL|CHECK)\b/i.test(line))
      continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(line);
    if (m && m[1]) columns.push(m[1]);
  }
  return columns;
}

/**
 * Compare the live structure against the reference.
 *
 * Reads INFORMATION_SCHEMA rather than SHOW CREATE TABLE: the latter is one
 * statement per table and returns a string that would need re-parsing.
 */
async function readDrift(pool: mysql.Pool, reference: SchemaReference): Promise<SchemaDrift[]> {
  const drift: SchemaDrift[] = [];
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()",
  );
  const live = new Map<string, Set<string>>();
  for (const row of rows as unknown as { t: string; c: string }[]) {
    const table = row.t.toLowerCase();
    if (!live.has(table)) live.set(table, new Set());
    live.get(table)!.add(row.c.toLowerCase());
  }
  for (const [table, expected] of reference.tables) {
    const actual = live.get(table);
    if (!actual) {
      drift.push({ table, kind: "missing_table", column: null });
      continue;
    }
    for (const column of expected) {
      if (!actual.has(column.toLowerCase())) {
        drift.push({ table, kind: "missing_column", column });
      }
    }
  }
  return drift;
}

export async function getSchemaReport(pool: mysql.Pool): Promise<SchemaReport> {
  // The entries are awaited BEFORE the reference is derived, so the
  // reference and the ledger are read from the same settled manifest.
  // Deriving first and listing second could mix a half-loaded manifest
  // with a loaded one.
  const entries = await listMigrationEntries();
  return getSchemaReportFrom(pool, buildSchemaReference(entries), entries);
}

/** The same report against an explicit reference. The console and the health
 *  check use the derived one; a caller that already holds a reference can
 *  pass it here so the report compares the database against that reference
 *  rather than re-deriving one. */
export async function getSchemaReportFrom(
  pool: mysql.Pool,
  reference: SchemaReference,
  entriesOverride?: readonly MigrationEntry[],
): Promise<SchemaReport> {
  const entries = entriesOverride ?? (await listMigrationEntries());
  const latest = entries[entries.length - 1] ?? null;
  let appliedVersions: Set<string>;
  try {
    appliedVersions = await getAppliedVersions(pool);
  } catch (err) {
    return {
      applied: [],
      pending: entries.map((entry) => ({ entry, reason: "not_applied" as const })),
      pendingCount: entries.length,
      isCurrent: false,
      latest,
      appliedLatest: null,
      error: describeMigrationError(err),
      hasLockRisk: true,
      drift: [],
      structureError: null,
    };
  }
  const applied = entries.filter((e) => appliedVersions.has(e.version));
  const pending = entries
    .filter((e) => !appliedVersions.has(e.version))
    .map((entry) => ({ entry, reason: "not_applied" as const }));
  // The structure check is separate from the ledger check, and it must not
  // report a clean diff when it could not run. `isCurrent` needs BOTH: a
  // database whose ledger is complete but whose `settings` table is missing
  // a column is not in step with this code.
  let drift: SchemaDrift[] = [];
  let structureError: string | null = null;
  try {
    drift = await readDrift(pool, reference);
  } catch (err) {
    structureError = describeMigrationError(err);
  }
  return {
    applied,
    pending,
    pendingCount: pending.length,
    hasLockRisk: pending.some((p) => p.entry.takesTableLock),
    isCurrent: pending.length === 0 && drift.length === 0 && structureError === null,
    latest,
    appliedLatest: applied[applied.length - 1] ?? null,
    error: null,
    drift,
    structureError,
  };
}

/** A short reason the ledger could not be read. Mirrors `describeDbError` in
 *  `src/api/dbBootstrap.ts` without importing the web layer into storage. */
function describeMigrationError(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    if (code === "ECONNREFUSED") return "the server refused the connection";
    if (code === "ER_ACCESS_DENIED_ERROR") return "the credentials were rejected";
    if (code === "ER_BAD_DB_ERROR") return "that database does not exist";
    if (code === "ETIMEDOUT") return "the connection timed out";
    if (code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH")
      return "the host is unreachable";
  }
  return err instanceof Error ? err.message : "unknown error";
}

export async function migrationStatus(pool: mysql.Pool): Promise<{
  applied: string[];
  pending: string[];
}> {
  const files = await settledFiles();
  const allVersions = files.map(versionOf);
  const applied = await getAppliedVersions(pool);
  return {
    applied: allVersions.filter((v) => applied.has(v)),
    pending: allVersions.filter((v) => !applied.has(v)),
  };
}

export async function listMigrationFiles(): Promise<string[]> {
  return [...(await settledFiles())];
}
