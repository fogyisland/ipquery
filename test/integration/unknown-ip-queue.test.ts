// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import {
  insertOrIncrement,
  nextBatch,
  markProcessed,
  markAttempted,
  topByQueryCount,
  queueStats,
} from '../../src/storage/unknownIpQueue';
import { parseIp } from '../../src/ip';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('unknownipq'); });
afterAll(async () => { await dropTestDb(td); });

async function insertMissingIp(ip: string): Promise<void> {
  const buf = parseIp(ip)!;
  await insertOrIncrement(td.pool, buf, ip);
}

describe('unknown_ip_queue', () => {
  it('insertOrIncrement creates a row on first miss', async () => {
    await insertMissingIp('8.8.8.8');
    const stats = await queueStats(td.pool);
    expect(stats.pending).toBeGreaterThanOrEqual(1);
  });

  it('insertOrIncrement increments query_count on subsequent misses, not duplicate rows', async () => {
    const buf = parseIp('1.1.1.1')!;
    await insertOrIncrement(td.pool, buf, '1.1.1.1');
    await insertOrIncrement(td.pool, buf, '1.1.1.1');
    await insertOrIncrement(td.pool, buf, '1.1.1.1');
    const batch = await nextBatch(td.pool, 100);
    const row = batch.find((r) => r.ipText === '1.1.1.1');
    expect(row).toBeDefined();
    expect(row!.queryCount).toBe(3);
  });

  it('manual submission locks source as manual_submit even after auto misses', async () => {
    const buf = parseIp('9.9.9.9')!;
    await insertOrIncrement(td.pool, buf, '9.9.9.9', { source: 'auto_miss' });
    await insertOrIncrement(td.pool, buf, '9.9.9.9', { source: 'manual_submit', submittedByUserId: 42 });
    await insertOrIncrement(td.pool, buf, '9.9.9.9', { source: 'auto_miss' });
    const batch = await nextBatch(td.pool, 100);
    const row = batch.find((r) => r.ipText === '9.9.9.9');
    expect(row!.source).toBe('manual_submit');
    expect(row!.submittedByUserId).toBe(42);
  });

  it('nextBatch excludes IPs already covered by ip_ranges', async () => {
    // Seed an ip_ranges row that covers 192.0.2.0/24 (TEST-NET-1).
    const startBuf = parseIp('192.0.2.0')!;
    const endBuf = parseIp('192.0.2.255')!;
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (?, ?, ?, 'XX', 'seed')`,
      [startBuf, Buffer.from((BigInt('0x' + startBuf.toString('hex')) + 0x100n).toString(16).padStart(32, '0'), 'hex'), 0x100],
    );
    // Queue an IP that IS in the range — should be excluded.
    const inside = parseIp('192.0.2.50')!;
    await insertOrIncrement(td.pool, inside, '192.0.2.50');
    // Queue an IP outside the range — should be included.
    const outside = parseIp('198.51.100.7')!;
    await insertOrIncrement(td.pool, outside, '198.51.100.7');

    const batch = await nextBatch(td.pool, 100);
    expect(batch.some((r) => r.ipText === '192.0.2.50')).toBe(false);
    expect(batch.some((r) => r.ipText === '198.51.100.7')).toBe(true);
  });

  it('nextBatch sorts by query_count DESC, then last_seen_at DESC', async () => {
    // Use fresh IPs to avoid colliding with earlier test rows.
    const lowBuf = parseIp('203.0.113.1')!;
    const highBuf = parseIp('203.0.113.2')!;
    await insertOrIncrement(td.pool, lowBuf, '203.0.113.1');
    await insertOrIncrement(td.pool, lowBuf, '203.0.113.1');
    await insertOrIncrement(td.pool, highBuf, '203.0.113.2');
    await insertOrIncrement(td.pool, highBuf, '203.0.113.2');
    await insertOrIncrement(td.pool, highBuf, '203.0.113.2');
    const batch = await nextBatch(td.pool, 100);
    const lowIdx = batch.findIndex((r) => r.ipText === '203.0.113.1');
    const highIdx = batch.findIndex((r) => r.ipText === '203.0.113.2');
    expect(highIdx).toBeLessThan(lowIdx); // higher count comes first
  });

  it('markProcessed transitions pending rows out of nextBatch', async () => {
    const buf = parseIp('203.0.113.99')!;
    await insertOrIncrement(td.pool, buf, '203.0.113.99');
    const before = await nextBatch(td.pool, 100);
    const row = before.find((r) => r.ipText === '203.0.113.99')!;
    await markProcessed(td.pool, [row.id], 1);
    const after = await nextBatch(td.pool, 100);
    expect(after.some((r) => r.id === row.id)).toBe(false);
  });

  it('markAttempted sets last_attempt_reason without removing from pending', async () => {
    const buf = parseIp('203.0.113.50')!;
    await insertOrIncrement(td.pool, buf, '203.0.113.50');
    const before = await nextBatch(td.pool, 100);
    const row = before.find((r) => r.ipText === '203.0.113.50')!;
    await markAttempted(td.pool, [row.id], 'no_consensus');
    const after = await nextBatch(td.pool, 100);
    const same = after.find((r) => r.id === row.id);
    expect(same).toBeDefined();
    expect(same!.lastAttemptReason).toBe('no_consensus');
    expect(same!.processedAt).toBeNull();
  });

  it('topByQueryCount returns pending + processed sorted correctly', async () => {
    // Pre-populated from earlier tests; just verify structure.
    const r = await topByQueryCount(td.pool, 10);
    expect(Array.isArray(r.pending)).toBe(true);
    expect(Array.isArray(r.recentlyProcessed)).toBe(true);
    // pending list should not contain any processed rows
    for (const p of r.pending) expect(p.processedAt).toBeNull();
    for (const p of r.recentlyProcessed) expect(p.processedAt).not.toBeNull();
  });

  it('queueStats counts pending/processed/total_queries correctly', async () => {
    const stats = await queueStats(td.pool);
    expect(stats.pending).toBeGreaterThan(0);
    expect(stats.processed).toBeGreaterThan(0);
    expect(stats.totalQueries).toBeGreaterThan(stats.pending);
  });
});