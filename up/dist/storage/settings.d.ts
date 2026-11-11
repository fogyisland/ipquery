import type { Pool } from "mysql2/promise";
/**
 * Read one setting, or null when it has never been written.
 *
 * A missing `settings` table also reads as null. On a genuinely fresh install
 * the schema does not exist yet — the first-run wizard is what migrates it —
 * and several plugins read settings from `buildServer()` (the random-IP
 * runner syncs its timer, the circuit breaker loads its thresholds). Throwing
 * ER_NO_SUCH_TABLE there crashes the server on the only path that can create
 * the table. Every such reader treats null as "use the default", which is the
 * correct answer for a database that has no settings yet.
 *
 * Other database errors still propagate: a dropped connection must not
 * masquerade as a default configuration.
 */
export declare function getSetting(pool: Pool, key: string): Promise<string | null>;
/** Write one setting, creating the row if it does not exist. */
export declare function setSetting(pool: Pool, key: string, value: string): Promise<void>;
/**
 * Has this install been through the first-run wizard?
 *
 * An empty database — tables not created yet — counts as "not initialized".
 * This matters because initGuard calls this at `buildServer()` time, and a
 * genuinely fresh install has nothing but an empty schema for the wizard to
 * run migrations into. Letting ER_NO_SUCH_TABLE escape crashes the server on
 * the one path that is supposed to bootstrap it: the operator cannot reach
 * /init to run the migrations that would create this table, and cannot run
 * the migrations without a server. Any other database error still throws —
 * a dropped connection must not be reported as "fresh install".
 */
export declare function isInitialized(pool: Pool): Promise<boolean>;
export declare function markInitialized(pool: Pool): Promise<void>;
