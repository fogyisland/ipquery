// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { verifyCsrfRequest } from '../../src/web/plugins/csrf';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb('csrf');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });
beforeEach(() => { app.resetLoginLimit(); });

describe('CSRF', () => {
  it('GET sets csrf cookie', async () => {
    const r = await request(app.server).get('/healthz');
    const setCookie = r.headers['set-cookie'] as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith('csrf='))).toBe(true);
  });

  it('rejects POST with mismatched csrf', async () => {
    const getR = await request(app.server).get('/login');
    const csrfCookie = (getR.headers['set-cookie'] as string[]).find((c) => c.startsWith('csrf='))!.split(';')[0]!;
    const r = await request(app.server).post('/login')
      .set('Cookie', csrfCookie)
      .type('form').send({ email: 'a@b.c', password: 'whatever', csrf: 'wrong-token-value' });
    expect(r.status).toBe(403);
  });
});
