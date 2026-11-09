// SPDX-License-Identifier: MIT
//
// Provider-fan-out mutex + random_probe_log retention.
//
// The mutex guards the shared free-tier quota of the external IP-geo
// providers: the backfill route, the manual-generate button and the
// continuous runner all fan out to the same providers, and none of them
// knows about the others. The retention sweep keeps the per-IP probe
// audit trail from growing without bound.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { createProviderLock } from "../../src/etl/providerLock";
import { insertOrIncrement } from "../../src/storage/unknownIpQueue";
import { runBackfill } from "../../src/etl/unknownIpBackfill";
import { runRandomGeneration } from "../../src/etl/randomIpGenerator";
import { purgeOldProbes, loadRetentionDays, DEFAULT_RETENTION_DAYS } from "../../src/storage/randomProbeLog";
import { setSetting } from "../../src/storage/settings";
import type { IpGeoProvider, IpGeoRecord, IpGeoLookupResult } from "../../src/etl/providers/types";
import { parseIp } from "../../src/ip";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("providerLock");
});
afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE unknown_ip_queue");
  await td.pool.query("TRUNCATE TABLE ip_ranges");
  await td.pool.query("TRUNCATE TABLE random_probe_log");
  await td.pool.query("DELETE FROM settings WHERE k = 'random_probe_retention_days'");
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

/** A provider that records how many lookups it served, so we can prove
 *  the skipped run made zero provider calls. */
class CountingProvider implements IpGeoProvider {
  readonly name: string;
  calls = 0;
  private readonly country: string;
  constructor(country: string, name = "stub") {
    this.country = country;
    this.name = name;
  }
  async lookup(_ip: string): Promise<IpGeoLookupResult> {
    this.calls += 1;
    return { record: rec({ countryCode: this.country }), rateLimited: false };
  }
}

// ─── The mutex itself ────────────────────────────────────────────────

describe("provider fan-out lock", () => {
  it("grants the lock to the first caller and refuses the second", () => {
    const lock = createProviderLock();
    expect(lock.isLocked()).toBe(false);
    expect(lock.tryAcquire().acquired).toBe(true);
    expect(lock.isLocked()).toBe(true);
    const second = lock.tryAcquire();
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe("busy");
  });

  it("release() frees the lock for the next caller", () => {
    const lock = createProviderLock();
    lock.tryAcquire();
    lock.release();
    expect(lock.isLocked()).toBe(false);
    expect(lock.tryAcquire().acquired).toBe(true);
  });

  it("release() on a free lock is a no-op", () => {
    const lock = createProviderLock();
    lock.release();
    expect(lock.isLocked()).toBe(false);
    expect(lock.tryAcquire().acquired).toBe(true);
  });

  it("reports how long the lock has been held", () => {
    const lock = createProviderLock();
    expect(lock.heldForMs()).toBe(0);
    lock.tryAcquire();
    expect(lock.heldForMs()).toBeGreaterThanOrEqual(0);
    lock.release();
    expect(lock.heldForMs()).toBe(0);
  });
});

// ─── Lock integration: backfill ──────────────────────────────────────

describe("runBackfill respects the provider lock", () => {
  it("skips the run and makes no provider calls when the lock is held", async () => {
    const ip = "203.0.113.10";
    await insertOrIncrement(td.pool, parseIp(ip)!, ip);

    const lock = createProviderLock();
    lock.tryAcquire(); // simulate a concurrent ingest path

    const providers = [
      new CountingProvider("US", "a"),
      new CountingProvider("US", "b"),
      new CountingProvider("US", "c"),
    ];

    const summary = await runBackfill(td.pool, providers, { batchLimit: 50, lock });

    expect(summary.skippedLockBusy).toBe(true);
    expect(summary.merged).toBe(0);
    expect(summary.considered).toBe(0);
    // The whole point: no external API was called.
    for (const p of providers) expect(p.calls).toBe(0);
    // No writes either.
    const [ranges] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(ranges.length).toBe(0);
  });

  it("runs normally once the lock is free", async () => {
    const ip = "203.0.113.11";
    await insertOrIncrement(td.pool, parseIp(ip)!, ip);

    const lock = createProviderLock();
    const providers = [
      new CountingProvider("US", "a"),
      new CountingProvider("US", "b"),
      new CountingProvider("US", "c"),
    ];

    const summary = await runBackfill(td.pool, providers, { batchLimit: 50, lock });
    expect(summary.skippedLockBusy).toBeUndefined();
    expect(summary.merged).toBe(1);
    for (const p of providers) expect(p.calls).toBe(1);
  });

  it("releases the lock after a run so the next run is not blocked", async () => {
    const ip = "203.0.113.12";
    await insertOrIncrement(td.pool, parseIp(ip)!, ip);

    const lock = createProviderLock();
    const providers = [new CountingProvider("US", "a")];
    await runBackfill(td.pool, providers, { batchLimit: 50, lock });
    expect(lock.isLocked()).toBe(false);
  });

  it("releases the lock even when the run throws", async () => {
    const lock = createProviderLock();
    const exploding = {
      name: "boom",
      async lookup(): Promise<IpGeoLookupResult> {
        throw new Error("provider exploded");
      },
    } as unknown as IpGeoProvider;

    // A provider that throws must not wedge the lock for every later run.
    await runBackfill(td.pool, [exploding], { batchLimit: 50, lock }).catch(() => {
      /* the backfill catches provider errors internally; if it throws, we
         still assert the lock was released below */
    });
    expect(lock.isLocked()).toBe(false);
  });
});

// ─── Lock integration: random generation ─────────────────────────────

describe("runRandomGeneration respects the provider lock", () => {
  it("skips the run and makes no provider calls when the lock is held", async () => {
    const lock = createProviderLock();
    lock.tryAcquire();

    const providers = [new CountingProvider("US", "a")];
    const summary = await runRandomGeneration(td.pool, providers, { count: 3, lock });

    expect(summary.skippedLockBusy).toBe(true);
    expect(summary.merged).toBe(0);
    expect(summary.generatedIps).toEqual([]);
    for (const p of providers) expect(p.calls).toBe(0);
  });

  it("runs normally once the lock is free", async () => {
    const lock = createProviderLock();
    const providers = [new CountingProvider("US", "a")];
    const summary = await runRandomGeneration(td.pool, providers, { count: 2, lock });
    expect(summary.skippedLockBusy).toBeUndefined();
    expect(summary.considered).toBe(2);
    expect(providers[0].calls).toBe(2);
  });

  it("releases the lock after a run", async () => {
    const lock = createProviderLock();
    await runRandomGeneration(td.pool, [new CountingProvider("US", "a")], { count: 1, lock });
    expect(lock.isLocked()).toBe(false);
  });
});

// ─── Retention ───────────────────────────────────────────────────────

describe("random_probe_log retention", () => {
  it("defaults to 30 days when the setting is absent", async () => {
    expect(await loadRetentionDays(td.pool)).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });

  it("reads the configured retention window", async () => {
    await setSetting(td.pool, "random_probe_retention_days", "7");
    expect(await loadRetentionDays(td.pool)).toBe(7);
  });

  it("falls back to the default for a malformed value", async () => {
    await setSetting(td.pool, "random_probe_retention_days", "not-a-number");
    expect(await loadRetentionDays(td.pool)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("keeps everything when retention is 0 (disabled)", async () => {
    await setSetting(td.pool, "random_probe_retention_days", "0");
    expect(await loadRetentionDays(td.pool)).toBe(0);
  });

  it("deletes rows older than the window and keeps the rest", async () => {
    const ip = "203.0.113.20";
    const buf = parseIp(ip)!;
    // One row 40 days old, one row from today.
    await td.pool.query(
      `INSERT INTO random_probe_log
         (ip_text, ip_binary, mode, outcome, consensus_country, consensus_city,
          consensus_asn, merged_run_id, providers_json, batch_id, ts)
       VALUES (?, ?, 'auto', 'merged', 'US', 'X', 1, NULL, '[]', 'b1',
               FROM_UNIXTIME(? / 1000))`,
      [ip, buf, Date.now() - 40 * 24 * 60 * 60 * 1000],
    );
    await td.pool.query(
      `INSERT INTO random_probe_log
         (ip_text, ip_binary, mode, outcome, consensus_country, consensus_city,
          consensus_asn, merged_run_id, providers_json, batch_id, ts)
       VALUES (?, ?, 'auto', 'merged', 'US', 'X', 1, NULL, '[]', 'b2',
               FROM_UNIXTIME(? / 1000))`,
      [ip, buf, Date.now() - 1 * 24 * 60 * 60 * 1000],
    );

    const purged = await purgeOldProbes(td.pool, 30);
    expect(purged).toBe(1);

    const [rows] = await td.pool.query<{ batch_id: string }[]>(`SELECT batch_id FROM random_probe_log`);
    expect(rows.length).toBe(1);
    expect(rows[0].batch_id).toBe("b2");
  });

  it("is a no-op when retention is 0", async () => {
    const ip = "203.0.113.21";
    await td.pool.query(
      `INSERT INTO random_probe_log
         (ip_text, ip_binary, mode, outcome, consensus_country, consensus_city,
          consensus_asn, merged_run_id, providers_json, batch_id, ts)
       VALUES (?, ?, 'auto', 'merged', 'US', 'X', 1, NULL, '[]', 'b1',
               FROM_UNIXTIME(? / 1000))`,
      [ip, parseIp(ip)!, Date.now() - 400 * 24 * 60 * 60 * 1000],
    );
    expect(await purgeOldProbes(td.pool, 0)).toBe(0);
    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM random_probe_log`);
    expect(rows.length).toBe(1);
  });
});
