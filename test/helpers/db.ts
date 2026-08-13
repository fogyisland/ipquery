// SPDX-License-Identifier: MIT
import * as mysql from 'mysql2/promise';
import { loadConfig } from '../../src/config';
import { runMigrations } from '../../src/storage/migrations/runner';

export interface TestDb {
  pool: mysql.Pool;
  dbName: string;
}

export async function createTestDb(suffix: string): Promise<TestDb> {
  const cfg = loadConfig();
  const dbName = `ipquery_test_${suffix}`;
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

export async function dropTestDb(td: TestDb): Promise<void> {
  await td.pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${td.dbName}\``);
  await root.end();
}
