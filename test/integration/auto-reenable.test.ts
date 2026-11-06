// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { runBackfill } from "../../src/etl/unknownIpBackfill";
import { insertOrIncrement } from "../../src/storage/unknownIpQueue";
import { listProviderConfigs, updateProviderConfig } from "../../src/storage/ingestProviders";
import { reapProviders } from "../../src/web/plugins/randomIpGeneratorRunner";
import type { IpGeoProvider, IpGeoRecord, IpGeoLookupResult } from "../../src/etl/providers/types";
import { parseIp } from "../../src/ip";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("autoreen");
});
afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE unknown_ip_queue");
  await td.pool.query("TRUNCATE TABLE ip_ranges");
  for (const name of ["ip-api", "ipinfo", "iplocate", "freeipapi", "ipapi-co"]) {
    await updateProviderConfig(td.pool, name, {
      enabled: true,
      autoReenableAt: null,
      autoDisabledReason: null,
    });
  }
});

function rec(over: Partial<IpGeoRecord>): IpGeoRecord {
  return {
    countryCode: null,
    countryName: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    asn: null,
    asnOrg: null,
    ...over,
  };
}

class FakeProvider implements IpGeoProvider {
  readonly name: string;
  /** ip -> record. null = abstain. */
  responses: Map<string, IpGeoRecord | null>;
  rateLimit = false;
  constructor(name: string, responses: Record<string, IpGeoRecord | null> = {}) {
    this.name = name;
    this.responses = new Map(Object.entries(responses));
  }
  async lookup(_ip: string): Promise<IpGeoLookupResult> {
    if (this.rateLimit) return { record: null, rateLimited: true };
    return { record: this.responses.get(_ip) ?? null, rateLimited: false };
  }
}

describe("reapProviders (circuit-breaker cooldown)", () => {
  it("sets auto_reenable_at ~N minutes in the future when a provider gets 429", async () => {
    const ip = "203.0.113.10";
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const goodA = new FakeProvider("ip-api", { [ip]: rec({ countryCode: "US" }) });
    const goodB = new FakeProvider("ipinfo", { [ip]: rec({ countryCode: "US" }) });
    const throttled = new FakeProvider("iplocate", {});
    throttled.rateLimit = true;

    const summary = await runBackfill(td.pool, [goodA, goodB, throttled], { batchLimit: 50 });
    expect(summary.providersDisabled).toContain("iplocate");

    const configs = await listProviderConfigs(td.pool);
    const ipi = configs.find((r) => r.name === "iplocate")!;
    expect(ipi.enabled).toBe(false);
    // autoReenableAt was stamped ~ cooldownMinutes ahead — should be in
    // the future, within (0, 60min] window.
    expect(ipi.autoReenableAt).not.toBeNull();
    const diffMs = (ipi.autoReenableAt as Date).getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThanOrEqual(16 * 60_000); // 15-min default + a little slack
    expect(ipi.autoDisabledReason).toMatch(/429 rate limited/);
  });

  it("re-enables a provider whose auto_reenable_at is now in the past", async () => {
    // Drive disable through the real path so all columns get written.
    // Insert an IP so runBackfill has work to do (processIp is what records
    // the rateLimited count that triggers disableRateLimitedProviders).
    const ip = "203.0.113.30";
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const throttled = new FakeProvider("ip-api");
    throttled.rateLimit = true;
    const summary = await runBackfill(td.pool, [throttled], { batchLimit: 10 });
    expect(summary.providersDisabled).toContain("ip-api");

    // Now force the cooldown to have elapsed. Direct SQL rewinds
    // auto_reenable_at 1 second into the past. We use UTC_TIMESTAMP(3)
    // here too because the reap query compares against UTC_TIMESTAMP(3)
    // (JS-supplied Date → mysql2 with timezone='Z' stores UTC; NOW(3)
    // would be the MySQL session's local time which would mismatch).
    await td.pool.query(
      `UPDATE ingest_providers SET auto_reenable_at = (UTC_TIMESTAMP(3) - INTERVAL 1 SECOND)
        WHERE name = ?`,
      ["ip-api"],
    );
    // Sanity: provider is still disabled before reap.
    let configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === "ip-api")!.enabled).toBe(false);

    const reaped = await reapProviders(td.pool);
    expect(reaped).toBe(1);

    configs = await listProviderConfigs(td.pool);
    const reconfigured = configs.find((r) => r.name === "ip-api")!;
    expect(reconfigured.enabled).toBe(true);
    expect(reconfigured.autoReenableAt).toBeNull();
  });

  it("does NOT re-enable a provider whose auto_reenable_at is in the future", async () => {
    // Manually flip to disabled with a far-future timestamp. No
    // need to go through disableRateLimitedProviders for this case —
    // we're testing the reaper's WHERE-clause filter, not the disable
    // decision logic.
    const future = new Date(Date.now() + 60 * 60_000);
    await updateProviderConfig(td.pool, "ipinfo", {
      enabled: false,
      autoReenableAt: future,
      autoDisabledReason: "manual test",
    });
    const reaped = await reapProviders(td.pool);
    expect(reaped).toBe(0);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === "ipinfo")!.enabled).toBe(false);
  });
});
