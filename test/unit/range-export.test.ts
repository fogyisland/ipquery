// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { exportRangesToFile } from "../../src/storage/rangeExport";
import { importRanges } from "../../src/storage/rangeImport";
import { decodeFile } from "../../src/storage/rangeFile";

const TEST_DB = "ipquery_range_export_test";
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
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
  });
  await runMigrations(pool);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-export-"));
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

const seed = async (rows: Array<{ start: string; end: string; country?: string; city?: string }>) => {
  await importRanges(
    pool,
    rows.map((r) => ({
      line: 0,
      start: r.start,
      end: r.end,
      countryCode: r.country ?? null,
      countryName: null,
      region: null,
      city: r.city ?? null,
      postalCode: null,
      latitude: null,
      longitude: null,
      timezone: null,
      isp: null,
      asn: null,
      asnOrg: null,
    })),
  );
};

describe("exportRangesToFile", () => {
  it("writes a file the importer reads back unchanged", async () => {
    // Export and import are the same format, so the round trip is the
    // contract a user relies on: download, hand to a colleague, upload.
    await seed([
      { start: "10.20.0.0", end: "10.20.0.255", country: "ZZ", city: "Roundtrip" },
      { start: "2001:db8::", end: "2001:db8::ffff", country: "ZZ" },
    ]);
    const out = path.join(dir, "roundtrip.ipq");
    const result = await exportRangesToFile(pool, out);
    expect(result.rows).toBe(2);

    const decoded = decodeFile(fs.readFileSync(out, "utf8"));
    expect(decoded.header.rows).toBe(2);
    expect(decoded.ranges).toHaveLength(2);
    const v4 = decoded.ranges.find((r) => r.start === "10.20.0.0");
    expect(v4?.city).toBe("Roundtrip");
    expect(decoded.ranges.some((r) => r.start === "2001:db8::")).toBe(true);
  });

  it("declares the real row count in the header", async () => {
    // A header that disagrees with the body is how a truncated export goes
    // unnoticed: the file looks complete and imports partially.
    await seed([
      { start: "10.21.0.0", end: "10.21.0.255" },
      { start: "10.22.0.0", end: "10.22.0.255" },
      { start: "10.23.0.0", end: "10.23.0.255" },
    ]);
    const out = path.join(dir, "count.ipq");
    const result = await exportRangesToFile(pool, out);
    const decoded = decodeFile(fs.readFileSync(out, "utf8"));
    expect(decoded.header.rows).toBe(3);
    expect(decoded.ranges).toHaveLength(3);
    expect(result.rows).toBe(3);
  });

  it("writes addresses as text, not as the stored bytes", async () => {
    // start_ip is BINARY(16). An exporter that dumped the column would
    // produce a file no human can read and no other install can import.
    await seed([{ start: "8.8.8.0", end: "8.8.8.255", country: "US" }]);
    const out = path.join(dir, "text.ipq");
    await exportRangesToFile(pool, out);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toContain('"start":"8.8.8.0"');
    // Every character has to be printable text: the point of the format
    // is that a person can open the file and read it.
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0x7f);
      expect(printable, `unprintable character ${code}`).toBe(true);
    }
  });

  it("exports one range when the filter names one", async () => {
    await seed([
      { start: "10.30.0.0", end: "10.30.0.255", country: "AA" },
      { start: "10.31.0.0", end: "10.31.0.255", country: "BB" },
    ]);
    const out = path.join(dir, "filtered.ipq");
    const result = await exportRangesToFile(pool, out, { countryCode: "BB" });
    expect(result.rows).toBe(1);
    const decoded = decodeFile(fs.readFileSync(out, "utf8"));
    expect(decoded.ranges[0]?.countryCode).toBe("BB");
  });

  it("serves zero rows as a valid, empty file", async () => {
    // An empty export is not an error — the operator asked for a filter
    // that matched nothing, and the file they get back says so.
    const out = path.join(dir, "empty.ipq");
    const result = await exportRangesToFile(pool, out);
    expect(result.rows).toBe(0);
    const decoded = decodeFile(fs.readFileSync(out, "utf8"));
    expect(decoded.ranges).toEqual([]);
    expect(decoded.header.rows).toBe(0);
  });

  it("counts down progress while it streams", async () => {
    await seed([
      { start: "10.40.0.0", end: "10.40.0.255" },
      { start: "10.41.0.0", end: "10.41.0.255" },
    ]);
    const out = path.join(dir, "progress.ipq");
    const seen: number[] = [];
    await exportRangesToFile(pool, out, { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(2);
  });
});
