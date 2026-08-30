// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser, markEmailVerified } from '../../src/storage/users';
import { hashPassword } from '../../src/web/auth/password';
import request from 'supertest';

let td: TestDb;

async function freshApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  return buildServer(cfg);
}

// FIX (Task 15): CSRF plugin requires BOTH `csrf` and `csrf_issued` cookies
// (see src/web/plugins/csrf.ts). The brief's helper only sent `csrf`, so every
// POST returned 403. We extract both cookies and return them as a paired header.
async function getCsrfCookieAndToken(app: Awaited<ReturnType<typeof buildServer>>): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get('/login');
  const cookies = r.headers['set-cookie'] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith('csrf='))!.split(';')[0]!;
  const issuedCookie = cookies.find((c) => c.startsWith('csrf_issued='))!.split(';')[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie)!;
  return { cookie: `${csrfCookie}; ${issuedCookie}`, token: tokenMatch[1]! };
}

async function seedUser(app: Awaited<ReturnType<typeof buildServer>>, email: string, pw: string, verified = true): Promise<void> {
  const hash = await hashPassword(pw);
  const u = await createUser(app.pool, { email, passwordHash: hash, displayName: 'U' });
  if (verified) await markEmailVerified(app.pool, u.id);
}

beforeAll(async () => { td = await createTestDb('login'); });
afterAll(async () => { await dropTestDb(td); });

describe('login', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeEach(async () => {
    app = await freshApp();
    app.resetLoginLimit();
    // FIX (Task 15): brief's beforeEach doesn't clear users between tests, so
    // createUser hits duplicate-email on 2nd test. Truncate related tables.
    await app.pool.query('SET FOREIGN_KEY_CHECKS = 0');
    await app.pool.query('TRUNCATE TABLE sessions');
    await app.pool.query('TRUNCATE TABLE api_keys');
    await app.pool.query('TRUNCATE TABLE email_verifications');
    await app.pool.query('TRUNCATE TABLE users');
    await app.pool.query('SET FOREIGN_KEY_CHECKS = 1');
    await seedUser(app, 'good@x.com', 'Hello123World');
  });
  afterEach(async () => { await app.close(); });

  it('GET renders form', async () => {
    const r = await request(app.server).get('/login');
    expect(r.status).toBe(200);
    expect(r.text).toContain('登录');
  });

  it('success → cookie + redirect', async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server).post('/login').set('Cookie', cookie)
      .type('form').send({ email: 'good@x.com', password: 'Hello123World', csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard');
    expect((r.headers['set-cookie'] as string[]).some((c) => c.startsWith('sid='))).toBe(true);
  });

  it('admin login → /admin (not /dashboard)', async () => {
    // seedUser above uses role='user'; create an admin explicitly.
    const hash = await hashPassword('AdminPass1234');
    await createUser(app.pool, {
      email: 'admin@x.com', passwordHash: hash, displayName: 'Admin', role: 'admin',
    });
    await app.pool.query('UPDATE users SET email_verified = 1 WHERE email = ?', ['admin@x.com']);
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server).post('/login').set('Cookie', cookie)
      .type('form').send({ email: 'admin@x.com', password: 'AdminPass1234', csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin');
  });

  it('admin login honors ?next= override (e.g. ?next=/admin/ingest)', async () => {
    const hash = await hashPassword('AdminPass1234');
    await createUser(app.pool, {
      email: 'admin2@x.com', passwordHash: hash, displayName: 'Admin', role: 'admin',
    });
    await app.pool.query('UPDATE users SET email_verified = 1 WHERE email = ?', ['admin2@x.com']);
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server).post('/login').set('Cookie', cookie)
      .type('form').send({
        email: 'admin2@x.com', password: 'AdminPass1234', csrf: token,
        next: '/admin/ingest',
      });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin/ingest');
  });

  it('wrong password → 401', async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server).post('/login').set('Cookie', cookie)
      .type('form').send({ email: 'good@x.com', password: 'wrongpassword1', csrf: token });
    expect(r.status).toBe(401);
    expect(r.text).toContain('邮箱或密码错误');
  });

  it('unverified → /login?verify_required=1', async () => {
    await seedUser(app, 'unver@x.com', 'Hello123World', false);
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server).post('/login').set('Cookie', cookie)
      .type('form').send({ email: 'unver@x.com', password: 'Hello123World', csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/verify_required=1/);
  });

  it('5 failures locks email', async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app);
    for (let i = 0; i < 5; i++) {
      await request(app.server).post('/login').set('Cookie', cookie)
        .type('form').send({ email: 'good@x.com', password: 'wrongpassword1', csrf: token });
    }
    const r = await request(app.server).post('/login').set('Cookie', cookie)
      .type('form').send({ email: 'good@x.com', password: 'Hello123World', csrf: token });
    expect(r.status).toBe(429);
    expect(r.text).toContain('登录尝试过多');
  });
});
