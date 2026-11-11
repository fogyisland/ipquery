import type { Pool } from "mysql2/promise";
/** The country_source value that marks every demo row. */
export declare const DEMO_SOURCE = "seed";
export interface DemoSeedResult {
    /** Rows in the table after loading. */
    total: number;
    /** Rows the load actually added. */
    added: number;
}
/** Locates the demo-ranges.sql file.
 *
 *  In the compiled tree it sits next to the migrations under
 *  dist/storage/seed/. In a tsx/tsx-dev run it sits under
 *  src/storage/seed/. Both are resolved so the command works in
 *  development and from the release bundle without a build step in
 *  between.
 */
export declare function findDemoSeedFile(): string | null;
/** Loads the demo rows into ip_ranges. Idempotent: the rows are inserted
 *  with INSERT IGNORE, backed by the uniq_seed UNIQUE index.
 *
 *  Does NOT run migrations — the caller decides when that happens. The
 *  setup wizard runs migrations before reaching the seed step, and the
 *  CLI command runs them itself; doing it here too would hide a
 *  migration failure behind a seed operation.
 */
export declare function loadDemoSeed(pool: Pool): Promise<DemoSeedResult>;
