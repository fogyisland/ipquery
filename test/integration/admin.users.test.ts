// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser, findUserByEmail } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUid: number;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb('admin-users');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  // server.ts now registers adminRoutes as part of the production route set.
  const admin = await createUser(app.pool, { email: 'admin@x.com', passwordHash: 'h', displayName: 'A', role: 'admin' });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
  const user = await createUser(app.pool, { email: 'u@x.com', passwordHash: 'h', displayName: 'U' });
  userUid = user.id;
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + adminSid);
  const cookies = r.headers['set-cookie'] as string[];
  const csrfLine = cookies.find((c) => c.startsWith('csrf='))!.split(';')[0]!;
  const issuedLine = cookies.find((c) => c.startsWith('csrf_issued='))!.split(';')[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe('admin users', () => {
  it('GET /admin/users lists all', async () => {
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain('u@x.com');
  });

  it('non-admin -> 403', async () => {
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, userUid, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + userSid);
    expect(r.status).toBe(403);
  });

  it('disable + enable user', async () => {
    const { cookie, token } = await csrfOf();
    const r1 = await request(app.server).post('/admin/users/' + userUid + '/disable').set('Cookie', 'sid=' + adminSid + '; ' + cookie)
      .type('form').send({ csrf: token });
    expect(r1.status).toBe(302);
    expect((await findUserByEmail(app.pool, 'u@x.com'))?.isDisabled).toBe(true);

    const r2 = await request(app.server).post('/admin/users/' + userUid + '/enable').set('Cookie', 'sid=' + adminSid + '; ' + cookie)
      .type('form').send({ csrf: token });
    expect(r2.status).toBe(302);
    expect((await findUserByEmail(app.pool, 'u@x.com'))?.isDisabled).toBe(false);
  });

  it('manual verify-email', async () => {
    const { cookie, token } = await csrfOf();
    await request(app.server).post('/admin/users/' + userUid + '/verify-email').set('Cookie', 'sid=' + adminSid + '; ' + cookie)
      .type('form').send({ csrf: token });
    expect((await findUserByEmail(app.pool, 'u@x.com'))?.emailVerified).toBe(true);
  });

  it('delete user', async () => {
    const victim = await createUser(app.pool, { email: 'victim@x.com', passwordHash: 'h', displayName: 'V' });
    const { cookie, token } = await csrfOf();
    const r = await request(app.server).post('/admin/users/' + victim.id + '/delete').set('Cookie', 'sid=' + adminSid + '; ' + cookie)
      .type('form').send({ csrf: token });
    expect(r.status).toBe(302);
    expect(await findUserByEmail(app.pool, 'victim@x.com')).toBeNull();
  });
});
