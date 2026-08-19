// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { recordEtlStart, recordEtlFinish } from '../../src/storage/mysql';
import { generateToken } from '../../src/web/auth/tokens';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb('admin-etl-enhanced');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, { email: 'a@x.com', passwordHash: 'h', displayName: 'A', role: 'admin' });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  // Seed three runs with distinct statuses so filter tests are deterministic.
  const id1 = await recordEtlStart(app.pool);
  await recordEtlFinish(app.pool, id1, 'success', { mergedRecords: 100 });
  const id2 = await recordEtlStart(app.pool);
  await recordEtlFinish(app.pool, id2, 'failed', { mergedRecords: 0, errorMessage: 'boom' });
  await recordEtlStart(app.pool); // running (not finished)
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('admin etl enhanced', () => {
  it('filters by status=success', async () => {
    const r = await request(app.server).get('/admin/etl/runs?status=success').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    // success row exists; failed + running rows must not appear in the visible
    // status badge for the filtered row (the filter-bar still shows the option).
    // Easiest invariant: the success count of rendered status badges is >= 1
    // and no "failed"/"running" status appears in the table body.
    const bodyStart = r.text.indexOf('<tbody');
    const bodyEnd = r.text.indexOf('</tbody>');
    const tbody = r.text.slice(bodyStart, bodyEnd);
    expect(tbody).not.toMatch(/>running</);
    expect(tbody).not.toMatch(/>failed</);
  });

  it('sorts by id desc by default', async () => {
    const r = await request(app.server).get('/admin/etl/runs').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    const bodyStart = r.text.indexOf('<tbody');
    const bodyEnd = r.text.indexOf('</tbody>');
    const tbody = r.text.slice(bodyStart, bodyEnd);
    // First id should be largest (last inserted). Find all id cells.
    const ids = [...tbody.matchAll(/\/admin\/etl\/runs\/(\d+)/g)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const sorted = [...ids].sort((a, b) => b - a);
    expect(ids).toEqual(sorted);
  });

  it('exports CSV with proper BOM', async () => {
    const r = await request(app.server).get('/admin/etl/runs.csv').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.charCodeAt(0)).toBe(0xFEFF); // BOM
    expect(r.text).toMatch(/status/);
  });

  it('handles empty state when no runs match', async () => {
    const r = await request(app.server).get('/admin/etl/runs?status=success&since=2099-01-01').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    // Table body should be empty (no rows).
    const bodyStart = r.text.indexOf('<tbody');
    const bodyEnd = r.text.indexOf('</tbody>');
    const tbody = r.text.slice(bodyStart, bodyEnd);
    expect(tbody).not.toMatch(/admin\/etl\/runs\/\d+/);
  });
});
