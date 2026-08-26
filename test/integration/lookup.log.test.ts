// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { truncateNew, insertIntoNew, atomicSwapRanges } from '../../src/storage/mysql';
import { createUser } from '../../src/storage/users';
import { createApiKey } from '../../src/storage/apiKeys';
import { createSession } from '../../src/storage/sessions';
import { generateApiKey, generateToken, hashToken } from '../../src/web/auth/tokens';
import { parseIp } from '../../src/ip';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let rawKey: string;
let sessionUserId: number;
let sid: string;
let cfg = loadConfig();

beforeAll(async () => {
  td = await createTestDb('lookup_log');
  cfg.db.database = td.dbName;
  const seedPool = td.pool;
  await truncateNew(seedPool);
  await insertIntoNew(seedPool, [{
    startIp: Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,8,8,8,0]),
    endIp:   Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,8,8,8,255]),
    countryCode: 'US', countryName: 'United States',
    countrySource: 'maxmind',
  }]);
  await atomicSwapRanges(seedPool);
  app = await buildServer(cfg);
  const u = await createUser(app.pool, { email: 'log@test', passwordHash: 'h', displayName: 'Log' });
  rawKey = generateApiKey();
  await createApiKey(app.pool, u.id, 'log-test', hashToken(rawKey), rawKey.slice(0, 8));

  // Separate user for session-auth tests so the row assertions can target
  // by user_id without colliding with the API-key user's rows.
  const sessionUser = await createUser(app.pool, { email: 'web@test', passwordHash: 'h', displayName: 'Web' });
  sessionUserId = sessionUser.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, sessionUserId, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

// Helper: force-flush the batched writer via the exposed decoration.
const flush = (): Promise<void> => app.flushQueryLog();

describe('query_log population on /lookup', () => {
  it('records a hit when key is provided', async () => {
    await request(app.server).get('/lookup').query({ ip: '8.8.8.8', key: rawKey });
    await flush();
    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE ip_text = ? AND status = 'hit' ORDER BY id DESC LIMIT 1`,
      ['8.8.8.8'],
    );
    const row = (rows as { ip_text: string; status: string; user_id: number; api_key_id: number; ip: Buffer }[])[0];
    expect(row).toBeDefined();
    expect(row.status).toBe('hit');
    expect(row.user_id).toBeGreaterThan(0);
    expect(row.api_key_id).toBeGreaterThan(0);
    expect(parseIp('8.8.8.8')!.equals(row.ip)).toBe(true);
  });

  it('records a miss when key is provided and IP not seeded', async () => {
    await request(app.server).get('/lookup').query({ ip: '1.1.1.1', key: rawKey });
    await flush();
    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE ip_text = ? AND status = 'miss' ORDER BY id DESC LIMIT 1`,
      ['1.1.1.1'],
    );
    const row = (rows as { status: string }[])[0];
    expect(row).toBeDefined();
    expect(row.status).toBe('miss');
  });

  it('does NOT log when no key is provided', async () => {
    const [beforeRows] = await td.pool.query(
      `SELECT COUNT(*) AS n FROM query_log`,
    );
    const before = Number((beforeRows as { n: number }[])[0].n);
    await request(app.server).get('/lookup').query({ ip: '8.8.8.8' });
    await flush();
    const [afterRows] = await td.pool.query(
      `SELECT COUNT(*) AS n FROM query_log`,
    );
    const after = Number((afterRows as { n: number }[])[0].n);
    expect(after).toBe(before);
  });

  it('records a hit when auth is via session cookie (web user)', async () => {
    // Pre-MVP parked follow-up #4: /lookup was silent for session-cookie
    // auth, undercounting analytics for browser-driven traffic on /try.
    const r = await request(app.server).get('/lookup').query({ ip: '8.8.8.8' }).set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(200);
    await flush();
    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE user_id = ? AND status = 'hit' ORDER BY id DESC LIMIT 1`,
      [sessionUserId],
    );
    const row = (rows as { status: string; user_id: number; api_key_id: number; session_id: string; ip: Buffer }[])[0];
    expect(row).toBeDefined();
    expect(row.status).toBe('hit');
    expect(row.user_id).toBe(sessionUserId);
    expect(row.api_key_id).toBeNull();
    expect(row.session_id).toBe(sid);
    expect(parseIp('8.8.8.8')!.equals(row.ip)).toBe(true);
  });

  it('records a miss when auth is via session cookie and IP not seeded', async () => {
    const r = await request(app.server).get('/lookup').query({ ip: '1.1.1.1' }).set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(404);
    await flush();
    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE user_id = ? AND ip_text = ? AND status = 'miss' ORDER BY id DESC LIMIT 1`,
      [sessionUserId, '1.1.1.1'],
    );
    const row = (rows as { status: string; api_key_id: number; session_id: string }[])[0];
    expect(row).toBeDefined();
    expect(row.status).toBe('miss');
    expect(row.api_key_id).toBeNull();
    expect(row.session_id).toBe(sid);
  });
});
