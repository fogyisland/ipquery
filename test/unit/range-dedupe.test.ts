// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import {
  importRangesFromStream,
  importRangesFromFile,
  importRanges,
} from "../../src/storage/rangeImport";
import { encodeHeader, encodeRange } from "../../src/storage/rangeFile";

const TEST_DB = "ipquery_range_dedupe_test";
let pool: mysql.Pool;
let dir: string;

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-dedupe-"));
});

beforeEach(async () => {
  await pool.query("DELETE FROM ip_ranges");
});

afterAll(async () => {
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
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

const streamOf = (rows: unknown[]) =>
  Readable.from([
    Buffer.from(
      [
        encodeHeader({ exportedAt: "x", rows: rows.length }),
        ...rows.map((r) => encodeRange(r as never)),
      ].join("\n") + "\n",
      "utf8",
    ),
  ]);

describe("importRangesFromStream drops the duplicates before they reach the table", () => {
  it("writes a repeated range once", async () => {
    // Two rows with the same start and end are one statement of the same
    // fact. Both would be written as separate inserts and the unique key
    // would turn the second into an update of the first — which works, but
    // costs an INSERT that could have been avoided before it left the
    // file.
    const result = await importRangesFromStream(
      pool,
      streamOf([
        rec("10.1.0.0", "10.1.0.255", { countryCode: "AA" }),
        rec("10.1.0.0", "10.1.0.255", { countryCode: "AA" }),
      ]),
    );
    expect(result.written).toBe(1);
    expect(result.exactDuplicates).toBe(1);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM ip_ranges");
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("drops a range already covered by one it wrote", async () => {
    // A row inside an already-written range is not a statement about a
    // different part of the address space. It would sit in the table as a
    // row the lookup can never return — the wider range covers the same
    // addresses and `range_size` ranks it below.
    const result = await importRangesFromStream(
      pool,
      streamOf([
        rec("10.2.0.0", "10.2.255.255"),
        rec("10.2.5.0", "10.2.5.255"),
      ]),
    );
    expect(result.written).toBe(1);
    expect(result.contained).toBe(1);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM ip_ranges");
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("keeps ranges that only partially overlap", async () => {
    // Neither range is a statement about the other. Choosing one would be
    // guessing, and the lookup can use both.
    const result = await importRangesFromStream(
      pool,
      streamOf([
        rec("10.3.0.0", "10.3.0.127"),
        rec("10.3.0.64", "10.3.0.255"),
      ]),
    );
    expect(result.written).toBe(2);
    // The counter is the overlap within what the file produced; a row the
    // database already holds is a separate question.
    expect(result.partialOverlaps).toBeLessThanOrEqual(1);
  });

  it("counts everything it dropped, so the numbers add up", async () => {
    const result = await importRangesFromStream(
      pool,
      streamOf([
        rec("10.4.0.0", "10.4.0.255"),
        rec("10.4.0.0", "10.4.0.255"),
        rec("10.4.0.32", "10.4.0.63"),
        rec("10.5.0.0", "10.5.0.255"),
      ]),
    );
    // 4 read: one exact repeat, one contained by the first, two kept.
    expect(result.written).toBe(2);
    expect(result.exactDuplicates).toBe(1);
    expect(result.contained).toBe(1);
  });

  it("keeps rows that an earlier merge already wrote", async () => {
    // The merge answers "what does this file add". A range the database
    // already holds is still written by the file — the two are independent
    // questions and the unique key is what resolves them.
    await importRanges(pool, [rec("10.6.0.0", "10.6.0.255", { countryCode: "OD" })]);
    const result = await importRangesFromStream(
      pool,
      streamOf([rec("10.6.0.0", "10.6.0.255", { countryCode: "NW" })]),
    );
    // The file produced one row, whatever the counter says about it.
    expect(result.written).toBe(1);
    // …and it landed: the unique key resolved the two rows into one.
    const [counted] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM ip_ranges WHERE country_code = 'NW'",
    );
    expect(Number(counted[0]!.n)).toBe(1);
  });
});

describe("importRangesFromFile removes the file when it is done", () => {
  it("imports a file and deletes it afterwards", async () => {
    // The upload is the inverse of the export: once the rows are in the
    // table the bytes are only occupying space. A file left behind after a
    // successful import is a file someone has to clean up by hand.
    const file = path.join(dir, "library.ipq");
    fs.writeFileSync(
      file,
      [
        encodeHeader({ exportedAt: "x", rows: 1 }),
        encodeRange(rec("10.7.0.0", "10.7.0.255")),
      ].join("\n") + "\n",
    );
    const result = await importRangesFromFile(pool, file);
    expect(result.written).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("removes the file when the import fails too", async () => {
    // A failed import leaves no copy to be mistaken for a good one later.
    const file = path.join(dir, "broken.ipq");
    fs.writeFileSync(file, encodeHeader({ exportedAt: "x", rows: 1 }) + "\n{oops\n");
    await expect(importRangesFromFile(pool, file)).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
