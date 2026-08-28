// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { insertOrIncrement, nextBatch } from '../../src/storage/unknownIpQueue';
import { runBackfill } from '../../src/etl/unknownIpBackfill';
import type { IpGeoProvider, IpGeoRecord } from '../../src/etl/providers/types';
import { parseIp } from '../../src/ip';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('unkback'); });
afterAll(async () => { await dropTestDb(td); });

// Tests insert distinct fresh IPs, but the queue + ip_ranges tables are
// shared across tests in this file. Clearing them between cases makes the
// per-test summary stats deterministic; otherwise earlier rows bleed in.
beforeEach(async () => {
  await td.pool.query('TRUNCATE TABLE unknown_ip_queue');
  await td.pool.query('TRUNCATE TABLE ip_ranges');
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
  /** ip -> response (null = abstain, like a 4xx/timeout). */
  responses: Map<string, IpGeoRecord | null>;
  callCount = 0;
  constructor(name: string, responses: Record<string, IpGeoRecord | null>) {
    this.name = name;
    this.responses = new Map(Object.entries(responses));
  }
  async lookup(ip: string): Promise<IpGeoRecord | null> {
    this.callCount += 1;
    return this.responses.get(ip) ?? null;
  }
}

describe('runBackfill (consensus)', () => {
  it('merges a single IP when all providers agree', async () => {
    const ip = '203.0.113.10';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new FakeProvider('a', { [ip]: rec({ countryCode: 'US', region: 'California', asn: 15169 }) }),
      new FakeProvider('b', { [ip]: rec({ countryCode: 'US', region: 'California', asn: 15169 }) }),
      new FakeProvider('c', { [ip]: rec({ countryCode: 'US', region: 'California', asn: 15169 }) }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(summary.merged).toBe(1);
    expect(summary.noConsensus).toBe(0);
    expect(summary.allAbstained).toBe(0);

    // ip_ranges now covers /32 for that IP.
    const [rows] = await td.pool.query<{ id: number; country_code: string; region: string; asn: number; country_source: string }[]>(
      `SELECT id, country_code, region, asn, country_source FROM ip_ranges
       WHERE start_ip <= ? AND ? < end_ip`,
      [buf, buf],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].country_code).toBe('US');
    expect(rows[0].region).toBe('California');
    expect(rows[0].asn).toBe(15169);
    expect(rows[0].country_source).toBe('multi-provider');

    // And the queue row is gone from nextBatch.
    const after = await nextBatch(td.pool, 100);
    expect(after.some((r) => r.ipText === ip)).toBe(false);
  });

  it('leaves row pending when providers 1-1-1 split on country', async () => {
    const ip = '203.0.113.20';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new FakeProvider('a', { [ip]: rec({ countryCode: 'US' }) }),
      new FakeProvider('b', { [ip]: rec({ countryCode: 'CA' }) }),
      new FakeProvider('c', { [ip]: rec({ countryCode: 'DE' }) }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(summary.merged).toBe(0);
    expect(summary.noConsensus).toBe(1);

    const after = await nextBatch(td.pool, 100);
    const row = after.find((r) => r.ipText === ip);
    expect(row).toBeDefined();
    expect(row!.lastAttemptReason).toBe('no_consensus');
  });

  it('records all_abstained when every provider returns null', async () => {
    const ip = '203.0.113.30';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new FakeProvider('a', { [ip]: null }),
      new FakeProvider('b', { [ip]: null }),
      new FakeProvider('c', { [ip]: null }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(summary.merged).toBe(0);
    expect(summary.allAbstained).toBe(1);
  });

  it('passes majority-vote when one provider abstains and two agree', async () => {
    const ip = '203.0.113.40';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new FakeProvider('a', { [ip]: rec({ countryCode: 'JP' }) }),
      new FakeProvider('b', { [ip]: rec({ countryCode: 'JP' }) }),
      new FakeProvider('c', { [ip]: null }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(summary.merged).toBe(1);
  });

  it('summary aggregates provider call stats', async () => {
    const ip = '203.0.113.50';
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new FakeProvider('a', { [ip]: rec({ countryCode: 'DE' }) }),
      new FakeProvider('b', { [ip]: rec({ countryCode: 'DE' }) }),
      new FakeProvider('c', { [ip]: null }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50 });
    expect(summary.providers.a.ok).toBe(1);
    expect(summary.providers.b.ok).toBe(1);
    expect(summary.providers.c.abstained).toBe(1);
  });
});