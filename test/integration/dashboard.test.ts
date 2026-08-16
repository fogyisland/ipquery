// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { insertQueryLogs } from '../../src/storage/queryLog';
import { parseIp } from '../../src/ip';
import { generateToken } from '../../src/web/auth/tokens';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb('dashboard');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  // server.ts already registers dashboardRoutes as part of the production
  // route set, so we just build the server and get a fully-wired app.
  app = await buildServer(cfg);
  const u = await createUser(app.pool, { email: 'd@x.com', passwordHash: 'h', displayName: 'D' });
  userId = u.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, userId, new Date(Date.now() + 3600_000));
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('dashboard', () => {
  it('GET /dashboard shows counts', async () => {
    await insertQueryLogs(app.pool, [
      { ip: parseIp('8.8.8.8')!, ipText: '8.8.8.8', status: 'hit', userId, apiKeyId: null, sessionId: sid, remoteAddr: null, userAgent: null },
      { ip: parseIp('1.1.1.1')!, ipText: '1.1.1.1', status: 'miss', userId, apiKeyId: null, sessionId: sid, remoteAddr: null, userAgent: null },
    ]);
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain('命中');
  });

  it('GET /dashboard/history shows own records only', async () => {
    const otherUid = (await createUser(app.pool, { email: 'o@x.com', passwordHash: 'h', displayName: 'O' })).id;
    const otherSid = generateToken(16);
    await createSession(app.pool, otherSid, otherUid, new Date(Date.now() + 3600_000));
    await insertQueryLogs(app.pool, [
      { ip: parseIp('9.9.9.9')!, ipText: '9.9.9.9', status: 'hit', userId: otherUid, apiKeyId: null, sessionId: otherSid, remoteAddr: null, userAgent: null },
    ]);
    const r = await request(app.server).get('/dashboard/history').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('9.9.9.9');
  });

  it('GET /dashboard/history?status=hit filters', async () => {
    const r = await request(app.server).get('/dashboard/history?status=hit').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain('8.8.8.8');
    expect(r.text).not.toContain('1.1.1.1');
  });

  it('GET /dashboard without session -> redirect', async () => {
    const r = await request(app.server).get('/dashboard');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/login/);
  });
});
