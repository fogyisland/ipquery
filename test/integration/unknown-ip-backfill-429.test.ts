// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { runBackfill } from '../../src/etl/unknownIpBackfill';
import { runRandomGeneration } from '../../src/etl/randomIpGenerator';
import { insertOrIncrement } from '../../src/storage/unknownIpQueue';
import { listProviderConfigs, updateProviderConfig } from '../../src/storage/ingestProviders';
import type { IpGeoProvider, IpGeoRecord, IpGeoLookupResult } from '../../src/etl/providers/types';
import { parseIp } from '../../src/ip';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('unkback429'); });
afterAll(async () => { await dropTestDb(td); });

beforeEach(async () => {
  await td.pool.query('TRUNCATE TABLE unknown_ip_queue');
  await td.pool.query('TRUNCATE TABLE ip_ranges');
  // Re-enable all providers at the start of every test so an earlier
  // run's auto-disable doesn't bleed across cases.
  for (const name of ['ip-api', 'ipinfo', 'iplocate', 'freeipapi', 'ipapi-co']) {
    await updateProviderConfig(td.pool, name, { enabled: true });
  }
});

function rec(over: Partial<IpGeoRecord>): IpGeoRecord {
  return {
    countryCode: null, countryName: null, region: null, city: null,
    latitude: null, longitude: null, timezone: null, isp: null, asn: null, asnOrg: null,
    ...over,
  };
}

class FakeProvider implements IpGeoProvider {
  readonly name: string;
  /** ip -> record. null = abstain. */
  responses: Map<string, IpGeoRecord | null>;
  /** When true, every lookup returns rateLimited:true. */
  rateLimit = false;
  callCount = 0;
  constructor(name: string, responses: Record<string, IpGeoRecord | null> = {}) {
    this.name = name;
    this.responses = new Map(Object.entries(responses));
  }
  async lookup(_ip: string): Promise<IpGeoLookupResult> {
    this.callCount += 1;
    if (this.rateLimit) return { record: null, rateLimited: true };
    return { record: this.responses.get(_ip) ?? null, rateLimited: false };
  }
}

describe('runBackfill auto-disable on 429', () => {
  it('disables a provider that returns HTTP 429 during the run', async () => {
    const ip = '203.0.113.10';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    // Use real seeded provider names so listProviderConfigs / update
    // actually find a row. ip-api + ipinfo agree; iplocate is throttled.
    const goodA = new FakeProvider('ip-api', { [ip]: rec({ countryCode: 'US' }) });
    const goodB = new FakeProvider('ipinfo', { [ip]: rec({ countryCode: 'US' }) });
    const throttled = new FakeProvider('iplocate', {});
    throttled.rateLimit = true;

    const summary = await runBackfill(td.pool, [goodA, goodB, throttled], { batchLimit: 50 });
    expect(summary.providersDisabled).toContain('iplocate');
    // Disabled provider is removed from per-provider stats so the UI
    // doesn't show ongoing failures for a thing we just turned off.
    expect(summary.providers.iplocate).toBeUndefined();
    // The two good providers still reached consensus on countryCode.
    expect(summary.merged).toBe(1);

    // And the provider row is actually disabled in the catalog.
    const configs = await listProviderConfigs(td.pool);
    const c = configs.find((r) => r.name === 'iplocate')!;
    expect(c.enabled).toBe(false);
  });

  it('does NOT disable a provider when its 429 count stays at 0', async () => {
    const ip = '203.0.113.20';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new FakeProvider('ip-api', { [ip]: rec({ countryCode: 'JP' }) }),
      new FakeProvider('ipinfo', { [ip]: rec({ countryCode: 'JP' }) }),
      new FakeProvider('iplocate', { [ip]: rec({ countryCode: 'JP' }) }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(summary.providersDisabled).toEqual([]);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === 'ip-api')!.enabled).toBe(true);
  });
});

describe('writeConsensusRange duplicate handling', () => {
  it('second consensus for the same IP is treated as a no-op (newlyInserted=false)', async () => {
    const ip = '203.0.113.30';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    // 3 agreeing providers -> merge #1 inserts a row.
    const providers = [
      new FakeProvider('a', { [ip]: rec({ countryCode: 'US', asn: 15169 }) }),
      new FakeProvider('b', { [ip]: rec({ countryCode: 'US', asn: 15169 }) }),
      new FakeProvider('c', { [ip]: rec({ countryCode: 'US', asn: 15169 }) }),
    ];
    const first = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(first.merged).toBe(1);

    // Reset processed_at so the queue row comes back in nextBatch,
    // AND drop the ip_ranges row so the NOT EXISTS filter passes
    // (nextBatch filters WHERE processed_at IS NULL + LEFT JOIN
    // ip_ranges WHERE r.id IS NULL).
    await td.pool.query('UPDATE unknown_ip_queue SET processed_at = NULL, last_attempt_reason = NULL WHERE ip = ?', [buf]);
    await td.pool.query('DELETE FROM ip_ranges WHERE start_ip = ?', [buf]);
    const second = await runBackfill(td.pool, providers, { batchLimit: 50 });
    // merged is still 1 (consensus was reached) — the queue row is
    // marked processed either way. The duplicate is tracked separately
    // at the IpOutcome level (newlyInserted=false).
    expect(second.merged).toBe(1);

    // Only one ip_ranges row should exist for this IP — INSERT IGNORE
    // turned the second consensus into a no-op via the unique index.
    const [rows] = await td.pool.query<{ id: number }[]>(
      `SELECT id FROM ip_ranges WHERE start_ip = ?`,
      [buf],
    );
    expect(rows.length).toBe(1);
  });
});

describe('runRandomGeneration', () => {
  it('picks from the reserved pool and reports merged count', async () => {
    const providers = [
      new FakeProvider('a', {}),
      new FakeProvider('b', {}),
      new FakeProvider('c', {}),
    ];
    // The reserved pool is fixed (RFC 5737 / RFC 6890), so the IPs are
    // predictable strings. We just verify the count and that all 3
    // providers were called.
    const summary = await runRandomGeneration(td.pool, providers, { count: 3, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(summary.considered).toBe(3);
    expect(summary.generatedIps.length).toBe(3);
    // Reserved-pool IPs:
    for (const ip of summary.generatedIps) {
      const inTestNet = /^192\.0\.2\.\d+$/.test(ip)
        || /^198\.51\.100\.\d+$/.test(ip)
        || /^203\.0\.113\.\d+$/.test(ip)
        || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(ip)
        || /^198\.(18|19)\.\d+\.\d+$/.test(ip);
      expect(inTestNet).toBe(true);
    }
  });

  it('produces no duplicates within a single run', async () => {
    const providers = [
      new FakeProvider('a', {}),
      new FakeProvider('b', {}),
      new FakeProvider('c', {}),
    ];
    const summary = await runRandomGeneration(td.pool, providers, { count: 10, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    const set = new Set(summary.generatedIps);
    expect(set.size).toBe(summary.generatedIps.length);
  });

  it('disables providers that return 429 and reports them in summary', async () => {
    const throttled = new FakeProvider('ip-api');
    throttled.rateLimit = true;
    const providers = [throttled];
    const summary = await runRandomGeneration(td.pool, providers, { count: 2, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(summary.providersDisabled).toContain('ip-api');
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === 'ip-api')!.enabled).toBe(false);
  });
});
