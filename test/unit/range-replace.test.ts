// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { Readable } from "node:stream";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { importRanges, replaceRangesFromStream } from "../../src/storage/rangeImport";
import { encodeHeader, encodeRange, RangeFileError } from "../../src/storage/rangeFile";
import { findRange } from "../../src/storage/mysql";
import { parseIp } from "../../src/ip";
import { acquireEtlRunLock } from "../../src/etl/runGuard";

const TEST_DB = "ipquery_range_replace_test";
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

const streamOf = (rows: unknown[]) =>
  Readable.from([
    Buffer.from(
      [encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: rows.length }), ...rows.map((r) => encodeRange(r as never))].join("\n") + "\n",
      "utf8",
    ),
  ]);

describe("replaceRangesFromStream", () => {
  it("swaps the live table for the uploaded file", async () => {
    await importRanges(pool, [rec("10.0.0.0", "10.0.0.255", { countryCode: "OL" })]);

    const result = await replaceRangesFromStream(pool, streamOf([
      rec("10.9.0.0", "10.9.0.255", { countryCode: "NE" }),
      rec("10.8.0.0", "10.8.0.255", { countryCode: "NE" }),
    ]));

    expect(result.written).toBe(2);
    // The pre-swap imported row is operator-owned; it comes forward, so the
    // table ends up one row larger than the file.
    expect(result.total).toBe(3);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'NE'",
    );
    // The imported row from before the swap is operator-owned and comes
    // forward on purpose (see the next test); what matters here is that the
    // uploaded rows replaced the old library rather than merging into it.
    expect(rows).toHaveLength(2);
    // …and the old row is carried forward rather than merged: it keeps the
    // `import` tag that marks it operator-owned, which is what makes
    // preserveManualRows pick it up. A replacement that dropped it would be
    // undoing an earlier import, so the fact that it survives is the
    // contract, not a leak.
    const kept = await findRange(pool, parseIp("10.0.0.5")!);
    expect(kept?.countryCode).toBe("OL");
  });

  it("keeps the operator's own rows across the replacement", async () => {
    // A replacement that threw away every multi-provider and imported row
    // would undo work the operator did by hand — the same reasoning that
    // makes preserveManualRows run before an ETL swap.
    await importRanges(pool, [rec("10.1.0.0", "10.1.0.255", { countryCode: "KP" })]);

    await replaceRangesFromStream(pool, streamOf([rec("10.2.0.0", "10.2.0.255", { countryCode: "NE" })]));

    const kept = await findRange(pool, parseIp("10.1.0.5")!);
    expect(kept?.countryCode).toBe("KP");
    const fresh = await findRange(pool, parseIp("10.2.0.5")!);
    expect(fresh?.countryCode).toBe("NE");
  });

  it("leaves the live table untouched when the upload is malformed", async () => {
    // The whole point of staging. A file that turns out to be broken on line
    // four million must not have already truncated the table it was going to
    // replace.
    await importRanges(pool, [rec("10.3.0.0", "10.3.0.255", { countryCode: "SV" })]);

    const broken = Readable.from([
      Buffer.from(
        encodeHeader({ exportedAt: "x", rows: 2 }) +
          "\n" +
          encodeRange(rec("10.4.0.0", "10.4.0.255")) +
          "\n{not json\n",
        "utf8",
      ),
    ]);

    await expect(replaceRangesFromStream(pool, broken)).rejects.toThrow(RangeFileError);
    const survivor = await findRange(pool, parseIp("10.3.0.5")!);
    expect(survivor?.countryCode).toBe("SV");
  });

  it("empties the staging table before it starts", async () => {
    // A previous failed attempt leaves rows behind. Without the truncate
    // they would be swapped into the live table next to the new upload.
    await pool.query(
      `INSERT INTO ip_ranges_new (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A630000'), UNHEX('0000000000000000000000000A6300FF'), 255, 'LF', 'dbip')`,
    );
    await replaceRangesFromStream(pool, streamOf([rec("10.5.0.0", "10.5.0.255", { countryCode: "NE" })]));
    const leftover = await findRange(pool, parseIp("10.99.0.5")!);
    expect(leftover).toBeNull();
  });

  it("tags the uploaded rows with the import source", async () => {
    await replaceRangesFromStream(pool, streamOf([rec("10.6.0.0", "10.6.0.255", { countryCode: "NE" })]));
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT country_source FROM ip_ranges WHERE country_code = 'NE'",
    );
    expect(rows[0]!.country_source).toBe("import");
  });

  it("refuses to run while an ETL holds the lock", async () => {
    // Both flows truncate ip_ranges_new and RENAME. Running them together
    // means one wipe takes the other's partial insert with it, and the
    // surviving table is whichever rename landed last.
    const lock = await acquireEtlRunLock(pool);
    expect(lock.acquired).toBe(true);
    try {
      await expect(
        replaceRangesFromStream(pool, streamOf([rec("10.7.0.0", "10.7.0.255")])),
      ).rejects.toThrow(/ETL|in progress/i);
    } finally {
      await lock.lock!.release();
    }
  });

  it("reports how many rows it put into the table", async () => {
    const result = await replaceRangesFromStream(pool, streamOf([
      rec("10.8.1.0", "10.8.1.255"),
      rec("10.8.2.0", "10.8.2.255"),
      rec("10.8.3.0", "10.8.3.255"),
    ]));
    expect(result.written).toBe(3);
    const [counted] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM ip_ranges");
    expect(Number(counted[0]!.n)).toBe(3);
  });
});
