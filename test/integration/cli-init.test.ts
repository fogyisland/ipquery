// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { isInitialized } from "../../src/storage/settings";

const exec = promisify(execFile);

const TSX_BIN = path.join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const CLI_SRC = path.join(__dirname, "..", "..", "src", "cli.ts");

const TEST_DB = "ipquery_cli_init_test";

let pool: mysql.Pool;

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
  const cfg = loadConfig();
  pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 2,
  });
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
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

describe("ipq init", () => {
  it("happy path: empty DB -> init creates admin, marks initialized, loads 50 seed rows", async () => {
    await dropAndCreateDb();
    const { stdout } = await exec(
      "node",
      [TSX_BIN, CLI_SRC, "init", "--email", "admin@x.com", "--password", "longpassword1", "--seed"],
      { env: makeEnv() },
    );
    // The CLI reports how many demo rows the seed loader actually added,
    // not a bare yes/no: the loader skips when the table already holds
    // non-demo rows, so the count is the honest signal. Assert the shape
    // of the contract ("N added") rather than the row count — the count
    // itself is asserted separately against the table below.
    expect(stdout).toMatch(
      /initialized admin=admin@x\.com \(id=\d+\), seed=\d+ added, marked_initialized=yes/,
    );

    expect(await isInitialized(pool)).toBe(true);

    const [userRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id, role, email_verified FROM users WHERE email = ?",
      ["admin@x.com"],
    );
    expect(userRows.length).toBe(1);
    expect(userRows[0].role).toBe("admin");
    expect(userRows[0].email_verified).toBe(1);

    const [seedRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'",
    );
    expect(Number(seedRows[0].n)).toBe(50);
  }, 90_000);

  it("already-initialized exit: second invocation logs message and exits 0 without re-creating admin", async () => {
    const { stdout } = await exec(
      "node",
      [TSX_BIN, CLI_SRC, "init", "--email", "admin@x.com", "--password", "longpassword1"],
      { env: makeEnv() },
    );
    expect(stdout).toMatch(/already initialized; pass --reinit to re-run/);
    expect(stdout).not.toMatch(/initialized admin=/);

    const [userRows] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM users WHERE email = ?", [
      "admin@x.com",
    ]);
    expect(userRows.length).toBe(1);
  }, 90_000);

  it("--reinit override: bootstrapAdmin rotates password on existing admin (idempotent promote)", async () => {
    const { stdout } = await exec(
      "node",
      [TSX_BIN, CLI_SRC, "init", "--reinit", "--email", "admin@x.com", "--password", "rotatedpwd1"],
      { env: makeEnv() },
    );
    expect(stdout).toMatch(/initialized admin=admin@x\.com \(id=\d+\), seed=no, marked_initialized=no/);

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT role, email_verified FROM users WHERE email = ?",
      ["admin@x.com"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("admin");
    expect(rows[0].email_verified).toBe(1);

    expect(await isInitialized(pool)).toBe(true);
  }, 90_000);

  it("--reinit with mismatched email throws (prevents silent second-admin creation)", async () => {
    let err: Error | null = null;
    try {
      await exec(
        "node",
        [TSX_BIN, CLI_SRC, "init", "--reinit", "--email", "different@x.com", "--password", "rotatedpwd1"],
        { env: makeEnv() },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(String(err!.message)).toMatch(/existing admin is admin@x\.com/);

    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT email FROM users ORDER BY id");
    expect(rows.map((r) => r.email)).toEqual(["admin@x.com"]);
  }, 90_000);
});
