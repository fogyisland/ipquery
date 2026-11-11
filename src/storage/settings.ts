// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

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
export async function getSetting(pool: Pool, key: string): Promise<string | null> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT v FROM settings WHERE k = ?`, [key]);
    const r = rows[0] as { v: string } | undefined;
    return r ? r.v : null;
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

/** Write one setting, creating the row if it does not exist. */
export async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO settings (k, v) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [key, value],
  );
}

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
export async function isInitialized(pool: Pool): Promise<boolean> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM settings WHERE k = 'initialized_at' LIMIT 1`,
    );
    return rows.length > 0;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

/** ER_NO_SUCH_TABLE (1146) — the table has not been migrated into existence. */
function isMissingTableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const errno = (err as { errno?: unknown }).errno;
  return code === "ER_NO_SUCH_TABLE" || errno === 1146;
}

export async function markInitialized(pool: Pool): Promise<void> {
  await setSetting(pool, "initialized_at", new Date().toISOString());
}
