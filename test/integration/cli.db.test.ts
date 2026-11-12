// SPDX-License-Identifier: MIT
//
// The `ipq db` command — the headless twin of wizard step 2.
//
// The wizard and this command do the same thing: test the connection,
// write it to .env, and apply the migrations. This test covers the parts
// the wizard's own tests cannot reach — the command-line surface, and the
// rule that a connection that does not work must never reach the disk.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";

const exec = promisify(execFile);

const TSX_BIN = path.join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const CLI_SRC = path.join(__dirname, "..", "..", "src", "cli.ts");

const TEST_DB = "ipquery_cli_db_test";

// A port nothing listens on — used to prove that a connection that does
// not work is rejected before it is persisted.
const DEAD_PORT = 59321;

let scratchDir: string;
let envPath: string;

/**
 * Run `ipq db` in a scratch directory.
 *
 * The password travels through the environment, never through argv:
 * a command line lands in the shell history and in `ps` output.
 */
async function runDb(
  args: string[],
  opts?: { password?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cfg = loadConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DB_HOST: cfg.db.host,
    DB_PORT: String(cfg.db.port),
    DB_USER: cfg.db.user,
    ...(opts?.password === undefined ? {} : { DB_PASSWORD: opts.password }),
    ...(opts?.env ?? {}),
  };
  try {
    const { stdout, stderr } = await exec("node", [TSX_BIN, CLI_SRC, "db", ...args], {
      cwd: scratchDir,
      env,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
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
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-cli-db-"));
  envPath = path.join(scratchDir, ".env");
  // A .env that points at a database that does not exist — the state a
  // fresh install is in before the connection has been set.
  fs.writeFileSync(envPath, ["DB_HOST=127.0.0.1", "DB_PORT=3306", "DB_USER=old", "DB_PASSWORD=oldpw", "DB_NAME=olddb", "PORT=5001", ""].join("\n"));
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
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("ipq db", () => {
  it("refuses to persist a connection that does not work", async () => {
    // The rule: a .env that cannot connect is worse than no .env, because
    // the next boot dies on it with no way back. So the write happens only
    // after the connection has been proven.
    const before = fs.readFileSync(envPath, "utf8");

    const res = await runDb(
      ["--host", "127.0.0.1", "--port", String(DEAD_PORT), "--user", "ipquery", "--name", "ipquery", "--save"],
      { password: "whatever" },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/connection failed|refused/i);
    // Nothing was written.
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  }, 60_000);

  it("refuses a connection to a database that does not exist", async () => {
    const before = fs.readFileSync(envPath, "utf8");
    const res = await runDb(
      ["--host", loadConfig().db.host, "--port", String(loadConfig().db.port), "--user", loadConfig().db.user, "--name", "ipquery_no_such_db_xyz", "--save"],
      { password: loadConfig().db.password },
    );
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/does not exist|failed/i);
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  }, 60_000);

  it("tests the connection without writing anything when --save is absent", async () => {
    const before = fs.readFileSync(envPath, "utf8");
    const res = await runDb(
      ["--host", loadConfig().db.host, "--port", String(loadConfig().db.port), "--user", loadConfig().db.user, "--name", TEST_DB],
      { password: loadConfig().db.password },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/the connection works/);
    expect(res.stdout).toMatch(/--save was not given/);
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  }, 60_000);

  it("writes the connection to .env and applies the migrations with --save", async () => {
    const cfg = loadConfig();
    const res = await runDb(
      ["--host", cfg.db.host, "--port", String(cfg.db.port), "--user", cfg.db.user, "--name", TEST_DB, "--save"],
      { password: cfg.db.password },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/the connection works/);
    expect(res.stdout).toMatch(/connection written to/);
    expect(res.stdout).toMatch(/applied \d+ migration/);

    const written = fs.readFileSync(envPath, "utf8");
    expect(written).toContain(`DB_HOST=${cfg.db.host}`);
    expect(written).toContain(`DB_USER=${cfg.db.user}`);
    expect(written).toContain(`DB_NAME=${TEST_DB}`);
    // The values are replaced in place, not appended — dotenv takes the
    // FIRST occurrence of a key, so a second DB_HOST= line would leave the
    // effective value to a rule nobody should have to reason about.
    expect(written.match(/^DB_HOST=/gm)?.length).toBe(1);
    // Unrelated keys survive.
    expect(written).toContain("PORT=5001");
  }, 120_000);

  it("rejects a nonsense port before touching anything", async () => {
    const before = fs.readFileSync(envPath, "utf8");
    const res = await runDb(
      ["--host", "127.0.0.1", "--port", "99999", "--user", "ipquery", "--name", "ipquery", "--save"],
      { password: "x" },
    );
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/port must be/i);
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  }, 60_000);

  it("does not write .env when the database does not exist", async () => {
    // The connection is tested BEFORE anything is persisted. A
    // connection that cannot be made — here because the database does
    // not exist — must never reach the disk: a .env that cannot
    // connect is worse than no .env, because the next boot dies on it
    // with no way back.
    //
    // (The companion case — a connection that WORKS but whose schema
    // cannot be built — is covered in the unit suite, where the failing
    // DDL can be injected deterministically.)
    const cfg = loadConfig();
    const before = fs.readFileSync(envPath, "utf8");

    const res = await runDb(
      ["--host", cfg.db.host, "--port", String(cfg.db.port), "--user", cfg.db.user, "--name", "ipquery_no_such_db_xyz", "--save"],
      { password: cfg.db.password },
    );
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/could not be reached|failed|does not exist/i);
    // Nothing was written.
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  }, 120_000);

  it("leaves the .env readable only by its owner", async () => {
    // The .env holds the database password in plain text. The `mode`
    // option of writeFileSync only applies when the file is CREATED — and
    // the normal case is the opposite: the operator copied
    // `.env.example` to `.env` first, and a copy keeps the 644 of the
    // source. Without an explicit chmod the password would end up
    // world-readable on a shared machine.
    //
    // chmod is a no-op for this purpose on Windows (NTFS access control
    // is not driven by the POSIX mode bits), so the assertion is
    // POSIX-only.
    if (process.platform === "win32") return;

    // Make the file world-readable on purpose, the way a `cp` would.
    fs.chmodSync(envPath, 0o644);

    const cfg = loadConfig();
    const res = await runDb(
      ["--host", cfg.db.host, "--port", String(cfg.db.port), "--user", cfg.db.user, "--name", TEST_DB, "--save"],
      { password: cfg.db.password },
    );
    expect(res.code).toBe(0);

    const mode = fs.statSync(envPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  }, 120_000);
});
