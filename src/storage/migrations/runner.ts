// SPDX-License-Identifier: MIT
import * as mysql from 'mysql2/promise';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

export async function getAppliedVersions(pool: mysql.Pool): Promise<Set<string>> {
  await pool.query(SCHEMA_MIGRATIONS_DDL);
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT version FROM schema_migrations',
  );
  return new Set(rows.map((r) => String(r.version)));
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(pool: mysql.Pool): Promise<MigrationResult> {
  const migrationsDir = path.join(__dirname);
  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

  const applied = await getAppliedVersions(pool);
  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.slice(0, 3);
    if (applied.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      await conn.commit();
      newlyApplied.push(version);
    } catch (err) {
      await conn.rollback();
      throw new Error(`migration ${version} failed: ${(err as Error).message}`);
    } finally {
      conn.release();
    }
  }
  return { applied: newlyApplied, skipped };
}

export async function migrationStatus(pool: mysql.Pool): Promise<{
  applied: string[];
  pending: string[];
}> {
  const migrationsDir = path.join(__dirname);
  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const allVersions = files.map((f) => f.slice(0, 3));
  const applied = await getAppliedVersions(pool);
  return {
    applied: allVersions.filter((v) => applied.has(v)),
    pending: allVersions.filter((v) => !applied.has(v)),
  };
}

export async function listMigrationFiles(): Promise<string[]> {
  const migrationsDir = path.join(__dirname);
  const entries = await fs.readdir(migrationsDir);
  return entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}
