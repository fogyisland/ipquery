// SPDX-License-Identifier: MIT
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { markInitialized } from "../../src/storage/settings";
import { createPoolFor } from "../../src/storage/mysql";

export interface TestDb {
  pool: mysql.Pool;
  dbName: string;
}

/**
 * The prefix every database this helper creates carries.
 *
 * It is the guard that keeps the cleanup from touching anything else:
 * `dropTestDb` refuses to act on a name that does not start with it.
 */
const TEST_DB_PREFIX = "ipquery_test_";

/**
 * A suffix that is unique to this process AND this moment.
 *
 * The test database is created under a fresh name rather than
 * dropping a fixed one first. The reason is lock lifetime: `DROP
 * DATABASE` needs an EXCLUSIVE metadata lock on every table, so if a
 * previous run left a connection open — one still holding a table lock
 * because the test timed out before its `finally` ran — the DROP queues
 * behind it for the server's year-long default, and the suite hangs
 * before a single assertion executes.
 *
 * A unique name sidesteps that entirely: this run's database has never
 * been touched, so nothing can be holding it.
 *
 * The cost is that old databases can linger when a run dies mid-test.
 * `dropTestDb` cleans up on the way out, and a database that survives
 * that is inert — it holds no lock that anything else waits on.
 */
function uniqueSuffix(suffix: string): string {
  const stamp = Date.now().toString(36);
  const pid = String(process.pid);
  return `${suffix}_${pid}_${stamp}`;
}

export async function createTestDb(suffix: string): Promise<TestDb> {
  const cfg = loadConfig();
  const dbName = `${TEST_DB_PREFIX}${uniqueSuffix(suffix)}`;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`CREATE DATABASE \`${dbName}\``);
  await root.end();
  // createPoolFor, not mysql.createPool: the production pool arms a
  // bounded metadata-lock timeout on every connection, and a test that
  // used a bare pool would not exercise the same behaviour. A test
  // that waits a year is a test that hangs.
  const pool = createPoolFor({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: dbName,
    poolSize: 2,
  });
  await runMigrations(pool);
  await markInitialized(pool);
  return { pool, dbName };
}

/**
 * Drop a test database.
 *
 * `DROP DATABASE` needs an EXCLUSIVE metadata lock on every table in
 * the database. If any connection is still open on it — a holder from
 * a test that timed out before its `finally` ran, a pool connection
 * the test forgot to release — the DROP queues behind it and waits for
 * MySQL's year-long default. The test then times out in `afterAll`,
 * which looks like a broken test rather than a leaked connection.
 *
 * So the DROP gets a bounded wait of its own: a cleanup step that
 * hangs forever is worse than one that fails. If it cannot get the
 * lock in time, the database is left behind — inert, holding no lock
 * that anything else waits on, and reaped on the next sweep.
 *
 * This only ever touches a database whose name starts with
 * `ipquery_test_`. A name that does not is a programming error and
 * throws rather than dropping somebody's data.
 */
export async function dropTestDb(td: TestDb): Promise<void> {
  if (!td.dbName.startsWith(TEST_DB_PREFIX)) {
    throw new Error(
      `refusing to drop ${td.dbName}: only ${TEST_DB_PREFIX}* databases may be dropped by the test helper`,
    );
  }

  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  try {
    // Close the pool first: its connections are the ones most likely
    // to still hold a table lock.
    await td.pool.end();

    // Bound the DROP's own wait. The metadata-lock timeout is what
    // governs this; without it a leftover lock would park the cleanup
    // for the server's year-long default.
    await root.query("SET SESSION lock_wait_timeout = 5");
    await root
      .query(`DROP DATABASE IF EXISTS \`${td.dbName}\``)
      .catch((err: unknown) => {
        // Leaving an orphan test database behind is a nuisance, not a
        // failure. Failing the test over it would bury the real
        // result — which is whatever assertion this run actually
        // cared about.
        console.warn(
          `[test-db] could not drop ${td.dbName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  } finally {
    await root.end();
  }
}
