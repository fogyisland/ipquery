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
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb('admin-settings');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  // Force non-empty secrets so the redacted path is exercised and so that
  // accidental leakage of raw values would be detectable in the HTML body.
  // NOTE: do not mutate cfg.db.password — it is used by createPool to connect.
  cfg.web.sessionSecret = 'super-secret-session-key-abcdefgh';
  cfg.web.csrfSecret = 'csrf-secret-key-1234567890';
  cfg.smtp.pass = 'smtp-pass-secret-ABC';
  cfg.maxmind.licenseKey = 'mm-license-key-9999';
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, { email: 'admin@x', passwordHash: 'h', displayName: 'A', role: 'admin' });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('admin settings', () => {
  it('renders without exposing raw secrets', async () => {
    const r = await request(app.server).get('/admin/settings').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    // Raw secret strings must not appear anywhere in the rendered HTML.
    expect(r.text).not.toMatch(/super-secret-session-key-abcdefgh/);
    expect(r.text).not.toMatch(/csrf-secret-key-1234567890/);
    expect(r.text).not.toMatch(/smtp-pass-secret-ABC/);
    expect(r.text).not.toMatch(/mm-license-key-9999/);
    // redactSecret outputs "••••1234" pattern (first 4 + … + last 4) when the
    // value is > 8 chars. Assert the redacted form is present for at least
    // sessionSecret so we didn't accidentally render the literal "(unset)".
    expect(r.text).toMatch(/super&#8230;|super…|…cdefgh|…efgh|cdefgh|efgh/);
  });

  it('POST /admin/settings/etl-restart works', async () => {
    // GET first so the server sets the csrf cookie on the response jar.
    const getRes = await request(app.server).get('/admin/settings').set('Cookie', 'sid=' + adminSid);
    expect(getRes.status).toBe(200);
    const csrfCookie = getRes.headers['set-cookie']?.find((c) => c.startsWith('csrf='));
    expect(csrfCookie).toBeDefined();
    const csrfValue = decodeURIComponent(csrfCookie!.split(';')[0].split('=')[1]);
    const csrfIssuedCookie = getRes.headers['set-cookie']?.find((c) => c.startsWith('csrf_issued='));
    const csrfIssued = csrfIssuedCookie ? decodeURIComponent(csrfIssuedCookie.split(';')[0].split('=')[1]) : '';
    const post = await request(app.server)
      .post('/admin/settings/etl-restart')
      .set('Cookie', `sid=${adminSid}; csrf=${csrfValue}; csrf_issued=${csrfIssued}`)
      .type('form')
      .send({ csrf: csrfValue });
    // Success: redirect to /admin/settings (302). Brief says "works" so we
    // require neither 404 nor 500; a 302 to the settings page is the happy path.
    expect(post.status).not.toBe(404);
    expect(post.status).not.toBe(500);
    expect(post.status).toBe(302);
    expect(post.headers.location).toBe('/admin/settings');
  });
});
