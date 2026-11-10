// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { isInitialized } from "../../src/storage/settings";

/**
 * A genuinely fresh install has an empty database: not a single table, because
 * the first-run wizard is what runs the migrations.
 *
 * setupGuard calls isInitialized() from buildServer(), so on an empty schema
 * the server used to die with ER_NO_SUCH_TABLE and exit before it could serve
 * /setup — the only page that can create the table it just failed to read.
 * The operator was left with no way in.
 *
 * This file deliberately does NOT call runMigrations(): that is the whole
 * point. Every other integration test migrates first and therefore cannot
 * exercise this path.
 */
const DB_NAME = "ipquery_test_fresh_boot";

async function createEmptyDatabase(): Promise<mysql.Pool> {
  const cfg = loadConfig();
  const conn = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    multipleStatements: true,
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await conn.query(`CREATE DATABASE \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4`);
  await conn.end();

  return mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: DB_NAME,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
}

let pool: mysql.Pool;
let rootConn: mysql.Connection;

beforeAll(async () => {
  const cfg = loadConfig();
  // Keep a second handle around so the database can be dropped after the
  // server's own pool has ended.
  rootConn = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  pool = await createEmptyDatabase();
});

afterAll(async () => {
  if (pool) await pool.end();
  if (rootConn) {
    await rootConn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await rootConn.end();
  }
});

describe("fresh boot against an empty database", () => {
  it("treats a schema with no tables as not initialized", async () => {
    const [tables] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?`,
      [DB_NAME],
    );
    expect(Number((tables[0] as { n: number }).n)).toBe(0);

    await expect(isInitialized(pool)).resolves.toBe(false);
  });

  it("builds the server instead of crashing on the missing settings table", async () => {
    const cfg = loadConfig();
    cfg.db.database = DB_NAME;
    // buildServer() registers setupGuard, which reads `settings`. Before the
    // fix this threw ER_NO_SUCH_TABLE and the process exited.
    const app = await buildServer(cfg);
    await expect(app.ready()).resolves.toBeInstanceOf(Object);
    await app.close();
  });

  it("does not swallow real database errors as a fresh install", async () => {
    // A closed pool raises a different error code. If isInitialized caught
    // everything, a broken database would look like a brand-new one and the
    // wizard would happily overwrite a live install.
    const deadPool = mysql.createPool({
      host: "127.0.0.1",
      port: 1,
      user: "nobody",
      password: "nothing",
      database: "nonexistent",
      connectionLimit: 1,
      connectTimeout: 1000,
    });
    await expect(isInitialized(deadPool)).rejects.toThrow();
    await deadPool.end().catch(() => undefined);
  });
});
