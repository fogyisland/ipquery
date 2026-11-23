// SPDX-License-Identifier: MIT
//
// Two guarantees this file locks down:
//
//  1. A fresh database has NO demo rows. The demo rows used to be
//     inserted by migration 012, so every production install carried
//     them whether the operator wanted them or not — a database that
//     "skipped" seeding still answered /lookup for 8.8.8.8 and looked
//     populated. They are now opt-in.
//
//  2. An ETL run does not delete hand-authored rows. The ETL rebuilds
//     ip_ranges from the DB-IP files, which never contain the
//     unknown-IP backfill's 'multi-provider' rows. Without the
//     preservation step, every refresh silently dropped them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createPool, runMigrations, findRange, preserveManualRows } from "../../src/storage/mysql";
import { loadDemoSeed } from "../../src/storage/seed/demoSeed";
import { runPipeline, type DownloadStage } from "../../src/etl/pipeline";
import { loadConfig } from "../../src/config";

// Every source file the pipeline expects to find on disk after the download
// stage. Each one is a real, parseable file — the pipeline re-checks every
// one of them after the download stage and refuses to swap if any is
// missing.
//
// The four GitHub-hosted lists refresh on EVERY run by design — the
// pipeline calls the fixed-file downloader whether or not a cached copy
// exists, so it always has the latest China ranges. That makes any test
// that runs the pipeline without a seam a network test: a slow or blocked
// fetch stalls the run for up to 120s per URL and then fails it.
//
// The DB-IP monthly files are the other half. The `downloadFixed` seam
// only covers the four GitHub lists; the monthly DB-IP files go through
// the ordinary download stage, so they need the bigger `download` seam to
// stay off the network. The real city-lite file is 81.7 MB and 7,777,815
// rows: downloading it took 65 s, parsing it 73 s, and inserting it about
// five minutes — so the test blew the 180 s timeout, and the ETL run it
// had started held the run lock, which turned the next three tests into
// `EtlRunLockedError: an ETL run is already in progress`.
//
// One seam writes all seven files, because the `download` seam replaces
// the WHOLE download stage — including the fixed-file refresh the real
// stage performs. A seam that wrote only the three DB-IP files would
// leave the four GitHub files missing, and the pipeline refuses to swap
// when a source file is absent.
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  // DB-IP city-lite column layout: start, end, continent, country, region,
  // city, lat, lon. The parser indexes cols[3] as country (cols[2] is the
  // continent it ignores), so the column order matters.
  "dbip.csv.gz":
    "ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n" +
    "9.9.9.0,9.9.9.255,EU,GB,England,London,51.5074,-0.1278\n",
  "dbip-country.csv.gz": "ip_start,ip_end,country\n9.9.9.0,9.9.9.255,GB\n",
  "dbip-asn.csv.gz":
    "start_ip,end_ip,asn,asn_name\n9.9.9.0,9.9.9.255,64500,Example ISP\n",
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
 * them), and the month sidecar is written so the stage records the file
 * as "already the newest release" the way a cached file does.
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

/** A pipeline run against the on-disk fixtures, with no network. */
const runOffline = () => runPipeline({ cfg, download: stageFixtures });

const TEST_DB = "ipquery_test_seed";
let pool: mysql.Pool;
const cfg = loadConfig();

/** A 16-byte right-aligned IPv4 address, the form every runtime path
 *  uses to store an IPv4 in the BINARY(16) columns. */
function ipBytes(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  return Buffer.concat([Buffer.alloc(12), Buffer.from(parts)]);
}

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  cfg.etl.dataDir = path.join(__dirname, "..", "tmp-seed-data");
  await fs.mkdir(cfg.etl.dataDir, { recursive: true });

  // The source files are NOT written here: the download seam stages all
  // seven of them into the raw directory when the ETL runs. 9.9.9.0/24 is
  // the ETL's row; 8.8.4.4 will be the manual row.

  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  pool = createPool(cfg);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
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

async function countBySource(source: string): Promise<number> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = ?",
    [source],
  );
  return Number(rows[0]?.n ?? 0);
}

describe("demo data is opt-in", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM ip_ranges WHERE country_source = 'seed'");
  });

  it("a migrated database contains no demo rows", async () => {
    // This is the regression this whole change exists to prevent: the
    // demo rows used to be inserted by migration 012, so `migrate`
    // alone populated the table.
    expect(await countBySource("seed")).toBe(0);
  });

  it("loadDemoSeed adds the 50 demo rows", async () => {
    const result = await loadDemoSeed(pool);
    expect(result.total).toBe(50);
    expect(result.added).toBe(50);
    expect(await countBySource("seed")).toBe(50);
  });

  it("loadDemoSeed is idempotent", async () => {
    await loadDemoSeed(pool);
    const second = await loadDemoSeed(pool);
    expect(second.added).toBe(0);
    expect(second.total).toBe(50);
    expect(await countBySource("seed")).toBe(50);
  });

  it("the demo rows are reachable through /lookup's query path", async () => {
    await loadDemoSeed(pool);
    // 8.8.8.8 was one of the demo rows. If the byte order were wrong
    // (the four address bytes left-aligned instead of right-aligned),
    // findRange would not match it — the bug migration 023 repaired.
    const row = await findRange(pool, ipBytes("8.8.8.8"));
    expect(row?.countryCode).toBe("US");
    expect(row?.city).toBe("Mountain View");
  });

  it("migration 025 removed the demo rows an older 012 had inserted", async () => {
    // Simulate a database that ran the OLD migration 012: the demo rows
    // are present with the old encoding (four bytes, left-aligned).
    const leftAligned = Buffer.concat([Buffer.from([8, 8, 8, 8]), Buffer.alloc(12)]);
    await pool.query(
      `INSERT IGNORE INTO ip_ranges
         (start_ip, end_ip, country_code, country_name, region, city,
          country_source, city_source)
       VALUES (?, ?, 'US', 'United States', 'California', 'Mountain View',
               'seed', 'seed')`,
      [leftAligned, leftAligned],
    );
    expect(await countBySource("seed")).toBe(1);

    // 025 has already run in this database, so re-running the DELETE
    // is what the migration does. It must remove only the demo rows.
    await pool.query("DELETE FROM ip_ranges WHERE country_source = 'seed'");
    expect(await countBySource("seed")).toBe(0);
  });

  // The demo rows are only for an EMPTY database. INSERT IGNORE makes a
  // re-run idempotent for the demo rows themselves, but it does nothing
  // about a table that already holds real address data: the demo ranges
  // do not collide with the ETL's on uniq_start_end, so all 50 would be
  // inserted alongside them. A lookup for 8.8.8.8 would then answer from
  // the demo row ("Mountain View") instead of from the real library —
  // populated, and wrong.
  it("loadDemoSeed skips a table that already holds real rows", async () => {
    await pool.query("DELETE FROM ip_ranges");
    // A real-looking row that does NOT overlap any demo range.
    const real = Buffer.concat([Buffer.from([11, 0, 0, 0]), Buffer.alloc(12)]);
    const realEnd = Buffer.concat([Buffer.from([11, 255, 255, 255]), Buffer.alloc(12)]);
    await pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (?, ?, 16777216, 'GB', 'dbip-city')`,
      [real, realEnd],
    );

    const result = await loadDemoSeed(pool);

    expect(result.skipped).toBe(true);
    expect(result.added).toBe(0);
    expect(result.skipReason).toContain("non-demo");
    expect(await countBySource("seed")).toBe(0);
    // The real row is untouched.
    expect(await countBySource("dbip-city")).toBe(1);
  });

  it("loadDemoSeed still loads into an empty table", async () => {
    await pool.query("DELETE FROM ip_ranges");
    const result = await loadDemoSeed(pool);
    expect(result.skipped).toBeFalsy();
    expect(result.added).toBe(50);
    expect(await countBySource("seed")).toBe(50);
  });

  it("loadDemoSeed stays idempotent once the demo rows are in", async () => {
    await pool.query("DELETE FROM ip_ranges");
    await loadDemoSeed(pool);
    const second = await loadDemoSeed(pool);
    // The demo rows are not "real" rows, so the guard does not fire — the
    // INSERT IGNORE path handles it, and nothing is added.
    expect(second.skipped).toBeFalsy();
    expect(second.added).toBe(0);
    expect(await countBySource("seed")).toBe(50);
  });
});

describe("ETL preserves hand-authored rows", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM ip_ranges");
  });

  it("a 'multi-provider' row survives an ETL run", async () => {
    // This is the bug: the ETL truncates the staging table, streams the
    // DB-IP files into it, and renames it over ip_ranges. A row the
    // unknown-IP backfill wrote — which no DB-IP file will ever contain
    // — was destroyed by that rename, with the run reported as success.
    const manual = ipBytes("8.8.4.4");
    await pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 1, 'US', 'United States',
               'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
      [manual, manual],
    );
    expect(await countBySource("multi-provider")).toBe(1);

    await runOffline();

    expect(await countBySource("multi-provider")).toBe(1);
    const row = await findRange(pool, manual);
    expect(row?.countrySource).toBe("multi-provider");
    expect(row?.countryCode).toBe("US");
  });

  it("the ETL's own rows still land, and the demo rows stay gone", async () => {    await runOffline();
    // The ETL row for 9.9.9.5 must be present after the run.
    const row = await findRange(pool, ipBytes("9.9.9.5"));
    expect(row?.countryCode).toBe("GB");
    expect(row?.city).toBe("London");
    // And the ETL must not have reintroduced the demo rows.
    expect(await countBySource("seed")).toBe(0);
  });

  it("a manual row wins over a coarser ETL range covering the same address", async () => {
    // The manual row is a single address (/32, range_size 1); the ETL's
    // row is the whole /24 (range_size 256). The manual row is more
    // precise, so it answers — that is the entire point of the
    // backfill: the DB-IP library had nothing for that address and a
    // multi-provider lookup found a better answer. The seed demotion
    // in findRange applies to 'seed' rows only, because those are
    // fabricated; 'multi-provider' rows are real findings and compete
    // on specificity like everything else.
    const manual = ipBytes("9.9.9.5");
    await pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 1, 'XX', 'Nowhere',
               'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
      [manual, manual],
    );

    await runOffline();

    const row = await findRange(pool, manual);
    expect(row?.countrySource).toBe("multi-provider");
    expect(row?.countryCode).toBe("XX");
    // The ETL's own row is still in the table — the manual row did not
    // displace it from the library, it only won the lookup.
    const etlRow = await findRange(pool, ipBytes("9.9.9.200"));
    expect(etlRow?.countrySource).toBe("dbip");
    expect(etlRow?.city).toBe("London");
  });
});

describe("preservation does not duplicate", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM ip_ranges");
  });

  it("a manual row with the exact same range as an ETL row is not inserted twice", async () => {
    // The ETL's fixture covers 9.9.9.0-9.9.9.255. A manual row with
    // exactly that range would collide on uniq_start_end, so the
    // preservation step must skip it — otherwise the INSERT IGNORE
    // silently drops it and the row count would be right by accident
    // while the logic was wrong.
    const start = ipBytes("9.9.9.0");
    const end = ipBytes("9.9.9.255");
    await pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 256, 'XX', 'Nowhere',
               'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
      [start, end],
    );

    await runOffline();

    // Exactly one row for that range — the ETL's.
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT country_source FROM ip_ranges WHERE start_ip = ? AND end_ip = ?`,
      [start, end],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.country_source).toBe("dbip");
  });

  it("running the ETL twice does not accumulate duplicate manual rows", async () => {
    const manual = ipBytes("8.8.4.4");
    await pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 1, 'US', 'United States',
               'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
      [manual, manual],
    );

    await runOffline();
    await runOffline();

    expect(await countBySource("multi-provider")).toBe(1);
  });
});

describe("preserveManualRows reports its counts", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM ip_ranges");
    await pool.query("DELETE FROM ip_ranges_new");
  });

  it("counts carried-over rows and rows the ETL already covered", async () => {
    // One manual row the ETL's fixture does not cover (8.8.4.4) and
    // one it does cover exactly (9.9.9.0-9.9.9.255).
    const manual = ipBytes("8.8.4.4");
    await pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 1, 'US', 'United States',
               'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
      [manual, manual],
    );

    // Stage the ETL's row so the conflict path has something to hit.
    await pool.query(
      `INSERT INTO ip_ranges_new
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 256, 'GB', 'United Kingdom',
               'dbip', 'dbip', 'dbip', 'dbip', 'dbip')`,
      [ipBytes("9.9.9.0"), ipBytes("9.9.9.255")],
    );

    const result = await preserveManualRows(pool);
    expect(result.preserved).toBe(1);
    expect(result.conflicts).toBe(0);

    // Now stage a row that collides exactly with the manual one. The
    // staging table is cleared first: the previous call already copied
    // the manual row across, and uniq_start_end would reject a second
    // copy of the same range.
    await pool.query("DELETE FROM ip_ranges_new");
    await pool.query(
      `INSERT INTO ip_ranges_new
         (start_ip, end_ip, range_size, country_code, country_name,
          country_source, city_source, isp_source, asn_source, geo_source)
       VALUES (?, ?, 1, 'GB', 'United Kingdom',
               'dbip', 'dbip', 'dbip', 'dbip', 'dbip')`,
      [manual, manual],
    );

    const second = await preserveManualRows(pool);
    // The colliding row is skipped — the ETL's version wins.
    expect(second.preserved).toBe(0);
    expect(second.conflicts).toBe(1);
  });
});
