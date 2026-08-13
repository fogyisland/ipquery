// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { buildServer } from '../../src/api/server';
import { loadConfig } from '../../src/config';
import { createPool, runMigrations, recordEtlStart, recordEtlFinish } from '../../src/storage/mysql';

const TEST_DB = 'ipquery_stats_test';
let cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  const pool = createPool(cfg);
  await runMigrations(pool);
  const id = await recordEtlStart(pool);
  await recordEtlFinish(pool, id, 'success', { mergedRecords: 42 });
  await pool.end();
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  const root = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe('stats route', () => {
  it('returns last run summary', async () => {
    const res = await request(app.server).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.lastRun.status).toBe('success');
    expect(res.body.lastRun.mergedRecords).toBe(42);
  });
});