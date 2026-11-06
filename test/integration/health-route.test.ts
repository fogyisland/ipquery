// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_health_route_test";

describe("health route", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const cfg = loadConfig();
    cfg.api.port = 0;
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
    const app = await buildServer(cfg);
    try {
      const res = await request(app.server).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
