// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb('marketing');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('marketing routes', () => {
  it('GET / returns 200', async () => {
    const r = await request(app.server).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('IPQuery');
  });
  it('GET /about returns 200', async () => {
    const r = await request(app.server).get('/about');
    expect(r.status).toBe(200);
    expect(r.text).toContain('IPQuery');
  });
  it('GET /docs returns 200', async () => {
    const r = await request(app.server).get('/docs');
    expect(r.status).toBe(200);
    expect(r.text).toContain('/lookup');
  });
  it('GET /pricing returns 200', async () => {
    const r = await request(app.server).get('/pricing');
    expect(r.status).toBe(200);
    expect(r.text).toContain('免费');
  });
  it('GET /status returns 200', async () => {
    const r = await request(app.server).get('/status');
    expect(r.status).toBe(200);
    expect(r.text).toContain('ETL');
  });
});
