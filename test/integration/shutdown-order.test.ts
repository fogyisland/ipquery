// SPDX-License-Identifier: MIT
//
// Shutdown must close the database pool LAST.
//
// Fastify runs `onClose` hooks in REVERSE registration order. The
// plugins that buffer state on shutdown — the session purger (final
// sweep of expired sessions), the query-log writer (final batch of
// buffered log rows) — all need an open pool. When the pool-close hook
// was registered last in buildServer(), it ran FIRST, and every one of
// those flushes hit "Pool is closed.":
//
//   * the session purger logged a spurious error on every shutdown;
//   * the query-log writer silently dropped whatever was still in its
//     buffer, because its flush() catches the error and only logs it.
//
// This test pins the ordering: closing the app must not produce a
// "Pool is closed" error, and the session purger's final sweep must
// actually reach the database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { runMigrations } from "../../src/storage/migrations/runner";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_test_shutdown_order";

describe("shutdown ordering", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const cfg = loadConfig();

  beforeAll(async () => {
    cfg.db.database = TEST_DB;
    const root = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await root.query(`CREATE DATABASE \`${TEST_DB}\``);
    await root.end();
    const pool = mysql.createPool({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: TEST_DB,
      connectionLimit: 2,
      multipleStatements: true,
      timezone: "Z",
      dateStrings: false,
    });
    await runMigrations(pool);
    await markInitialized(pool);
    await pool.end();
    app = await buildServer(cfg);
  }, 120_000);

  afterAll(async () => {
    const root = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await root.end();
  });

  it("closes the pool after the plugins that flush on shutdown", async () => {
    const errorLogs: Array<Record<string, unknown>> = [];

    // Swap the logger's error method for the duration of the close so
    // the test can inspect what was reported. The original is restored
    // immediately afterwards; the app is closed by this point anyway.
    const originalError = app.log.error.bind(app.log);
    app.log.error = ((obj: unknown, msg?: string) => {
      errorLogs.push({ obj, msg });
      return originalError(obj, msg);
    }) as typeof app.log.error;

    await app.close();

    const poolClosedLogs = errorLogs.filter((entry) => {
      const obj = entry.obj as { err?: { message?: string } } | undefined;
      return obj?.err?.message === "Pool is closed." || entry.msg?.includes("Pool is closed") === true;
    });
    expect(poolClosedLogs, "no plugin may touch the pool after it is closed").toHaveLength(0);
  }, 60_000);
});
