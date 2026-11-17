import * as mysql from "mysql2/promise";
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
/** Re-read the manifest. Only tests need this — the production path loads
 *  the manifest once at startup and the files never change under it. */
export declare function reloadMigrationManifest(): Promise<void>;
/** Load the manifest from an explicit directory. Test-only: it lets a test
 *  point at a directory with no migrations in it. */
export declare function loadMigrationManifestFrom(migrationsDir: string): Promise<void>;
export declare function listMigrationEntries(): readonly MigrationEntry[];
export declare function getAppliedVersions(pool: mysql.Pool): Promise<Set<string>>;
export interface MigrationResult {
    applied: string[];
    skipped: string[];
}
export declare function runMigrations(pool: mysql.Pool): Promise<MigrationResult>;
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
 * `src/storage/migrations/REFERENCE.md` is generated from this by
 * `scripts/schema-reference.js`. Keeping it as SQL-derived data rather
 * than a hand-written file is the same reasoning as `classify`: a
 * hand-maintained manifest is the thing that goes stale the moment a
 * migration is added, and then the drift check reports a deployment as
 * broken when it is exactly right.
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
export declare function buildSchemaReference(entries: readonly MigrationEntry[]): SchemaReference;
export declare function getSchemaReport(pool: mysql.Pool): Promise<SchemaReport>;
/** The same report against an explicit reference. The console and the health
 *  check use the derived one; `scripts/schema-reference.js` uses the same
 *  builder, so the document and the check cannot disagree. */
export declare function getSchemaReportFrom(pool: mysql.Pool, reference: SchemaReference): Promise<SchemaReport>;
export declare function migrationStatus(pool: mysql.Pool): Promise<{
    applied: string[];
    pending: string[];
}>;
export declare function listMigrationFiles(): Promise<string[]>;
