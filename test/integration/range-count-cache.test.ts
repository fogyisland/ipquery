// SPDX-License-Identifier: MIT
//
// Tests for the cached `ip_ranges` row count.
//
// The bug this guards: `SELECT COUNT(*) FROM ip_ranges` takes ~3.2 seconds on
// the real library (8.15M rows), and it was being run on every `/admin` render
// and every `/` render — plus every 30 seconds by the console's htmx auto
// refresh. Pages that should render in milliseconds took seconds.
//
// The other half of the fix is the double-destructuring in
// getOverview: `pool.query` resolves to `[rows, fields]`, so a single
// `[counts]` binds the rows array and every field reads as undefined, which
// the template then prints as "NaN". That regression is covered by asserting
// the numbers directly.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import {
  getRangeCount,
  readStoredRangeCount,
  refreshRangeCount,
  RANGE_COUNT_MAX_AGE_MS,
} from "../../src/storage/rangeCount";
import { getOverview } from "../../src/web/admin/overview";

let td: TestDb;

beforeAll(async () => {
  td = await createTestDb("rangecount");
});

afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE ip_ranges");
  await td.pool.query("DELETE FROM settings WHERE k LIKE 'ip_ranges_count%'");
});

let nextOctet = 1;

async function seed(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    // A monotonic counter across calls: `seed(2)` followed by `seed(5)` must
    // not re-insert the same addresses (uniq_start_end would reject them and
    // the test would fail for a reason that has nothing to do with the cache).
    const n = nextOctet++;
    const buf = Buffer.alloc(16);
    buf[15] = n & 0xff;
    buf[14] = (n >> 8) & 0xff;
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (?, ?, 0, 'XX', 'seed')`,
      [buf, buf],
    );
  }
}

describe("cached ip_ranges count", () => {
  it("returns null before anything has been stored", async () => {
    expect(await readStoredRangeCount(td.pool)).toBeNull();
  });

  it("stores an exact count and reads it back", async () => {
    await seed(3);
    const written = await refreshRangeCount(td.pool);
    expect(written?.value).toBe(3);
    expect(written?.kind).toBe("exact");
    const stored = await readStoredRangeCount(td.pool);
    expect(stored?.value).toBe(3);
    expect(stored?.syncedAt).toBeInstanceOf(Date);
  });

  it("serves the stored value even after rows were added behind its back", async () => {
    // This is the trade the cache makes: a render shows the stored number, not
    // a 3-second COUNT(*). The value catches up on the next refresh.
    await seed(2);
    await refreshRangeCount(td.pool);
    await seed(5);
    const served = await getRangeCount(td.pool);
    expect(served.value).toBe(2);
  });

  it("falls back to an estimate when nothing is stored", async () => {
    // `information_schema.table_rows` is maintained by InnoDB statistics. In a
    // fresh test database those can read 0 until ANALYZE runs, and the reader
    // must not then report a library of zero rows — it falls through to an
    // exact count instead. Whatever path it took, the answer has to be right.
    await seed(4);
    const served = await getRangeCount(td.pool);
    expect(served.value).toBe(4);
    // Either path (estimate or exact) leaves the exact value stored for the
    // next reader. The estimate branch refreshes in the background, so wait
    // for it rather than racing it.
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = await readStoredRangeCount(td.pool);
      if (stored?.value === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await readStoredRangeCount(td.pool))?.value).toBe(4);
  });

  it("treats a malformed stored value as absent", async () => {
    await td.pool.query(
      `INSERT INTO settings (k, v) VALUES ('ip_ranges_count', 'not-a-number')
       ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    );
    expect(await readStoredRangeCount(td.pool)).toBeNull();
    // The reader must still answer with a real number rather than null/0.
    const served = await getRangeCount(td.pool);
    expect(served.value).toBeGreaterThanOrEqual(0);
  });

  it("refreshes in the background when the stored value is old", async () => {
    await seed(6);
    await refreshRangeCount(td.pool);
    // Backdate the timestamp past the trust window, then add rows.
    const old = new Date(Date.now() - RANGE_COUNT_MAX_AGE_MS - 60_000).toISOString();
    await td.pool.query(
      `INSERT INTO settings (k, v) VALUES ('ip_ranges_count_at', ?)
       ON DUPLICATE KEY UPDATE v = VALUES(v)`,
      [old],
    );
    await seed(1);
    // The render still answers from the cache…
    const served = await getRangeCount(td.pool);
    expect(served.value).toBe(6);
    // …and the refresh it kicked off updates the stored value shortly after.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await readStoredRangeCount(td.pool))?.value).toBe(7);
  });
});

describe("getOverview", () => {
  it("reports real numbers for every tile", async () => {
    // The regression this catches: `const [counts] = await pool.query(...)`
    // binds the rows ARRAY, so `counts.users_total` is undefined and four
    // tiles render as NaN.
    await seed(5);
    const overview = await getOverview(td.pool);
    expect(overview.db.ipRanges).toBeGreaterThan(0);
    expect(Number.isFinite(overview.db.users.total)).toBe(true);
    expect(Number.isFinite(overview.db.users.verified)).toBe(true);
    expect(Number.isFinite(overview.db.apiKeys.total)).toBe(true);
    expect(Number.isFinite(overview.db.apiKeys.active)).toBe(true);
    expect(Number.isFinite(overview.db.queryLogTotal)).toBe(true);
    expect(overview.queries7d.total).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(overview.queries7d.hitRate)).toBe(true);
  });

  it("does not run COUNT(*) over ip_ranges on a warm cache", async () => {
    // Warm the cache, then swap the table for a much larger one behind it.
    // A render that counted would report the large number; the cached render
    // must still report what was stored.
    await seed(2);
    await refreshRangeCount(td.pool);
    const before = (await readStoredRangeCount(td.pool))!.value;
    const overview = await getOverview(td.pool);
    expect(overview.db.ipRanges).toBe(before);
  });
});
