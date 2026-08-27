// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb('docs');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('/docs API reference', () => {
  // Marketing redesign: /docs renders inside layouts/marketing (no sidebar).
  // Content is the same (4 endpoint rows + curl/JS/Python examples + auth).
  it('GET /docs returns 200 with marketing chrome and 4 API endpoint rows', async () => {
    const r = await request(app.server).get('/docs');
    expect(r.status).toBe(200);
    // Marketing chrome
    expect(r.text).not.toMatch(/<aside class="sidebar">/);
    expect(r.text).toMatch(/class="m-topnav"/);
    // 4 API endpoints: /lookup, /lookup/:ip, /stats, /healthz
    expect(r.text).toContain('/lookup?ip=');
    expect(r.text).toContain('/lookup/');
    expect(r.text).toContain('/stats');
    expect(r.text).toContain('/healthz');
    // At least one curl example block
    expect(r.text).toMatch(/data-pane="curl"/);
  });
});