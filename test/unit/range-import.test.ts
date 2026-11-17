// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { importRanges } from "../../src/storage/rangeImport";
import {
  MANUAL_SOURCE_TAGS,
  findRange,
  getEtlRunDedupe,
  preserveManualRows,
  truncateNew,
} from "../../src/storage/mysql";
import { parseIp, bufferToString } from "../../src/ip";

const TEST_DB = "ipquery_range_import_test";
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
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
  });
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query("DELETE FROM ip_ranges");
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

const range = (start: string, end: string, over: Record<string, unknown> = {}) => ({
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

describe("importRanges", () => {
  it("tags imported rows so the next ETL refresh keeps them", async () => {
    // This is the whole reason the tag exists. The ETL rebuilds ip_ranges
    // from scratch every run; a row whose country_source is not a manual
    // tag is simply not there afterwards. An import that forgot the tag
    // would look like it worked and then quietly disappear overnight.
    await importRanges(pool, [range("10.1.0.0", "10.1.0.255", { countryCode: "ZZ" })]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT country_source FROM ip_ranges WHERE start_ip = ?",
      [parseIp("10.1.0.0")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.country_source).toBe("import");
    expect((MANUAL_SOURCE_TAGS as readonly string[]).includes("import")).toBe(true);
  });

  it("can be found by the lookup it was imported for", async () => {
    await importRanges(pool, [range("10.2.0.0", "10.2.0.255", { countryCode: "ZZ", city: "Testville" })]);
    const hit = await findRange(pool, parseIp("10.2.0.42")!);
    expect(hit?.countryCode).toBe("ZZ");
    expect(hit?.city).toBe("Testville");
  });

  it("computes range_size itself rather than trusting the file", async () => {
    // range_size drives `ORDER BY` in the lookup — it decides which of two
    // covering ranges wins. A file cannot be allowed to set it.
    const [before] = await pool.query<mysql.RowDataPacket[]>("SELECT 1");
    void before;
    await importRanges(pool, [range("10.3.0.0", "10.3.1.255")]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT range_size FROM ip_ranges WHERE start_ip = ?",
      [parseIp("10.3.0.0")],
    );
    expect(Number(rows[0]!.range_size)).toBe(511);
  });

  it("updates an existing range instead of failing on the unique key", async () => {
    await importRanges(pool, [range("10.4.0.0", "10.4.0.255", { countryCode: "AA" })]);
    const result = await importRanges(pool, [range("10.4.0.0", "10.4.0.255", { countryCode: "BB" })]);
    expect(result.inserted).toBe(1);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE start_ip = ?",
      [parseIp("10.4.0.0")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.country_code).toBe("BB");
  });

  it("reports how many rows it wrote", async () => {
    const result = await importRanges(pool, [
      range("10.5.0.0", "10.5.0.255"),
      range("10.6.0.0", "10.6.0.255"),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("reports a row it had to skip without abandoning the rest", async () => {
    // One bad row in a 40 MB file must not cost the operator the other
    // 39 MB. It is counted and named; the import carries on.
    const result = await importRanges(pool, [
      range("10.7.0.0", "10.7.0.255"),
      // asn is INT UNSIGNED; a negative value is the sort of thing a
      // hand-edited file contains.
      range("10.8.0.0", "10.8.0.255", { asn: -1 }),
      range("10.9.0.0", "10.9.0.255"),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.start).toBe("10.8.0.0");
  });

  it("stores an IPv6 range so it can be looked up as IPv6", async () => {
    await importRanges(pool, [range("2001:db8::", "2001:db8::ffff", { countryCode: "ZZ" })]);
    const hit = await findRange(pool, parseIp("2001:db8::1")!);
    expect(hit?.countryCode).toBe("ZZ");
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT start_ip FROM ip_ranges WHERE country_source = 'import'",
    );
    expect(bufferToString(rows[0]!.start_ip as Buffer)).toBe("2001:db8::");
  });
});

describe("an imported row survives an ETL refresh", () => {
  it("is copied into the staging table alongside the ETL's own rows", async () => {
    await importRanges(pool, [range("10.10.0.0", "10.10.0.255", { countryCode: "ZZ" })]);
    await truncateNew(pool);
    const preserved = await preserveManualRows(pool);
    expect(preserved.preserved).toBe(1);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges_new WHERE start_ip = ?",
      [parseIp("10.10.0.0")],
    );
    expect(rows[0]!.country_code).toBe("ZZ");
  });
});

void getEtlRunDedupe;
