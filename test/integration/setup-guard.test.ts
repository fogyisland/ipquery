// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { loadConfig } from '../../src/config';
import { runMigrations } from '../../src/storage/migrations/runner';
import { buildServer } from '../../src/api/server';
import { markInitialized } from '../../src/storage/settings';

interface TestDb {
  pool: mysql.Pool;
  dbName: string;
}

let td: TestDb;
let appPre: Awaited<ReturnType<typeof buildServer>>;
let appPost: Awaited<ReturnType<typeof buildServer>>;

async function dropAndCreate(): Promise<{ pool: mysql.Pool; dbName: string }> {
  const cfg = loadConfig();
  const dbName = 'ipquery_test_setup_guard';
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.query(`CREATE DATABASE \`${dbName}\``);
  await root.end();
  const pool = mysql.createPool({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    database: dbName, connectionLimit: 2, multipleStatements: true, timezone: 'Z', dateStrings: false,
  });
  await runMigrations(pool);
  return { pool, dbName };
}

async function dropDb(dbName: string): Promise<void> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.end();
}

beforeAll(async () => {
  td = await dropAndCreate();
  const cfg = loadConfig(); cfg.db.database = td.dbName;

  // The setupGuard plugin enforces on every non-setup request when
  // `initialized_at` is missing. Test fixture: build pre-init server
  // (initialized_at NOT set yet), then mark initialized and rebuild
  // to exercise the post-init lock-out.
  appPre = await buildServer(cfg);
  await markInitialized(td.pool);
  appPost = await buildServer(cfg);
});

afterAll(async () => {
  await appPre.close();
  await appPost.close();
  await td.pool.end();
  await dropDb(td.dbName);
});

describe('setupGuard plugin', () => {
  describe('before init', () => {
    it('redirects GET / to /setup', async () => {
      const r = await request(appPre.server).get('/');
      expect(r.status).toBe(302);
      expect(r.headers['location']).toBe('/setup');
    });

    it('redirects GET /login to /setup', async () => {
      const r = await request(appPre.server).get('/login');
      expect(r.status).toBe(302);
      expect(r.headers['location']).toBe('/setup');
    });

    it('allows GET /healthz through (external probes)', async () => {
      const r = await request(appPre.server).get('/healthz');
      expect(r.status).toBe(200);
    });
  });

  describe('after init', () => {
    it('does NOT redirect GET / to /setup', async () => {
      const r = await request(appPost.server).get('/');
      expect(r.status).not.toBe(302);
    });

    it('returns 404 for GET /setup (lock-out)', async () => {
      const r = await request(appPost.server).get('/setup');
      expect(r.status).toBe(404);
    });
  });
});
