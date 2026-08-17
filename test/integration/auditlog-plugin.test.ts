import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';

let td: TestDb; let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb('auditlog-plugin');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg, {
    extraRoutes: async (a) => {
      a.get('/_test/audit', async (req, reply) => {
        req.auditAction = { action: 'test.ping', targetType: 'x', targetId: 1 };
        return reply.send({ ok: true });
      });
      a.get('/_test/audit-err', async (req, reply) => {
        req.auditAction = { action: 'test.should-not-log' };
        return reply.code(500).send({ err: true });
      });
      a.get('/_test/no-audit', async (_req, reply) => reply.send({ ok: true }));
    },
  });
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('auditLog plugin', () => {
  it('writes an audit entry when handler sets req.auditAction', async () => {
    await request(app.server).get('/_test/audit');
    // Allow async hook to flush (best-effort)
    await new Promise((r) => setTimeout(r, 200));
    const [rows] = await td.pool.query('SELECT * FROM admin_audit_log');
    const found = (rows as { action: string }[]).find((r) => r.action === 'test.ping');
    expect(found).toBeDefined();
  });

  it('does NOT write when response >= 400', async () => {
    await request(app.server).get('/_test/audit-err');
    await new Promise((r) => setTimeout(r, 200));
    const [rows] = await td.pool.query("SELECT * FROM admin_audit_log WHERE action = 'test.should-not-log'");
    expect((rows as unknown[]).length).toBe(0);
  });

  it('does NOT write when req.auditAction not set', async () => {
    const before = await td.pool.query('SELECT COUNT(*) AS c FROM admin_audit_log');
    const beforeN = Number((before[0] as { c: number }[])[0].c);
    await request(app.server).get('/_test/no-audit');
    await new Promise((r) => setTimeout(r, 200));
    const after = await td.pool.query('SELECT COUNT(*) AS c FROM admin_audit_log');
    const afterN = Number((after[0] as { c: number }[])[0].c);
    expect(afterN).toBe(beforeN);
  });
});

