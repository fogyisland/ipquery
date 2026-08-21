// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser, findUserByEmail } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { createPasswordReset } from '../../src/storage/tokens';
import { hashPassword } from '../../src/web/auth/password';
import { generateToken, hashToken } from '../../src/web/auth/tokens';
import request from 'supertest';

let td: TestDb;

async function freshApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  return buildServer(cfg);
}

// FIX (Task 16): CSRF plugin requires BOTH `csrf` and `csrf_issued` cookies
// (see src/web/plugins/csrf.ts). The brief's helper only sent `csrf`, so every
// POST returned 403. We extract both cookies and return them as a paired header.
async function getCsrfPair(app: Awaited<ReturnType<typeof buildServer>>, url: string): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get(url);
  const cookies = r.headers['set-cookie'] as string[];
  const csrfLine = cookies.find((c) => c.startsWith('csrf='))!.split(';')[0]!;
  const issuedLine = cookies.find((c) => c.startsWith('csrf_issued='))!.split(';')[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

beforeAll(async () => { td = await createTestDb('forgot'); });
afterAll(async () => { await dropTestDb(td); });

describe('forgot/reset', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    app = await freshApp();
    // FIX (Task 16): brief's beforeEach doesn't clear users/sessions between
    // tests, so createUser hits duplicate-email on 2nd test. Truncate related
    // tables.
    await app.pool.query('SET FOREIGN_KEY_CHECKS = 0');
    await app.pool.query('TRUNCATE TABLE sessions');
    await app.pool.query('TRUNCATE TABLE password_resets');
    await app.pool.query('TRUNCATE TABLE email_verifications');
    await app.pool.query('TRUNCATE TABLE users');
    await app.pool.query('SET FOREIGN_KEY_CHECKS = 1');
    const hash = await hashPassword('Hello123World');
    await createUser(app.pool, { email: 'forgot@x.com', passwordHash: hash, displayName: 'F' });
  });

  afterEach(async () => { await app.close(); });

  it('GET /forgot renders form', async () => {
    const r = await request(app.server).get('/forgot');
    expect(r.status).toBe(200);
    expect(r.text).toContain('找回密码');
  });

  it('POST existing email returns success view', async () => {
    const { cookie, token } = await getCsrfPair(app, '/forgot');
    const r = await request(app.server).post('/forgot').set('Cookie', cookie)
      .type('form').send({ email: 'forgot@x.com', csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain('如果该邮箱已注册');
    const [rows] = await app.pool.query<import('mysql2').RowDataPacket[]>('SELECT * FROM password_resets');
    expect((rows as unknown[]).length).toBeGreaterThan(0);
  });

  it('POST unknown email still returns success (no enumeration)', async () => {
    const { cookie, token } = await getCsrfPair(app, '/forgot');
    const r = await request(app.server).post('/forgot').set('Cookie', cookie)
      .type('form').send({ email: 'nobody@x.com', csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain('如果该邮箱已注册');
  });

  it('GET /reset?token=valid renders form', async () => {
    const u = await findUserByEmail(app.pool, 'forgot@x.com');
    if (!u) throw new Error('user not found');
    const plain = generateToken();
    await createPasswordReset(app.pool, u.id, hashToken(plain), new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/reset?token=' + plain);
    expect(r.status).toBe(200);
    expect(r.text).toContain('重置密码');
  });

  it('POST /reset with valid token updates password + destroys sessions', async () => {
    const u = await findUserByEmail(app.pool, 'forgot@x.com');
    if (!u) throw new Error('user not found');
    const plain = generateToken();
    await createPasswordReset(app.pool, u.id, hashToken(plain), new Date(Date.now() + 3600_000));
    // create a session to verify destruction
    const oldSid = generateToken(16);
    await createSession(app.pool, oldSid, u.id, new Date(Date.now() + 3600_000));

    const { cookie, token } = await getCsrfPair(app, '/reset');
    const r = await request(app.server).post('/reset').set('Cookie', cookie)
      .type('form').send({ token: plain, password: 'NewPassword1', passwordConfirm: 'NewPassword1', csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/login/);
    // session should be destroyed
    const [sess] = await app.pool.query<import('mysql2').RowDataPacket[]>('SELECT * FROM sessions WHERE id = ?', [oldSid]);
    expect((sess as unknown[]).length).toBe(0);
  });

  it('POST /reset with expired token returns 410', async () => {
    const u = await findUserByEmail(app.pool, 'forgot@x.com');
    if (!u) throw new Error('user not found');
    const plain = generateToken();
    await createPasswordReset(app.pool, u.id, hashToken(plain), new Date(Date.now() - 1000));
    const { cookie, token } = await getCsrfPair(app, '/reset');
    const r = await request(app.server).post('/reset').set('Cookie', cookie)
      .type('form').send({ token: plain, password: 'NewPassword1', passwordConfirm: 'NewPassword1', csrf: token });
    expect(r.status).toBe(410);
  });
});
