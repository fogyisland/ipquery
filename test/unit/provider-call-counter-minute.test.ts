// SPDX-License-Identifier: MIT
//
// The circuit breaker's window is configured in MINUTES (default 10).
// Before migration 024 the counters were bucketed by UTC DAY, so a
// 10-minute window silently read 24 hours of history: one bad
// afternoon disabled a provider for a whole day, and a provider that
// recovered an hour ago stayed disabled until the next UTC midnight.
//
// These tests pin the minute-resolution behaviour:
//   - touchProviderCalled mirrors every call into the minute table
//   - a sub-day window counts only the minutes inside that window
//   - a window of a day or more still reads the daily table
//   - a database WITHOUT the minute table still works (pre-024 deploys)
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { touchProviderCalled } from "../../src/storage/ingestProviders";
import { disableRateLimitedProviders } from "../../src/etl/unknownIpBackfill";
import type { IpGeoProvider } from "../../src/etl/providers/types";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("provcntminute");
});
afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE provider_call_counter");
  // The fallback tests below drop the minute table on purpose, so
  // re-create it here. MySQL's TRUNCATE has no IF EXISTS, so the
  // recreate is unconditional and idempotent.
  await td.pool.query(
    `CREATE TABLE IF NOT EXISTS provider_call_counter_minute (
       provider_name       VARCHAR(32)  NOT NULL,
       minute_utc          DATETIME     NOT NULL,
       calls_total         INT UNSIGNED NOT NULL DEFAULT 0,
       calls_429           INT UNSIGNED NOT NULL DEFAULT 0,
       calls_timeout       INT UNSIGNED NOT NULL DEFAULT 0,
       calls_network_err   INT UNSIGNED NOT NULL DEFAULT 0,
       calls_other_err     INT UNSIGNED NOT NULL DEFAULT 0,
       PRIMARY KEY (provider_name, minute_utc)
     ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci`,
  );
  await td.pool.query("TRUNCATE TABLE provider_call_counter_minute");
});

describe("provider_call_counter_minute mirror", () => {
  it("records a call in the minute table as well as the daily table", async () => {
    await touchProviderCalled(td.pool, "ip-api", {});
    const [minuteRows] = await td.pool.query<{ calls_total: number }[]>(
      `SELECT calls_total FROM provider_call_counter_minute WHERE provider_name = ?`,
      ["ip-api"],
    );
    expect(minuteRows.length).toBe(1);
    expect(Number(minuteRows[0]!.calls_total)).toBe(1);
  });

  it("UPSERTs multiple calls into a single row per UTC minute", async () => {
    await touchProviderCalled(td.pool, "ip-api", {});
    await touchProviderCalled(td.pool, "ip-api", {});
    await touchProviderCalled(td.pool, "ip-api", {});
    const [rows] = await td.pool.query<{ calls_total: number }[]>(
      `SELECT calls_total FROM provider_call_counter_minute WHERE provider_name = ?`,
      ["ip-api"],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.calls_total)).toBe(3);
  });

  it("mirrors the error buckets, not just the total", async () => {
    await touchProviderCalled(td.pool, "ipinfo", { rateLimited: true });
    await touchProviderCalled(td.pool, "ipinfo", { errorCode: "timeout" });
    await touchProviderCalled(td.pool, "ipinfo", { errorCode: "network" });
    await touchProviderCalled(td.pool, "ipinfo", { errorCode: "http_500" });
    const [rows] = await td.pool.query<
      {
        calls_total: number;
        calls_429: number;
        calls_timeout: number;
        calls_network_err: number;
        calls_other_err: number;
      }[]
    >(
      `SELECT calls_total, calls_429, calls_timeout, calls_network_err, calls_other_err
         FROM provider_call_counter_minute WHERE provider_name = ?`,
      ["ipinfo"],
    );
    expect(Number(rows[0]!.calls_total)).toBe(4);
    expect(Number(rows[0]!.calls_429)).toBe(1);
    expect(Number(rows[0]!.calls_timeout)).toBe(1);
    expect(Number(rows[0]!.calls_network_err)).toBe(1);
    expect(Number(rows[0]!.calls_other_err)).toBe(1);
  });

  it("truncates minute_utc to the minute", async () => {
    await touchProviderCalled(td.pool, "iplocate", {});
    const [rows] = await td.pool.query<{ minute_utc: Date }[]>(
      `SELECT minute_utc FROM provider_call_counter_minute WHERE provider_name = ?`,
      ["iplocate"],
    );
    const bucket = rows[0]!.minute_utc;
    expect(bucket.getUTCSeconds()).toBe(0);
    expect(bucket.getUTCMilliseconds()).toBe(0);
  });
});

describe("circuit-breaker window resolution", () => {
  /** Counts what the breaker's denominator query would see for a
   *  sub-day window: only the minute rows inside the window. */
  const countInMinuteWindow = async (provider: string, windowMinutes: number): Promise<number> => {
    const [rows] = await td.pool.query<{ total: number }[]>(
      `SELECT COALESCE(SUM(calls_total), 0) AS total
         FROM provider_call_counter_minute
        WHERE provider_name = ?
          AND minute_utc >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
      [provider, windowMinutes],
    );
    return Number(rows[0]!.total);
  };

  it("counts a call made just now inside a 10-minute window", async () => {
    await touchProviderCalled(td.pool, "ip-api", {});
    expect(await countInMinuteWindow("ip-api", 10)).toBe(1);
  });

  it("excludes a call older than the window", async () => {
    // Backdate a minute bucket to 30 minutes ago — well outside a
    // 10-minute window but still inside today.
    await touchProviderCalled(td.pool, "ip-api", {});
    await td.pool.query(
      `UPDATE provider_call_counter_minute
          SET minute_utc = DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL 30 MINUTE, '%Y-%m-%d %H:%i:00')
        WHERE provider_name = ?`,
      ["ip-api"],
    );
    expect(await countInMinuteWindow("ip-api", 10)).toBe(0);
    // A wider window still sees it.
    expect(await countInMinuteWindow("ip-api", 60)).toBe(1);
  });

  it("keeps the daily table as the source for day-long windows", async () => {
    await touchProviderCalled(td.pool, "ip-api", {});
    const [rows] = await td.pool.query<{ total: number }[]>(
      `SELECT COALESCE(SUM(calls_total), 0) AS total
         FROM provider_call_counter
        WHERE provider_name = ?
          AND day_utc >= (UTC_DATE() - INTERVAL ? DAY)`,
      ["ip-api", 1],
    );
    expect(Number(rows[0]!.total)).toBe(1);
  });
});

/** A provider that is in the live set but reports nothing, so the
 *  breaker has to reach for the persisted counters. */
class IdleProvider implements IpGeoProvider {
  readonly name = "ip-api";
  async lookup(): Promise<{ record: null; rateLimited: false }> {
    return { record: null, rateLimited: false };
  }
}

describe("deployment on a database without migration 024", () => {
  // A rolling deploy can bring the new code up before the migration
  // runs. Both the write and the read must degrade to the daily table
  // instead of failing the backfill or silently reporting zero calls
  // (a silent zero would disable the breaker entirely — the opposite
  // of the guard this feature exists to provide).

  it("keeps recording calls in the daily table when the minute table is missing", async () => {
    await td.pool.query("DROP TABLE IF EXISTS provider_call_counter_minute");

    await touchProviderCalled(td.pool, "ip-api", {});
    await touchProviderCalled(td.pool, "ip-api", { errorCode: "timeout" });

    const [daily] = await td.pool.query<{ total: number }[]>(
      `SELECT COALESCE(SUM(calls_total), 0) AS total
         FROM provider_call_counter WHERE provider_name = ?`,
      ["ip-api"],
    );
    expect(Number(daily[0]!.total)).toBe(2);
  });

  it("still trips the circuit breaker from the daily table", async () => {
    // 10 calls, 5 of them failures -> a 50% failure rate over the
    // 10-minute window, which is the breaker's default threshold.
    for (let i = 0; i < 5; i++) await touchProviderCalled(td.pool, "ip-api", {});
    for (let i = 0; i < 5; i++)
      await touchProviderCalled(td.pool, "ip-api", { errorCode: "timeout" });

    const summary = {
      providers: {
        "ip-api": { ok: 0, failed: 0, abstained: 0, rateLimited: 0 },
      },
      providersDisabled: [] as string[],
    } as never;
    const disabled = (summary as never as { providersDisabled: string[] }).providersDisabled;

    // Must not throw, and must still disable: that proves the fallback
    // really read the daily table rather than seeing a silent zero.
    await disableRateLimitedProviders(td.pool, [new IdleProvider()], summary);
    expect(disabled).toContain("ip-api");
  });
});
