// SPDX-License-Identifier: MIT
//
// The end-to-end flow: run the ETL, then serve the library over HTTP.
//
// The ETL stage is driven against LOCAL FIXTURES, not the network. This
// used to call the real download stage, which fetched the actual DB-IP
// city-lite file — 81.7 MB, 7,777,815 rows. The suite then needed about
// 65 s to download it, 73 s to parse it, and roughly five minutes to
// insert it, so the `beforeAll` hook blew the 180 s timeout and the file
// was reported as a failure.
//
// The fixture it wrote was never even used: the download stage overwrote
// it with the real file. So the test was a production ETL run wearing an
// e2e test's name — slow, network-dependent, and dependent on the machine
// being able to reach GitHub.
//
// The seam below writes the same fixtures the pipeline expects, so the
// flow under test is the real one: download stage → parse → insert →
// swap → serve. Only the bytes come from the disk.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import request from "supertest";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { runPipeline, type DownloadStage } from "../../src/etl/pipeline";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_e2e_test";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;

/** Every source file the pipeline expects to find on disk after the
 *  download stage. Each one is a real, parseable file — the pipeline
 *  re-checks every one of them and refuses to swap if any is missing.
 *
 *  DB-IP city-lite column layout: start, end, continent, country, region,
 *  city, lat, lon. The parser indexes cols[3] as country (cols[2] is the
 *  continent it ignores), so the column order matters. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "dbip.csv.gz":
    "ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n" +
    "8.8.8.0,8.8.8.255,NA,US,California,Mountain View,37.4056,-122.0775\n",
  "dbip-country.csv.gz": "ip_start,ip_end,country\n8.8.8.0,8.8.8.255,US\n",
  "dbip-asn.csv.gz": "start_ip,end_ip,asn,asn_name\n8.8.8.0,8.8.8.255,64500,Example ISP\n",
  // The four GitHub-hosted lists. A CIDR list wants one prefix per line;
  // the country CSV wants start,end,country.
  "china-ipv4.txt": "198.18.0.0/15\n",
  "china-v4.txt": "198.18.0.0/15\n",
  "china-v6.txt": "# CN IPv6 List\n2001:db8::/32\n",
  "sapics-user-country.csv": "203.0.113.0,203.0.113.255,AU\n",
};

/**
 * The download stage, replaced by one that writes the fixtures.
 *
 * It honours the same contract as the real stage: the files land in
 * `rawDir`, the gzip ones are genuine gzip (the pipeline validates
 * them), and the month sidecar is written so the stage records a
 * `skipped` row the way a cached file does.
 */
const stageFixtures: DownloadStage = async (
  _pool,
  _runId,
  rawDir,
  _now,
  _sink,
  _specs,
) => {
  await fs.mkdir(rawDir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURE_FILES)) {
    const isGzip = name.endsWith(".gz");
    await fs.writeFile(
      path.join(rawDir, name),
      isGzip ? zlib.gzipSync(Buffer.from(body)) : Buffer.from(body),
    );
    // The month sidecar is what makes the download stage record the
    // file as "already the newest release" rather than as a download.
    if (isGzip) {
      await fs.writeFile(path.join(rawDir, `${name}.month`), "2026-01\n");
    }
  }
  return [];
};

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  cfg.etl.dataDir = path.join(__dirname, "..", "tmp-data-e2e");
  const rawDir = path.join(cfg.etl.dataDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });

  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();

  await runPipeline({ cfg, download: stageFixtures });
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
