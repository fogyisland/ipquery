// SPDX-License-Identifier: MIT
//
// Error responses must not carry the database's own error text.
//
// Fastify's fallback error handler serialises `error.message` into the
// response body. For a driver error that message is the raw MySQL
// text — table names, column names, the database name, the server's
// MySQL version fingerprint — and `GET /stats` is public and
// unauthenticated. An exhausted connection pool or a missing table was
// enough to hand that to an anonymous caller.
//
// These tests drive real errors through the running server and assert
// the response body is inert.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { createPool, runMigrations } from "../../src/storage/mysql";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_test_error_leak";
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
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  const pool = createPool(cfg);
  await runMigrations(pool);
  await markInitialized(pool);
  await pool.end();
  app = await buildServer(cfg, {
    // A route that queries a table that does not exist, so the query
    // fails with a real MySQL error naming the table. This is the same
    // failure mode as a missing table in production (a migration that
    // was never applied, a typo in a table name, a dropped database) —
    // and it is reachable from an unauthenticated route.
    extraRoutes: async (instance) => {
      instance.get("/__test/sql-error", async () => {
        const [rows] = await instance.pool.query(
          "SELECT * FROM table_that_does_not_exist_secret",
        );
        return rows;
      });
    },
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe("error responses do not leak database internals", () => {
  it("returns a clean 404 for an unknown route without echoing the path", async () => {
    const res = await request(app.server).get("/no-such-route-secret-name");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    // The requested path must not be reflected back.
    expect(res.text).not.toContain("no-such-route-secret-name");
  });

  it("returns a clean 500 when a route hits a SQL error", async () => {
    const res = await request(app.server).get("/__test/sql-error");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
    // The table name and the driver message must not appear.
    expect(res.text).not.toContain("table_that_does_not_exist_secret");
    expect(res.text).not.toContain("ER_NO_SUCH_TABLE");
    expect(res.text).not.toContain("doesn't exist");
  });

  it("does not echo the rejected IP back in a 400", async () => {
    const payload = "not-an-ip-" + "x".repeat(200);
    const res = await request(app.server).get("/lookup").query({ ip: payload });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_ip" });
    expect(res.text).not.toContain(payload);
  });
});
