// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";

const exec = promisify(execFile);

const TSX_BIN = path.join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const CLI_SRC = path.join(__dirname, "..", "..", "src", "cli.ts");

const TEST_DB = "ipquery_cli_migrate_test";

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
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
}

beforeAll(async () => {
  await dropAndCreateDb();
});

afterAll(async () => {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

describe("ipq migrate", () => {
  it("applies all migrations to a fresh DB", async () => {
    await dropAndCreateDb();
    const { stdout } = await exec("node", [TSX_BIN, CLI_SRC, "migrate"], { env: makeEnv() });
    expect(stdout).toMatch(/applied 24 migration/);

    const cfg = loadConfig();
    const pool = mysql.createPool({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: TEST_DB,
      connectionLimit: 2,
    });
    const [tables] = await pool.query<mysql.RowDataPacket[]>("SHOW TABLES LIKE 'users'");
    expect(tables.length).toBe(1);
    await pool.end();
  }, 60_000);

  it("migrate:status shows applied migrations", async () => {
    const { stdout } = await exec("node", [TSX_BIN, CLI_SRC, "migrate:status"], { env: makeEnv() });
    expect(stdout).toMatch(/001_ip_ranges.*applied/);
    expect(stdout).toMatch(/008_query_log.*applied/);
  }, 60_000);

  it("re-running migrate is idempotent", async () => {
    const { stdout } = await exec("node", [TSX_BIN, CLI_SRC, "migrate"], { env: makeEnv() });
    expect(stdout).toMatch(/database already up to date/);
  }, 60_000);
});
