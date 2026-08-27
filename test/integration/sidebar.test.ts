// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUid: number;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb('sidebar');
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, { email: 'admin@x.com', passwordHash: 'h', displayName: 'Admin', role: 'admin' });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('public vs authed chrome', () => {
  // Marketing redesign: public pages (home / about / try / docs / status)
  // now render inside layouts/marketing — top nav + footer, NO sidebar.
  // The sidebar lives only on authed pages (admin / dashboard), where the
  // user needs quick navigation to all their screens.
  it('public / uses marketing chrome (no sidebar, has top nav + footer)', async () => {
    const r = await request(app.server).get('/');
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/class="m-topnav"/);
    expect(r.text).toMatch(/class="m-footer"/);
    expect(r.text).toMatch(/\/try/);
  });

  it('public /about uses marketing chrome (no sidebar)', async () => {
    const r = await request(app.server).get('/about');
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/class="m-topnav"/);
  });

  it('admin sidebar links appear once authenticated', async () => {
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/\/admin\/queries/);
    expect(r.text).toMatch(/\/admin\/audit-log/);
    expect(r.text).toContain('admin@x.com');
  });
});