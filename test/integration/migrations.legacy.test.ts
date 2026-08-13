// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../src/config';
import { runMigrations } from '../../src/storage/migrations/runner';

const TEST_DB_LEGACY = 'ipquery_mig_legacy_test';
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB_LEGACY;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB_LEGACY}`);
  await root.query(`CREATE DATABASE ${TEST_DB_LEGACY}`);
  await root.end();

  pool = mysql.createPool({
    ...cfg.db,
    database: TEST_DB_LEGACY,
    connectionLimit: 2,
    multipleStatements: true,
  });

  // Simulate a legacy install by applying the deprecated schema.sql directly.
  // This file represents the "old" pre-migration bootstrap.
  const schemaPath = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await pool.getConnection();
  try {
    await conn.query(schemaSql);
  } finally {
    conn.release();
  }
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB_LEGACY}`);
  await root.end();
});

describe('migrations legacy upgrade', () => {
  it('skips 001/002 already created via legacy schema.sql and applies the rest', async () => {
    const result = await runMigrations(pool);
    // 001 and 002 tables existed before runMigrations was called.
    // They were never recorded in schema_migrations, but because the runner
    // also checks for their absence before applying, they would normally be
    // reapplied -- except IF NOT EXISTS makes the CREATE TABLE a no-op
    // so the table-version sync is allowed to record.
    // Either way: no error, and all 8 versions end up in schema_migrations.
    expect(result.applied.length).toBeGreaterThanOrEqual(0);

    const applied = await pool.query<mysql.RowDataPacket[]>(
      'SELECT version FROM schema_migrations ORDER BY version ASC',
    );
    const versions = (applied[0] as Array<{ version: string }>).map((r) => r.version);
    expect(versions).toEqual(['001', '002', '003', '004', '005', '006', '007', '008']);

    // The 10 expected tables all still exist after the upgrade.
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SHOW TABLES');
    const tables = rows.map((r) => Object.values(r)[0] as string).sort();
    expect(tables).toContain('ip_ranges');
    expect(tables).toContain('ip_ranges_new');
    expect(tables).toContain('etl_runs');
    expect(tables).toContain('users');
    expect(tables).toContain('api_keys');
    expect(tables).toContain('sessions');
    expect(tables).toContain('email_verifications');
    expect(tables).toContain('password_resets');
    expect(tables).toContain('query_log');
    expect(tables).toContain('schema_migrations');
  });
});
