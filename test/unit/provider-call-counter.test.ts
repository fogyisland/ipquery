// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { touchProviderCalled } from "../../src/storage/ingestProviders";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("provcnt");
});
afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE provider_call_counter");
});

describe("touchProviderCalled", () => {
  it("increments calls_total by 1 per call", async () => {
    await touchProviderCalled(td.pool, "ip-api", {});
    const [rows] = await td.pool.query<{ calls_total: number }[]>(
      `SELECT calls_total FROM provider_call_counter WHERE provider_name = ?`,
      ["ip-api"],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.calls_total)).toBe(1);
  });

  it("increments calls_429 by 1 when rateLimited=true", async () => {
    await touchProviderCalled(td.pool, "ipinfo", { rateLimited: true });
    const [rows] = await td.pool.query<{ calls_429: number; calls_total: number }[]>(
      `SELECT calls_429, calls_total FROM provider_call_counter WHERE provider_name = ?`,
      ["ipinfo"],
    );
    expect(Number(rows[0]!.calls_429)).toBe(1);
    expect(Number(rows[0]!.calls_total)).toBe(1);
  });

  it("UPSERTs multiple calls into a single row per UTC day", async () => {
    await touchProviderCalled(td.pool, "iplocate", {});
    await touchProviderCalled(td.pool, "iplocate", {});
    await touchProviderCalled(td.pool, "iplocate", {});
    const [rows] = await td.pool.query<{ calls_total: number }[]>(
      `SELECT calls_total FROM provider_call_counter WHERE provider_name = ?`,
      ["iplocate"],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.calls_total)).toBe(3);
  });

  it("distinguishes timeout / network / other errorCode buckets", async () => {
    await touchProviderCalled(td.pool, "freeipapi", { errorCode: "timeout" });
    await touchProviderCalled(td.pool, "freeipapi", { errorCode: "network" });
    await touchProviderCalled(td.pool, "freeipapi", { errorCode: "http_500" });
    const [rows] = await td.pool.query<
      {
        calls_total: number;
        calls_timeout: number;
        calls_network_err: number;
        calls_other_err: number;
      }[]
    >(
      `SELECT calls_total, calls_timeout, calls_network_err, calls_other_err
         FROM provider_call_counter WHERE provider_name = ?`,
      ["freeipapi"],
    );
    expect(Number(rows[0]!.calls_total)).toBe(3);
    expect(Number(rows[0]!.calls_timeout)).toBe(1);
    expect(Number(rows[0]!.calls_network_err)).toBe(1);
    expect(Number(rows[0]!.calls_other_err)).toBe(1);
  });
});
