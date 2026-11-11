// SPDX-License-Identifier: MIT
//
// Regression tests for the ETL safety guards.
//
// Three defects are pinned here:
//
//  1. An ETL run whose downloads all failed must NOT swap an empty
//     table over the live ip_ranges. Before the guard, a total download
//     failure left `present` empty, the parse/insert stages were
//     no-ops, and the RENAME put an empty ip_ranges_new live —
//     replacing millions of rows with nothing.
//
//  2. A failed atomic swap must be reported as a FAILED run. Before
//     the guard, runSwapStage() returned the failed result and the
//     pipeline went on to recordEtlFinish(..., "success"), so
//     lastSuccessfulEtl() treated a stale library as fresh.
//
//  3. Two concurrent ETL runs must not both proceed. They would race
//     on truncateNew + atomicSwapRanges and leave a half-populated
//     ip_ranges behind.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createPool, runMigrations, findRange, lastEtlRun, recordEtlStart } from "../../src/storage/mysql";
import { runPipeline } from "../../src/etl/pipeline";
import { acquireEtlRunLock, findRunningEtlRun } from "../../src/etl/runGuard";
import { loadConfig } from "../../src/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

const TEST_DB = "ipquery_test_etl_guard";
let pool: mysql.Pool;
const cfg = loadConfig();

/** The DB-IP city-lite column layout the parser expects. */
const CSV_HEADER =
  "ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n";
const CSV_ROW = "9.9.9.0,9.9.9.255,EU,GB,England,London,51.5074,-0.1278\n";

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  cfg.etl.dataDir = path.join(__dirname, "..", "tmp-etl-guard");
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
  pool = createPool(cfg);
  await runMigrations(pool);
}, 180_000);

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

/** Lay the fixture files down so the pipeline has something to ingest. */
async function writeFixtures(): Promise<void> {
  const rawDir = path.join(cfg.etl.dataDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(
    path.join(rawDir, "dbip.csv.gz"),
    zlib.gzipSync(Buffer.from(CSV_HEADER + CSV_ROW)),
  );
  // The country-lite and asn-lite fixtures must exist too. The
  // pipeline treats a missing source file as "download it", so without
  // these the download stage reaches out to the real DB-IP servers and
  // the test inserts ~1.2M real rows — which blows the 90s timeout and
  // turns a unit-ish test into a network test.
  await fs.writeFile(
    path.join(rawDir, "dbip-country.csv.gz"),
    zlib.gzipSync(Buffer.from("ip_start,ip_end,country\n9.9.9.0,9.9.9.255,GB\n")),
  );
  await fs.writeFile(
    path.join(rawDir, "dbip-asn.csv.gz"),
    zlib.gzipSync(Buffer.from("start_ip,end_ip,asn,asn_name\n9.9.9.0,9.9.9.255,64500,Example ISP\n")),
  );
  await fs.writeFile(
    path.join(rawDir, "ip2region.xdb"),
    JSON.stringify([{ start: "9.9.9.0", end: "9.9.9.255", country: "英国", city: "London" }]),
  );
  await fs.copyFile(
    path.join(__dirname, "..", "..", "fixtures", "maxmind-sample.mmdb"),
    path.join(rawDir, "maxmind.mmdb"),
  );
}

/** Remove every source file so the pipeline has nothing to parse. */
async function clearFixtures(): Promise<void> {
  const rawDir = path.join(cfg.etl.dataDir, "raw");
  await fs.rm(rawDir, { recursive: true, force: true });
  await fs.mkdir(rawDir, { recursive: true });
}

/** A download stage that fetches nothing. The guard tests remove the
 *  source files on purpose; without this stub the pipeline would fetch
 *  the real DB-IP files from the network and the guards under test would
 *  never fire (and the test would take minutes and download ~90 MB).
 *  This makes the behaviour of the guard independent of whether the
 *  machine has internet access. */
const noDownload = async (): Promise<[]> => [];

describe("etl guards", () => {
  it("runs end-to-end and populates ip_ranges", async () => {
    await writeFixtures();
    const result = await runPipeline({ cfg });
    expect(result.merged).toBeGreaterThan(0);
    const last = await lastEtlRun(pool);
    expect(last?.status).toBe("success");
    // The seeded range must be live.
    const found = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(found).not.toBeNull();
  });

  it("refuses to swap an empty table over the live data", async () => {
    // The live data from the previous test is the thing we must protect.
    const before = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(before).not.toBeNull();

    // Simulate a download that failed halfway: the downloader creates
    // the destination file before the first byte arrives, so a failed
    // fetch leaves a zero-length (or truncated) file behind. The file
    // EXISTS, so a naive "is the file there?" check would let the run
    // through — and the swap would replace the live data with nothing.
    //
    // The fixture is a VALID gzip that contains only the CSV header —
    // exactly what a download that was cut off after the header looks
    // like. It parses cleanly and yields zero records, which is the
    // case the second half of the guard exists for.
    await clearFixtures();
    await fs.writeFile(
      path.join(cfg.etl.dataDir, "raw", "dbip.csv.gz"),
      zlib.gzipSync(Buffer.from(CSV_HEADER)),
    );
    // The other two sources must be present (and non-empty) so the
    // pipeline gets past the download stage and actually reaches the
    // zero-rows guard. A missing file fails earlier, with a different
    // message, and would not test what this test is about.
    await fs.writeFile(
      path.join(cfg.etl.dataDir, "raw", "dbip-country.csv.gz"),
      zlib.gzipSync(Buffer.from("ip_start,ip_end,country\n9.9.9.0,9.9.9.255,GB\n")),
    );
    await fs.writeFile(
      path.join(cfg.etl.dataDir, "raw", "dbip-asn.csv.gz"),
      zlib.gzipSync(Buffer.from("start_ip,end_ip,asn,asn_name\n9.9.9.0,9.9.9.255,64500,Example ISP\n")),
    );

    await expect(runPipeline({ cfg, download: noDownload })).rejects.toThrow(
      /no usable records|no source files|parsed to zero rows/i,
    );

    // The live table must be untouched.
    const after = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(after).not.toBeNull();
    expect(after?.countryCode).toBe(before?.countryCode);

    // And the run must be recorded as failed, not success.
    const last = await lastEtlRun(pool);
    expect(last?.status).toBe("failed");
    expect(last?.errorMessage).toMatch(/no usable records|no source files|parsed to zero rows/i);
  });

  it("leaves the live data in place when a source file is truncated to zero bytes", async () => {
    // The other truncation shape: a zero-length file. The gunzip parser
    // throws ("unexpected end of file") during the parse stage, so the
    // run aborts before the swap. Either way the live table survives —
    // this test pins that the abort happens, not that it happens in a
    // particular place.
    const before = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(before).not.toBeNull();

    await clearFixtures();
    await fs.writeFile(path.join(cfg.etl.dataDir, "raw", "dbip.csv.gz"), Buffer.alloc(0));

    await expect(runPipeline({ cfg, download: noDownload })).rejects.toThrow();

    const after = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(after).not.toBeNull();
    expect(after?.countryCode).toBe(before?.countryCode);

    const last = await lastEtlRun(pool);
    expect(last?.status).toBe("failed");
  });

  it("refuses to swap when no source file is present at all", async () => {
    // The other half of the guard: every download failed and left
    // nothing behind, so `present` is empty.
    const before = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(before).not.toBeNull();

    // Make `raw` a regular FILE. The downloader's `mkdir(raw, {recursive:
    // true})` then fails, so no download can land and no file appears —
    // without this depending on whether the machine has internet access.
    const blockedCfg = { ...cfg, etl: { ...cfg.etl, dataDir: path.join(cfg.etl.dataDir, "blocked") } };
    await fs.mkdir(blockedCfg.etl.dataDir, { recursive: true });
    await fs.writeFile(path.join(blockedCfg.etl.dataDir, "raw"), "blocked", "utf8");

    await expect(runPipeline({ cfg: blockedCfg, download: noDownload })).rejects.toThrow(
      /no usable records|no source files|parsed to zero rows|unavailable/i,
    );

    // The live table must be untouched.
    const after = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(after).not.toBeNull();
    expect(after?.countryCode).toBe(before?.countryCode);

    const last = await lastEtlRun(pool);
    expect(last?.status).toBe("failed");

    await fs.rm(blockedCfg.etl.dataDir, { recursive: true, force: true });
  });

  it("a second concurrent run is refused by the ETL run lock", async () => {
    // The advisory lock is what actually excludes two processes. Take it
    // here and confirm the pipeline refuses to start.
    const guard = await acquireEtlRunLock(pool);
    expect(guard.acquired).toBe(true);
    try {
      await expect(runPipeline({ cfg })).rejects.toThrow(/already in progress|run lock/i);
    } finally {
      await guard.lock!.release();
    }
    // With the lock released the pipeline runs again.
    await writeFixtures();
    const result = await runPipeline({ cfg });
    expect(result.merged).toBeGreaterThan(0);
  });

  it("refuses to start while another run row is still 'running'", async () => {
    // A crashed run leaves its row at status='running'. The guard must
    // refuse until that row is closed out.
    const runId = await recordEtlStart(pool);
    try {
      expect(await findRunningEtlRun(pool)).toBe(runId);
      const guard = await acquireEtlRunLock(pool);
      expect(guard.acquired).toBe(false);
      expect(guard.runningRunId).toBe(runId);
    } finally {
      await pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [runId]);
    }
  });

  it("ignores the caller's own pre-created run row", async () => {
    // The setup wizard creates the run row BEFORE calling the pipeline,
    // so the guard must not treat that row as a competing run.
    const runId = await recordEtlStart(pool);
    try {
      const guard = await acquireEtlRunLock(pool, { excludeRunId: runId });
      expect(guard.acquired).toBe(true);
      await guard.lock!.release();
    } finally {
      await pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [runId]);
    }
  });

  it("reports a failed atomic swap as a failed run", async () => {
    // The swap is the last step of the pipeline. If it fails, the live
    // ip_ranges still holds the previous table — the run did NOT
    // succeed. Before the guard, runSwapStage returned the failed
    // result and the pipeline went on to recordEtlFinish(...,
    // "success"), so lastSuccessfulEtl() treated a stale library as
    // fresh and the admin UI showed "imported N records".
    //
    // The failure is forced by making the RENAME impossible. A view
    // cannot participate in RENAME TABLE, so replacing ip_ranges_old
    // with a view makes the swap fail while leaving the earlier stages
    // (truncate + insert into ip_ranges_new) working normally — the
    // failure lands exactly where we want it, and the live ip_ranges
    // table is never touched.
    await writeFixtures();
    await pool.query("DROP TABLE IF EXISTS ip_ranges_old");
    await pool.query("CREATE VIEW ip_ranges_old AS SELECT * FROM ip_ranges");

    try {
      await expect(runPipeline({ cfg })).rejects.toThrow(/swap failed/i);

      // The run must be recorded as failed.
      const last = await lastEtlRun(pool);
      expect(last?.status).toBe("failed");

      // And the swap row must carry the failure, not a bogus success.
      const [swapRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT status, error_message FROM etl_run_swaps ORDER BY run_id DESC LIMIT 1`,
      );
      expect(swapRows[0]?.status).toBe("failed");
      // MySQL reports the exact reason differently across versions
      // ("not BASE TABLE" vs "already exists" vs "is not empty"), so
      // assert only that a reason was recorded.
      expect(String(swapRows[0]?.error_message ?? "")).not.toBe("");

      // The live table still holds the data from the earlier run.
      const live = await findRange(
        pool,
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]),
      );
      expect(live).not.toBeNull();
    } finally {
      await pool.query("DROP VIEW IF EXISTS ip_ranges_old");
      await pool.query("CREATE TABLE ip_ranges_old LIKE ip_ranges");
    }
  });
});
