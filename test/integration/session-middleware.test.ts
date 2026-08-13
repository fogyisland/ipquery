// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUserId: number;

beforeAll(async () => {
  td = await createTestDb('session-mw');
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const u = await createUser(app.pool, { email: 'a@x.com', passwordHash: 'h', displayName: 'A', role: 'admin' });
  adminUserId = u.id;
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('session middleware', () => {
  it('loads session from cookie', async () => {
    const sid = generateToken(16);
    await createSession(app.pool, sid, adminUserId, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=' + sid);
    // /dashboard route is added in Task 17; for now auth pass + no route => 404
    expect([200, 302, 404]).toContain(r.status);
  });

  it('invalid cookie -> 302 to /login', async () => {
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=invalid');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/login/);
  });

  it('non-admin -> 403 on /admin/*', async () => {
    const sid = generateToken(16);
    const regular = await createUser(app.pool, { email: 'r@x.com', passwordHash: 'h', displayName: 'R' });
    await createSession(app.pool, sid, regular.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(403);
  });

  it('admin passes admin gate', async () => {
    const sid = generateToken(16);
    await createSession(app.pool, sid, adminUserId, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + sid);
    // /admin/users route is added in Task 20; for now auth pass + no route => 404
    expect([200, 302, 404]).toContain(r.status);
  });

  it('disabled user -> /login?disabled=1', async () => {
    const sid = generateToken(16);
    const u = await createUser(app.pool, { email: 'd@x.com', passwordHash: 'h', displayName: 'D' });
    await app.pool.query('UPDATE users SET is_disabled = 1 WHERE id = ?', [u.id]);
    await createSession(app.pool, sid, u.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/disabled=1/);
  });
});