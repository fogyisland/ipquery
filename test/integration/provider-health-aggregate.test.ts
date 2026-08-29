// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import {
  aggregateProviderHealthAll,
  aggregateProviderHealth,
  _resetProviderHealthCache,
  getAggregateProviderHealthAllCached,
} from '../../src/storage/providerErrorLog';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('provagg'); });
afterAll(async () => { await dropTestDb(td); });

beforeEach(async () => {
  await td.pool.query('TRUNCATE TABLE provider_call_counter');
  _resetProviderHealthCache();
});

describe('aggregateProviderHealth', () => {
  it('returns 0s for a provider with no recorded calls in the window', async () => {
    const agg = await aggregateProviderHealth(td.pool, 'ip-api', 24 * 60 * 60 * 1000);
    expect(agg.providerName).toBe('ip-api');
    expect(agg.calls).toBe(0);
    expect(agg.errors429).toBe(0);
    expect(agg.errorsOther).toBe(0);
    expect(agg.failureRatePct).toBe(0);
    expect(agg.rateLimitedRatePct).toBe(0);
    expect(agg.lastCallAt).toBeNull();
  });

  it('24h rolling window keys off last_called_at, not day_utc', async () => {
    // Two rows, both dated CURDATE()-1 / CURDATE(). The 24h aggregate
    // uses `last_called_at >= NOW(3) - INTERVAL 24 HOUR` so we set
    // yesterday's row 25h in the past and today's row "right now" — only
    // today's row should land in the rolling window.
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES
         ('ip-api', CURDATE() - INTERVAL 1 DAY, 4, 2, 0, 0, 0, NOW(3) - INTERVAL 25 HOUR),
         ('ip-api', CURDATE(), 6, 1, 0, 0, 0, NOW(3))`,
    );
    const agg = await aggregateProviderHealth(td.pool, 'ip-api', 24 * 60 * 60 * 1000);
    // 24h window uses last_called_at (precise), so only TODAY's row
    // counts — expected 6 calls / 1 = 429. Yesterday's row sits
    // outside the rolling 24h.
    expect(agg.calls).toBe(6);
    expect(agg.errors429).toBe(1);
    expect(agg.rateLimitedRatePct).toBeCloseTo(16.7, 1);
  });

  it('7d window buckets by day_utc and includes both today and yesterday', async () => {
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES ('ipinfo', CURDATE() - INTERVAL 1 DAY, 4, 2, 0, 0, 0, NOW(3) - INTERVAL 25 HOUR),
              ('ipinfo', CURDATE(), 6, 1, 0, 0, 0, NOW(3))`,
    );
    const agg = await aggregateProviderHealth(td.pool, 'ipinfo', 7 * 24 * 60 * 60 * 1000);
    // 7d window uses day_utc, so BOTH rows match (yesterday is within
    // the 7 calendar-day range).
    expect(agg.calls).toBe(10);
    expect(agg.errors429).toBe(3);
    expect(agg.lastCallAt).not.toBeNull();
  });

  it('folds timeout/network/other errors into errorsOther', async () => {
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES ('iplocate', CURDATE(), 10, 3, 2, 1, 1, NOW(3))`,
    );
    const agg = await aggregateProviderHealth(td.pool, 'iplocate', 24 * 60 * 60 * 1000);
    expect(agg.calls).toBe(10);
    expect(agg.errors429).toBe(3);
    expect(agg.errorsOther).toBe(4); // 2 + 1 + 1
    expect(agg.failureRatePct).toBe(70); // (3 + 4) / 10 = 70%
  });
});

describe('aggregateProviderHealthAll', () => {
  it('returns one row per provider in the catalog, even with no data', async () => {
    const all = await aggregateProviderHealthAll(td.pool, 24 * 60 * 60 * 1000);
    // Five seeded providers from migration 016.
    expect(all.length).toBe(5);
    expect(all.map((r) => r.providerName).sort()).toEqual(
      ['freeipapi', 'ip-api', 'ipapi-co', 'ipinfo', 'iplocate'],
    );
    for (const row of all) {
      expect(row.calls).toBe(0);
      expect(row.failureRatePct).toBe(0);
      expect(row.rateLimitedRatePct).toBe(0);
    }
  });

  it('produces counts and rates that match a seeded fixture', async () => {
    // Seed mixed traffic: ip-api gets 100 OK + 10 429; ipinfo gets 50 with
    // a few mixed failures; the rest get nothing.
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES
         ('ip-api',   CURDATE(), 110, 10, 0,  0,  0, NOW(3)),
         ('ipinfo',   CURDATE(), 50,  5,  2,  1,  2, NOW(3))`,
    );
    const all = await aggregateProviderHealthAll(td.pool, 24 * 60 * 60 * 1000);
    const ipApi = all.find((r) => r.providerName === 'ip-api')!;
    expect(ipApi.calls).toBe(110);
    expect(ipApi.errors429).toBe(10);
    expect(ipApi.failureRatePct).toBeCloseTo(9.1, 1);
    expect(ipApi.rateLimitedRatePct).toBeCloseTo(9.1, 1);

    const ipinfo = all.find((r) => r.providerName === 'ipinfo')!;
    expect(ipinfo.calls).toBe(50);
    expect(ipinfo.errors429).toBe(5);
    expect(ipinfo.errorsOther).toBe(5);
    expect(ipinfo.failureRatePct).toBe(20); // (5+5)/50
    expect(ipinfo.rateLimitedRatePct).toBe(10);
  });
});

describe('getAggregateProviderHealthAllCached', () => {
  it('serves the same array on a second call within 60s', async () => {
    // Seed something so the cache has a non-empty payload.
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES ('ip-api', CURDATE(), 7, 1, 0, 0, 0, NOW(3))`,
    );
    const first = await getAggregateProviderHealthAllCached(td.pool, 24 * 60 * 60 * 1000);
    const second = await getAggregateProviderHealthAllCached(td.pool, 24 * 60 * 60 * 1000);
    expect(second).toBe(first);
  });

  it('caches independently per windowMs', async () => {
    const day = await getAggregateProviderHealthAllCached(td.pool, 24 * 60 * 60 * 1000);
    const week = await getAggregateProviderHealthAllCached(td.pool, 7 * 24 * 60 * 60 * 1000);
    // Different windowMs → different cache keys → different arrays.
    expect(day).not.toBe(week);
  });
});
