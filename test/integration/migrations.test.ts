// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { loadConfig } from '../../src/config';
import { runMigrations, getAppliedVersions } from '../../src/storage/migrations/runner';

const TEST_DB = 'ipquery_mig_test';
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  pool = mysql.createPool({ ...cfg.db, database: TEST_DB, connectionLimit: 2, multipleStatements: true });
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe('migrations', () => {
  it('applies all 8 versions on fresh DB', async () => {
    const r = await runMigrations(pool);
    expect(r.applied.sort()).toEqual(['001','002','003','004','005','006','007','008']);
  });

  it('is idempotent on second run', async () => {
    const r = await runMigrations(pool);
    expect(r.applied).toEqual([]);
    expect(r.skipped.sort()).toEqual(['001','002','003','004','005','006','007','008']);
  });

  it('all expected tables exist', async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SHOW TABLES');
    const tables = rows.map((r) => Object.values(r)[0] as string).sort();
    expect(tables).toContain('ip_ranges');
    expect(tables).toContain('etl_runs');
    expect(tables).toContain('users');
    expect(tables).toContain('api_keys');
    expect(tables).toContain('sessions');
    expect(tables).toContain('email_verifications');
    expect(tables).toContain('password_resets');
    expect(tables).toContain('query_log');
    expect(tables).toContain('schema_migrations');
  });

  it('skips versions already marked applied', async () => {
    const before = await getAppliedVersions(pool);
    expect(before.has('003')).toBe(true);
    const r = await runMigrations(pool);
    expect(r.skipped.length).toBe(8);
  });

  it('records apply timestamps', async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT applied_at FROM schema_migrations WHERE version = ?', ['003']);
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);
  });
});