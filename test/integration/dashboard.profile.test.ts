// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser, findUserById, getUserPasswordHash } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import { hashPassword, verifyPassword } from '../../src/web/auth/password';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb('dash-profile');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  // server.ts already registers dashboardRoutes as part of the production
  // route set, so we just build the server and get a fully-wired app.
  app = await buildServer(cfg);
  const u = await createUser(app.pool, { email: 'p@x.com', passwordHash: await hashPassword('OldPassword1'), displayName: 'P' });
  userId = u.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, userId, new Date(Date.now() + 3600_000));
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get('/dashboard/profile').set('Cookie', 'sid=' + sid);
  const cookies = r.headers['set-cookie'] as string[];
  const csrfLine = cookies.find((c) => c.startsWith('csrf='))!.split(';')[0]!;
  const issuedLine = cookies.find((c) => c.startsWith('csrf_issued='))!.split(';')[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe('profile', () => {
  it('GET renders forms', async () => {
    const r = await request(app.server).get('/dashboard/profile').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain('昵称');
  });

  it('update displayName', async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server).post('/dashboard/profile').set('Cookie', 'sid=' + sid + '; ' + cookie)
      .type('form').send({ action: 'displayName', displayName: 'NewName', csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain('资料已保存');
    expect((await findUserById(app.pool, userId))?.displayName).toBe('NewName');
  });

  it('update email', async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server).post('/dashboard/profile').set('Cookie', 'sid=' + sid + '; ' + cookie)
      .type('form').send({ action: 'email', email: 'new@x.com', csrf: token });
    expect(r.status).toBe(200);
    expect((await findUserById(app.pool, userId))?.email).toBe('new@x.com');
  });

  it('update password (correct old)', async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server).post('/dashboard/profile').set('Cookie', 'sid=' + sid + '; ' + cookie)
      .type('form').send({ action: 'password', oldPassword: 'OldPassword1', newPassword: 'NewPassword2', csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain('资料已保存');
    const u = await findUserById(app.pool, userId);
    expect(u).not.toBeNull();
    const hash = await getUserPasswordHash(app.pool, userId);
    expect(hash).not.toBeNull();
    expect(await verifyPassword(hash!, 'NewPassword2')).toBe(true);
  });

  it('update password (wrong old) → 401', async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server).post('/dashboard/profile').set('Cookie', 'sid=' + sid + '; ' + cookie)
      .type('form').send({ action: 'password', oldPassword: 'wrong-old-pass', newPassword: 'NewPassword3', csrf: token });
    expect(r.status).toBe(401);
  });
});
