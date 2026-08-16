// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as mysql from 'mysql2/promise';
import { loadConfig } from '../../src/config';

const exec = promisify(execFile);

const TSX_BIN = path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_SRC = path.join(__dirname, '..', '..', 'src', 'cli.ts');

const TEST_DB = 'ipquery_cli_admin_test';

function makeEnv(): NodeJS.ProcessEnv {
  const cfg = loadConfig();
  return {
    ...process.env,
    DB_NAME: TEST_DB,
    DB_HOST: cfg.db.host,
    DB_PORT: String(cfg.db.port),
    DB_USER: cfg.db.user,
    DB_PASSWORD: cfg.db.password,
  };
}

async function dropAndCreateDb(): Promise<void> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
}

async function runMigrations(): Promise<void> {
  await exec('node', [TSX_BIN, CLI_SRC, 'migrate'], { env: makeEnv() });
}

beforeAll(async () => {
  await dropAndCreateDb();
  await runMigrations();
});

afterAll(async () => {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

describe('ipq create-admin', () => {
  it('creates an admin user', async () => {
    const { stdout } = await exec('node', [
      TSX_BIN, CLI_SRC, 'create-admin',
      '--email', 'admin1@test.local',
      '--password', 'secure123pass',
      '--name', 'Admin One',
    ], { env: makeEnv() });
    expect(stdout).toMatch(/admin user ready: admin1@test.local \(id=\d+\)/);

    const cfg = loadConfig();
    const pool = mysql.createPool({
      host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
      database: TEST_DB, connectionLimit: 2,
    });
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT role, email_verified, display_name FROM users WHERE email = ?",
      ['admin1@test.local'],
    );
    expect(rows[0].role).toBe('admin');
    expect(rows[0].email_verified).toBe(1);
    expect(rows[0].display_name).toBe('Admin One');
    await pool.end();
  }, 60_000);

  it('promotes an existing user on second run', async () => {
    const { stdout } = await exec('node', [
      TSX_BIN, CLI_SRC, 'create-admin',
      '--email', 'admin2@test.local',
      '--password', 'another123pwd',
    ], { env: makeEnv() });
    expect(stdout).toMatch(/admin user ready: admin2@test.local/);

    const { stdout: stdout2 } = await exec('node', [
      TSX_BIN, CLI_SRC, 'create-admin',
      '--email', 'admin2@test.local',
      '--password', 'rotated456pwd',
    ], { env: makeEnv() });
    expect(stdout2).toMatch(/admin user ready: admin2@test.local/);

    const cfg = loadConfig();
    const pool = mysql.createPool({
      host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
      database: TEST_DB, connectionLimit: 2,
    });
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT role, email_verified FROM users WHERE email = ?",
      ['admin2@test.local'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe('admin');
    expect(rows[0].email_verified).toBe(1);
    await pool.end();
  }, 90_000);

  it('rejects password shorter than 10 chars', async () => {
    await expect(
      exec('node', [
        TSX_BIN, CLI_SRC, 'create-admin',
        '--email', 'short@test.local',
        '--password', 'short',
      ], { env: makeEnv() }),
    ).rejects.toThrow(/password must be at least 10/);
  }, 60_000);
});
