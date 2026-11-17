// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { Readable } from "node:stream";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import {
  importRanges,
  replaceRangesFromStream,
  listRangeImports,
  writeRangeImportProgress,
  finishRangeImport,
  readRangeImportState,
} from "../../src/storage/rangeImport";
import { encodeHeader, encodeRange } from "../../src/storage/rangeFile";

const TEST_DB = "ipquery_range_background_test";
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
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
  pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 3,
    multipleStatements: true,
    timezone: "Z",
  });
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query("DELETE FROM ip_ranges");
  await pool.query("TRUNCATE TABLE ip_ranges_new");
  await pool.query("DELETE FROM range_imports");
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

const rec = (start: string, end: string, over: Record<string, unknown> = {}) => ({
  line: 0,
  start,
  end,
  countryCode: null,
  countryName: null,
  region: null,
  city: null,
  postalCode: null,
  latitude: null,
  longitude: null,
  timezone: null,
  isp: null,
  asn: null,
  asnOrg: null,
  ...over,
});

const fileOf = (rows: unknown[]) =>
  Readable.from([
    Buffer.from(
      [encodeHeader({ exportedAt: "x", rows: rows.length }), ...rows.map((r) => encodeRange(r as never))].join("\n") + "\n",
      "utf8",
    ),
  ]);

describe("the import record", () => {
  it("is written when a replacement starts and reports progress", async () => {
    // A nine-million-row import runs for a long time. The operator needs a
    // row to look at — how far it has got, how long it has been running, and
    // whether it died — not a page they cannot close without losing the job.
    const id = await writeRangeImportProgress(pool, {
      mode: "replace",
      source: "upload.ipq",
      declaredRows: 2,
    });
    const state = await readRangeImportState(pool, id);
    expect(state?.status).toBe("running");
    expect(state?.mode).toBe("replace");
    expect(state?.rowsDone).toBe(0);

    await writeRangeImportProgress(pool, { id, rowsDone: 500 });
    const updated = await readRangeImportState(pool, id);
    expect(updated?.rowsDone).toBe(500);
  });

  it("survives the rows it wrote by reporting the outcome", async () => {
    const id = await writeRangeImportProgress(pool, {
      mode: "replace",
      source: "upload.ipq",
      declaredRows: 3,
    });
    await finishRangeImport(pool, id, {
      status: "success",
      rowsWritten: 3,
      preserved: 1,
      errorMessage: null,
    });
    const state = await readRangeImportState(pool, id);
    expect(state?.status).toBe("success");
    expect(state?.rowsWritten).toBe(3);
    expect(state?.preserved).toBe(1);
  });

  it("records a failure rather than leaving the row at running", async () => {
    // A run that crashed is indistinguishable from one still going if the
    // row is never moved off `running` — the progress bar sits at 40% forever
    // and every future import is refused as "one is already in progress".
    const id = await writeRangeImportProgress(pool, {
      mode: "merge",
      source: "upload.ipq",
      declaredRows: 10,
    });
    await finishRangeImport(pool, id, {
      status: "failed",
      rowsWritten: 4,
      preserved: 0,
      errorMessage: "line 5: this is not valid JSON",
    });
    const state = await readRangeImportState(pool, id);
    expect(state?.status).toBe("failed");
    expect(state?.errorMessage).toContain("line 5");
  });

  it("lists the recent imports, newest first", async () => {
    await writeRangeImportProgress(pool, { mode: "merge", source: "a.ipq", declaredRows: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const second = await writeRangeImportProgress(pool, { mode: "replace", source: "b.ipq", declaredRows: 2 });
    const list = await listRangeImports(pool);
    expect(list.map((r) => r.id)).toEqual([second, list[1]!.id]);
  });
});

describe("replaceRangesFromStream reports its own progress", () => {
  it("takes a record id and updates it as it goes", async () => {
    const id = await writeRangeImportProgress(pool, {
      mode: "replace",
      source: "upload.ipq",
      declaredRows: 2,
    });
    await replaceRangesFromStream(pool, fileOf([rec("10.1.0.0", "10.1.0.255"), rec("10.2.0.0", "10.2.0.255")]), {
      importId: id,
    });
    const state = await readRangeImportState(pool, id);
    expect(state?.status).toBe("success");
    expect(state?.rowsWritten).toBe(2);
    // The counter is monotonic: a job that stalls cannot look like one that
    // went backwards.
    expect(state!.rowsDone).toBeGreaterThanOrEqual(2);
  });

  it("marks the record failed when the file turns out to be broken", async () => {
    const id = await writeRangeImportProgress(pool, {
      mode: "replace",
      source: "upload.ipq",
      declaredRows: 5,
    });
    const broken = Readable.from([Buffer.from(encodeHeader({ exportedAt: "x", rows: 2 }) + "\n{oops\n")]);
    await expect(replaceRangesFromStream(pool, broken, { importId: id })).rejects.toThrow();
    const state = await readRangeImportState(pool, id);
    expect(state?.status).toBe("failed");
  });
});

void importRanges;
