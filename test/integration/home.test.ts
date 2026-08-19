// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb('home');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('home (tool-style landing)', () => {
  it('GET / returns 200 with sidebar, query form, and status cards', async () => {
    const r = await request(app.server).get('/');
    expect(r.status).toBe(200);
    // Tool-style layout shell (Task 4 + Task 14): renders the sidebar partial.
    expect(r.text).toMatch(/<aside class="sidebar">/);
    expect(r.text).toContain('/docs');
    // Quick query form: POST to /try (no JS — plain form per CSP).
    expect(r.text).toMatch(/<form[^>]*method="POST"[^>]*action="\/try"/);
    expect(r.text).toMatch(/name="ip"/);
    // CSRF token embedded in form
    expect(r.text).toMatch(/name="csrf"/);
    // Status cards: API status + 24h query volume (home.title etc come from i18n).
    expect(r.text).toMatch(/home\.status|home\.ipRanges|home\.queries24h|IP 段数|24h 查询|API 状态/);
  });
});
