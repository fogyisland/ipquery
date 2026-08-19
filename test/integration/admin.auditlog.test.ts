// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import { recordAuditLog } from '../../src/storage/auditLog';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb('admin-auditlog');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, { email: 'admin@x.com', passwordHash: 'h', displayName: 'A', role: 'admin' });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));

  // Seed 3+ entries with different actions to make the filter test deterministic.
  await recordAuditLog(app.pool, {
    actor: { id: admin.id, email: admin.email },
    action: 'user.delete', targetType: 'user', targetId: 1,
    ip: '127.0.0.1', statusCode: 200,
  });
  await recordAuditLog(app.pool, {
    actor: { id: admin.id, email: admin.email },
    action: 'user.reset_password', targetType: 'user', targetId: 2,
    ip: '127.0.0.2', statusCode: 200,
  });
  await recordAuditLog(app.pool, {
    actor: { id: admin.id, email: admin.email },
    action: 'etl.trigger', targetType: 'etl_run', targetId: 5,
    ip: '127.0.0.3', statusCode: 302,
  });
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('admin audit-log page', () => {
  it('lists seeded entries', async () => {
    const r = await request(app.server).get('/admin/audit-log').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    const bodyStart = r.text.indexOf('<tbody');
    const bodyEnd = r.text.indexOf('</tbody>');
    const tbody = r.text.slice(bodyStart, bodyEnd);
    // At least one row should be in tbody (seeded entries appear).
    expect(tbody).toMatch(/user\.delete/);
    expect(tbody).toMatch(/user\.reset_password/);
    expect(tbody).toMatch(/etl\.trigger/);
  });

  it('filters by action', async () => {
    const r = await request(app.server).get('/admin/audit-log?action=user.delete').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    const bodyStart = r.text.indexOf('<tbody');
    const bodyEnd = r.text.indexOf('</tbody>');
    const tbody = r.text.slice(bodyStart, bodyEnd);
    // Only user.delete should be present; the other two actions must not appear.
    expect(tbody).toMatch(/user\.delete/);
    expect(tbody).not.toMatch(/user\.reset_password/);
    expect(tbody).not.toMatch(/etl\.trigger/);
  });

  it('CSV export', async () => {
    const r = await request(app.server).get('/admin/audit-log.csv').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    // BOM byte
    expect(r.text.charCodeAt(0)).toBe(0xFEFF);
    // Header columns from the brief: id, created_at, actor_email, action, target_type, target_id, ip
    expect(r.text).toMatch(/created_at/);
    expect(r.text).toMatch(/actor_email/);
  });
});
