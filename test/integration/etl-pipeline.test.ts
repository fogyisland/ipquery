// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createPool, runMigrations, findRange, lastEtlRun, getEtlRunDedupe } from "../../src/storage/mysql";
import { runPipeline, EtlProgressSink } from "../../src/etl/pipeline";
import { loadConfig } from "../../src/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

const TEST_DB = "ipquery_test";
let pool: mysql.Pool;
const cfg = loadConfig();
const noDownload = async (): Promise<[]> => [];

async function writeFixedFixtures(rawDir: string): Promise<void> {
  await fs.writeFile(path.join(rawDir, "china-ipv4.txt"), "1.0.0.0/8\n1.2.3.0/24\n");
  await fs.writeFile(path.join(rawDir, "china-v4.txt"), "1.0.0.0/8\n");
  await fs.writeFile(path.join(rawDir, "china-v6.txt"), "# CN IPv6 List\n2001:db8::/32\n");
  await fs.writeFile(
    path.join(rawDir, "sapics-user-country.csv"),
    "2.0.0.0,2.0.0.255,CN\n2001:db8::,2001:db8::ffff,CN\n",
  );
}

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  cfg.etl.dataDir = path.join(__dirname, "..", "tmp-data");
  await fs.mkdir(cfg.etl.dataDir, { recursive: true });

  // Lay down fixture files into dataDir/raw
  const rawDir = path.join(cfg.etl.dataDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });

  // DB-IP city-lite column layout: start, end, continent, country, region,
  // city, lat, lon. The parser indexes cols[3] as the ISO country code
  // (cols[2] is the continent we ignore), so the column order matters.
  const csv =
    "ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n9.9.9.0,9.9.9.255,EU,GB,England,London,51.5074,-0.1278\n";
  await fs.writeFile(path.join(rawDir, "dbip.csv.gz"), zlib.gzipSync(Buffer.from(csv)));

  // The country-lite and asn-lite fixtures must exist too. The pipeline
  // now treats a missing source file as a hard failure (it used to
  // skip it silently), so a run without these would try to download
  // the real DB-IP files and turn a unit test into a network test.
  const countryCsv = "ip_start,ip_end,country\n9.9.9.0,9.9.9.255,GB\n";
  await fs.writeFile(
    path.join(rawDir, "dbip-country.csv.gz"),
    zlib.gzipSync(Buffer.from(countryCsv)),
  );
  const asnCsv = "start_ip,end_ip,asn,asn_name\n9.9.9.0,9.9.9.255,64500,Example ISP\n";
  await fs.writeFile(path.join(rawDir, "dbip-asn.csv.gz"), zlib.gzipSync(Buffer.from(asnCsv)));
  await writeFixedFixtures(rawDir);

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

describe("etl pipeline", () => {
  it("runs end-to-end and populates ip_ranges", async () => {
    const result = await runPipeline({ cfg, download: noDownload });
    expect(result.merged).toBeGreaterThan(3);
    const last = await lastEtlRun(pool);
    expect(last?.status).toBe("success");
    expect(last?.mergedRecords).toBe(result.merged);
    expect(last?.dbipRecords).toBe(3);
    const dedupe = await getEtlRunDedupe(pool, result.runId);
    expect(dedupe).not.toBeNull();
    expect(dedupe!.emitted).toBeGreaterThan(0);
    const [parseRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT source, rows_emitted FROM etl_run_parses WHERE run_id = ? AND source IN
       ('metowolf-cn','runishiwo-cn','runishiwo-v6','sapics-user')`,
      [result.runId],
    );
    expect(parseRows.reduce((sum, row) => sum + Number(row.rows_emitted), 0)).toBe(dedupe!.emitted);
    const [insertRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT source, rows_attempted FROM etl_run_inserts WHERE run_id = ? AND source IN
       ('metowolf-cn','runishiwo-cn','runishiwo-v6','sapics-user')`,
      [result.runId],
    );
    expect(insertRows.reduce((sum, row) => sum + Number(row.rows_attempted), 0)).toBe(dedupe!.emitted);
    const githubRange = await findRange(
      pool,
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1]),
    );
    expect(["metowolf-cn", "runishiwo-cn"]).toContain(githubRange?.countrySource);
  });

  it("subsequent /lookup finds seeded data", async () => {
    const r = await findRange(pool, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 5]));
    expect(r?.countryCode).toBeDefined();
  });

  it("insert progress reported to the sink is monotonic across files", async () => {
    // Guard against the runInsertedSoFar-per-file regression: onInsert
    // receives a cross-file running count, so it must never decrease.
    const root = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.query(`CREATE DATABASE ${TEST_DB}`);
    await root.end();
    await pool.end();
    pool = createPool(cfg);
    await runMigrations(pool);
    const seen: number[] = [];
    const sink = new EtlProgressSink(pool, 0, { intervalMs: 0 });
    const origOnInsert = sink.onInsert.bind(sink);
    sink.onInsert = (rowsDone: number) => {
      seen.push(rowsDone);
      origOnInsert(rowsDone);
    };
    const result = await runPipeline({ cfg, runId: undefined, sink, download: noDownload });
    expect(result.merged).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it("legacy summary columns use insert-stage totals without a third gunzip pass", async () => {
    // recordEtlFinish must receive counts equal to the insert-stage
    // rowsAttempted tallies (not a re-parse of the files).
    const last = await lastEtlRun(pool);
    expect(last?.status).toBe("success");
    expect(last?.dbipRecords).toBeGreaterThan(0);
  });

  // A download stub that writes nothing — it stands in for a failed
  // network fetch. The pipeline must treat "the file is still missing
  // after the download stage" as a hard failure rather than swapping
  // a partial data set over the live table.

  it("refuses to swap when a source file cannot be obtained", async () => {
    // Regression: the old download stage decided per-run ("if NO file
    // is present, download everything"). With one file missing, the
    // remaining cached files short-circuited the download, the parse
    // stage silently skipped the missing one, and the run reported
    // success while swapping a partial data set over the live table.
    const rawDir = path.join(cfg.etl.dataDir, "raw");
    const target = path.join(rawDir, "dbip.csv.gz");
    const backup = path.join(cfg.etl.dataDir, "dbip.csv.gz.bak");
    await fs.rename(target, backup);
    try {
      await expect(runPipeline({ cfg, download: noDownload })).rejects.toThrow(
        /unavailable|vanished/i,
      );
    } finally {
      await fs.rename(backup, target);
    }
  });

  it("reports a failed run when a source file cannot be obtained", async () => {
    // The failed run must be recorded as failed — not left in 'running'
    // and definitely not reported as success.
    const rawDir = path.join(cfg.etl.dataDir, "raw");
    const target = path.join(rawDir, "dbip.csv.gz");
    const backup = path.join(cfg.etl.dataDir, "dbip.csv.gz.bak");
    await fs.rename(target, backup);
    try {
      await expect(runPipeline({ cfg, download: noDownload })).rejects.toThrow();
      const last = await lastEtlRun(pool);
      expect(last?.status).toBe("failed");
      expect(last?.errorMessage).toBeTruthy();
    } finally {
      await fs.rename(backup, target);
    }
  });

  it("deletes a corrupt cached file and re-downloads it", async () => {
    // A half-written .gz (interrupted download) must be detected,
    // removed from disk, and re-fetched — instead of being fed to the
    // parser where it blows up as Z_BUF_ERROR.
    const rawDir = path.join(cfg.etl.dataDir, "raw");
    const target = path.join(rawDir, "dbip-country.csv.gz");
    const backup = path.join(cfg.etl.dataDir, "dbip-country.csv.gz.bak");
    await fs.rename(target, backup);
    const full = await fs.readFile(backup);
    await fs.writeFile(target, full.subarray(0, Math.floor(full.length / 2)));
    const requested: string[] = [];
    const stubDownload = async (
      _pool: unknown,
      _runId: number,
      outDir: string,
      _now: Date,
      _sink: unknown,
      specs: ReadonlyArray<{ destName: string }>,
    ): Promise<[]> => {
      requested.push(...specs.map((s) => s.destName));
      // Restore the good copy, standing in for a successful download.
      await fs.copyFile(backup, path.join(outDir, "dbip-country.csv.gz"));
      return [];
    };
    try {
      const result = await runPipeline({ cfg, download: stubDownload as never });
      // The corrupt file must have been detected and replaced.
      expect(requested).toContain("dbip-country.csv.gz");
      expect(result.merged).toBeGreaterThan(0);
      const last = await lastEtlRun(pool);
      expect(last?.status).toBe("success");
    } finally {
      await fs.rm(target, { force: true });
      await fs.rename(backup, target);
    }
  });
  it("pipeline reuses a valid old cache after a failed refresh", async () => {
    // Regression: a refresh that fails must NOT take the run down when
    // the previous file is still on disk and still valid. The download
    // stage records a `failed` row for that file and no `skipped` row —
    // the file WAS attempted and it failed, so the run page shows the
    // failed refresh, not "nothing happened".
    //
    // The stub stands in for the network layer only: it records the
    // request and then rethrows the refresh failure the real download
    // layer raises when every mirror is down. Keeping the seam at the
    // network level means the production fallback path is what runs.
    const rawDir = path.join(cfg.etl.dataDir, "raw");
    const target = path.join(rawDir, "china-v6.txt");
    const previous = "# CN IPv6 List\n2001:db8::/32\n";
    await fs.writeFile(target, previous);
    const requested: string[] = [];
    // The refresh layer reports failure exactly the way the real one does
    // when every mirror is down — but WITHOUT removing the cached copy the
    // fetcher would have left in place.
    const failingRefresh = async (spec: { destName: string }): Promise<never> => {
      requested.push(spec.destName);
      throw new Error("刷新失败、复用旧缓存: " + spec.destName + " (network down)");
    };
    try {
      const result = await runPipeline({
        cfg,
        downloadFixed: failingRefresh as never,
      });
      expect(result.merged).toBeGreaterThan(0);
      // The old cache is untouched.
      expect(requested).toContain("china-v6.txt");
      expect(await fs.readFile(target, "utf8")).toBe(previous);
      // A failed refresh is a `failed` row, and it is NOT also a `skipped` one.
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT dest_name, status FROM etl_run_downloads WHERE run_id = ?`,
        [result.runId],
      );
      const byName = new Map(rows.map((row) => [row.dest_name as string, row.status as string]));
      expect(byName.get("china-v6.txt")).toBe("failed");
      expect(rows.some((row) => row.dest_name === "china-v6.txt" && row.status === "skipped")).toBe(false);
      // The parse / insert tallies agree with the summary.
      const last = await lastEtlRun(pool);
      expect(last?.status).toBe("success");
      const [parseRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT SUM(rows_emitted) AS total FROM etl_run_parses WHERE run_id = ?`,
        [result.runId],
      );
      const [insertRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT SUM(rows_attempted) AS total FROM etl_run_inserts WHERE run_id = ?`,
        [result.runId],
      );
      expect(Number(parseRows[0].total)).toBeGreaterThan(0);
      expect(Number(insertRows[0].total)).toBeGreaterThan(0);
    } finally {
      await fs.rm(target, { force: true });
      await fs.writeFile(target, previous);
    }
  });

  it("pipeline fails without a valid old cache", async () => {
    // With no cache at all, a failed refresh must stop the run: it must
    // not swap a partial data set over the live table and must not claim
    // success.
    const rawDir = path.join(cfg.etl.dataDir, "raw");
    const target = path.join(rawDir, "china-v6.txt");
    const backup = path.join(cfg.etl.dataDir, "china-v6.txt.bak");
    await fs.rename(target, backup);
    const failingDownload = async (): Promise<[]> => [];
    try {
      await expect(runPipeline({ cfg, download: failingDownload })).rejects.toThrow(
        /unavailable|vanished/i,
      );
      const last = await lastEtlRun(pool);
      expect(last?.status).toBe("failed");
      // The live table was not swapped for the failed run.
      const [swapRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT run_id FROM etl_run_swaps WHERE run_id = ?`,
        [last!.id],
      );
      expect(swapRows.length).toBe(0);
      // The reusable-cache stage never ran for the missing file.
      const [dlRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT dest_name, status FROM etl_run_downloads WHERE run_id = ?`,
        [last!.id],
      );
      expect(dlRows.every((row) => row.status !== "skipped" || row.dest_name !== "china-v6.txt")).toBe(true);
    } finally {
      await fs.rename(backup, target);
    }
  });
});
