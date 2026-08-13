// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { insertQueryLogs, listQueryLogs, countQueriesByStatusSince } from '../../src/storage/queryLog';
import { parseIp } from '../../src/ip';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('querylog'); });
afterAll(async () => { await dropTestDb(td); });

describe('query_log', () => {
  it('insert + list round-trip', async () => {
    const buf = parseIp('8.8.8.8')!;
    await insertQueryLogs(td.pool, [{
      ip: buf, ipText: '8.8.8.8', status: 'hit',
      userId: null, apiKeyId: null, sessionId: null, remoteAddr: buf, userAgent: 'test',
    }]);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 10 });
    expect(r.total).toBe(1);
    expect(r.rows[0]?.ipText).toBe('8.8.8.8');
    expect(r.rows[0]?.status).toBe('hit');
  });

  it('listQueryLogs filter by status', async () => {
    await insertQueryLogs(td.pool, [
      { ip: parseIp('1.1.1.1')!, ipText: '1.1.1.1', status: 'invalid', userId: null, apiKeyId: null, sessionId: null, remoteAddr: null, userAgent: null },
      { ip: parseIp('2.2.2.2')!, ipText: '2.2.2.2', status: 'miss', userId: null, apiKeyId: null, sessionId: null, remoteAddr: null, userAgent: null },
    ]);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 10, status: 'invalid' });
    expect(r.rows.every((x) => x.status === 'invalid')).toBe(true);
  });

  it('countQueriesByStatusSince', async () => {
    const counts = await countQueriesByStatusSince(td.pool, new Date(Date.now() - 60_000));
    expect(counts.invalid).toBeGreaterThanOrEqual(1);
    expect(counts.miss).toBeGreaterThanOrEqual(1);
    expect(counts.hit).toBeGreaterThanOrEqual(1);
  });

  it('large batch chunks at 200', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      ip: parseIp('127.0.0.1')!, ipText: `127.0.0.${i % 256}`, status: 'miss' as const,
      userId: null, apiKeyId: null, sessionId: null, remoteAddr: null, userAgent: null,
    }));
    await insertQueryLogs(td.pool, entries);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 1000 });
    expect(r.total).toBeGreaterThanOrEqual(250);
  });
});
