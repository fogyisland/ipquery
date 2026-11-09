// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import request from "supertest";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { runPipeline } from "../../src/etl/pipeline";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_e2e_test";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  cfg.etl.dataDir = path.join(__dirname, "..", "tmp-data-e2e");
  const rawDir = path.join(cfg.etl.dataDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });
  // DB-IP city-lite column layout: start, end, continent, country, region,
  // city, lat, lon. Parser indexes cols[3] as country (cols[2] is the
  // continent we ignore), so the column order matters.
  const csv =
    "ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n8.8.8.0,8.8.8.255,NA,US,California,Mountain View,37.4056,-122.0775\n";
  await fs.writeFile(path.join(rawDir, "dbip.csv.gz"), zlib.gzipSync(Buffer.from(csv)));
  await fs.writeFile(
    path.join(rawDir, "ip2region.xdb"),
    JSON.stringify([{ start: "8.8.8.0", end: "8.8.8.255", country: "美国", city: "Mountain View" }]),
  );
  await fs.copyFile(
    path.join(__dirname, "..", "..", "fixtures", "maxmind-sample.mmdb"),
    path.join(rawDir, "maxmind.mmdb"),
  );

  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();

  await runPipeline({ cfg });
  const postPool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 1,
  });
  await markInitialized(postPool);
  await postPool.end();
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
  await fs.rm(cfg.etl.dataDir, { recursive: true, force: true });
});

describe("end-to-end flow", () => {
  it("/healthz returns ok", async () => {
    const r = await request(app.server).get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("/lookup returns the seeded record", async () => {
    const r = await request(app.server).get("/lookup").query({ ip: "8.8.8.8" });
    expect(r.status).toBe(200);
    expect(r.body.country.code).toBe("US");
  });

  it("/stats reports the run", async () => {
    const r = await request(app.server).get("/stats");
    expect(r.status).toBe(200);
    expect(r.body.lastRun.status).toBe("success");
  });
});
