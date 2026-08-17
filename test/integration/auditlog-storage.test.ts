// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { recordAuditLog, listAuditLog } from '../../src/storage/auditLog';

let td: TestDb;

beforeAll(async () => { td = await createTestDb('auditlog'); });
afterAll(async () => { await dropTestDb(td); });

describe('admin_audit_log storage', () => {
  it('records and lists entries', async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: 'admin@x' },
      action: 'user.delete',
      targetType: 'user', targetId: 42,
      metadata: { ip: '8.8.8.8' },
      ip: '1.1.1.1', userAgent: 'curl/8', statusCode: 302,
    });
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: 'admin@x' },
      action: 'user.reset_password',
      metadata: null, ip: '1.1.1.1', userAgent: 'curl/8', statusCode: 200,
    });
    const { rows, total } = await listAuditLog(td.pool, { offset: 0, limit: 10 });
    expect(total).toBe(2);
    expect(rows[0].action).toBe('user.reset_password');  // newest first
    expect(rows[1].action).toBe('user.delete');
    expect(rows[1].target_type).toBe('user');
    expect(rows[1].target_id).toBe(42);
  });

  it('filters by action', async () => {
    const { rows, total } = await listAuditLog(td.pool, { offset: 0, limit: 10, action: 'user.delete' });
    expect(total).toBe(1);
    expect(rows[0].action).toBe('user.delete');
  });
});