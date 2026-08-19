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
  it('GET /docs returns 200 with tool-style sidebar and 4 API endpoint rows', async () => {
    const r = await request(app.server).get('/docs');
    expect(r.status).toBe(200);
    // Tool-style layout shell: sidebar present.
    expect(r.text).toMatch(/<aside class="sidebar">/);
    // 4 API endpoints: /lookup, /lookup/:ip, /stats, /healthz
    expect(r.text).toContain('/lookup');
    expect(r.text).toContain('/lookup/');
    expect(r.text).toContain('/stats');
    expect(r.text).toContain('/healthz');
    // At least one curl example block
    expect(r.text).toMatch(/<pre><code>curl/);
  });
});
