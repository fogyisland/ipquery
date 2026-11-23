// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { createPool, runMigrations, recordEtlStart, recordEtlFinish } from "../../src/storage/mysql";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_stats_test";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;

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
  const id = await recordEtlStart(pool);
  await recordEtlFinish(pool, id, "success", { mergedRecords: 42, dbipRecords: 30 });
  await pool.end();
  app = await buildServer(cfg);
});
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

describe("stats route", () => {
  it("returns last run summary", async () => {
    const res = await request(app.server).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body.lastRun.status).toBe("success");
    expect(res.body.lastRun.mergedRecords).toBe(42);
  });
  it("stats and MCP keep the DB-IP-only dbip counter", async () => {
    // `mergedRecords` counts every row that reached the live table,
    // including the GitHub-sourced ones. `sources.dbip.records` must
    // keep meaning "rows that came from the DB-IP files" — widening it
    // would make the "which source is this row from" question
    // unanswerable on the run page.
    const res = await request(app.server).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body.lastRun.mergedRecords).toBe(42);
    expect(res.body.lastRun.sources.dbip.records).toBe(30);
    expect(res.body.lastRun.sources.dbip.records).not.toBe(res.body.lastRun.mergedRecords);
  });
  it("reports the sources the pipeline runs, and no others", async () => {
    // The old response advertised MaxMind and ip2region next to DB-IP.
    // Neither was ever fetched or parsed: the live table's
    // `country_source` column held `dbip` and `dbip-country` and
    // nothing else. The source list is now derived from the pipeline's
    // own file table, so a source that is not wired in cannot be
    // advertised.
    const res = await request(app.server).get("/stats");
    expect(res.status).toBe(200);
    const sources = res.body.lastRun.sources as Record<string, unknown>;
    expect(sources.ip2region).toBeUndefined();
    expect(sources.maxmind).toBeUndefined();
    // The DB-IP counter is still there — it is the one counter the run
    // row actually carries.
    expect(sources.dbip).toBeDefined();
    expect((sources.dbip as { records: number }).records).toBe(30);
  });
});
